package server

import (
	"encoding/binary"
	"errors"
	"sync/atomic"
	"time"
)

// relayHeaderSize is the 4-byte big-endian session ID prefixed to every relay
// payload frame. Keeping the routing key in a fixed binary header means the
// server never parses JSON on the per-chunk hot path.
const relayHeaderSize = 4

var errNoSession = errors.New("unknown relay session")

// relaySession is one unidirectional-by-convention pipe between two peers in
// the same room, used when their WebRTC data channel could not be established.
type relaySession struct {
	id      uint32
	from    *Peer
	to      *Peer
	started time.Time
	bytes   atomic.Uint64
}

// other returns the far end of the session relative to p, or nil if p is not
// part of it.
func (s *relaySession) other(p *Peer) *Peer {
	switch p {
	case s.from:
		return s.to
	case s.to:
		return s.from
	default:
		return nil
	}
}

// openRelay allocates a session between the requesting peer and a target in the
// same room, telling both ends the session ID they should use.
func (h *Hub) openRelay(from *Peer, toID string) {
	target := h.find(from.Room, toID)
	if target == nil {
		_ = from.sendJSON(serverMessage{Type: msgError, Error: "peer not found: " + toID})
		return
	}
	if target == from {
		_ = from.sendJSON(serverMessage{Type: msgError, Error: "cannot relay to self"})
		return
	}

	h.sessMu.Lock()
	var id uint32
	for {
		h.nextSess++
		if h.nextSess == 0 {
			h.nextSess = 1
		}
		if _, taken := h.sessions[h.nextSess]; !taken {
			id = h.nextSess
			break
		}
	}
	sess := &relaySession{id: id, from: from, to: target, started: time.Now()}
	h.sessions[id] = sess
	h.sessMu.Unlock()

	h.relaySessions.Add(1)

	_ = from.sendJSON(serverMessage{Type: msgRelayReady, Session: id, ID: target.ID})
	_ = target.sendJSON(serverMessage{Type: msgRelayIncoming, Session: id, From: from.ID})
}

// routeRelayFrame forwards one payload frame to the far end, verbatim including
// its session header so the receiver can demultiplex.
func (h *Hub) routeRelayFrame(from *Peer, data []byte) error {
	if len(data) < relayHeaderSize {
		return errors.New("short relay frame")
	}
	id := binary.BigEndian.Uint32(data[:relayHeaderSize])

	h.sessMu.Lock()
	sess := h.sessions[id]
	h.sessMu.Unlock()
	if sess == nil {
		return errNoSession
	}
	target := sess.other(from)
	if target == nil {
		return errors.New("peer not part of session")
	}

	payload := uint64(len(data) - relayHeaderSize)
	sess.bytes.Add(payload)
	h.relayBytes.Add(payload)

	// send blocks when the target's queue is full, which pushes backpressure
	// back through TCP to the sender instead of buffering here.
	return target.sendBinary(data)
}

// routeRelayAck forwards the receiver's cumulative byte count to the sender,
// which uses it to keep a bounded amount of data in flight.
func (h *Hub) routeRelayAck(from *Peer, id uint32, bytes uint64) {
	h.sessMu.Lock()
	sess := h.sessions[id]
	h.sessMu.Unlock()
	if sess == nil {
		return
	}
	if target := sess.other(from); target != nil {
		_ = target.sendJSON(serverMessage{Type: msgRelayAck, Session: id, Bytes: bytes})
	}
}

// closeRelay tears down a session and notifies the far end.
func (h *Hub) closeRelay(id uint32, by *Peer) {
	h.sessMu.Lock()
	sess := h.sessions[id]
	if sess != nil {
		delete(h.sessions, id)
	}
	h.sessMu.Unlock()
	if sess == nil {
		return
	}
	if target := sess.other(by); target != nil {
		_ = target.sendJSON(serverMessage{Type: msgRelayClose, Session: id})
	}
}

// closePeerSessions drops every session involving a departing peer so the far
// end learns immediately instead of waiting on a transfer that cannot finish.
func (h *Hub) closePeerSessions(p *Peer) {
	h.sessMu.Lock()
	var orphaned []*relaySession
	for id, sess := range h.sessions {
		if sess.from == p || sess.to == p {
			delete(h.sessions, id)
			orphaned = append(orphaned, sess)
		}
	}
	h.sessMu.Unlock()

	for _, sess := range orphaned {
		if target := sess.other(p); target != nil {
			_ = target.sendJSON(serverMessage{Type: msgRelayClose, Session: sess.id})
		}
	}
}
