package server

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// Each peer has a bounded outbound queue. Blocking a sender's read loop when
	// the target queue fills is deliberate: it propagates backpressure down to
	// TCP instead of letting the server buffer a whole file in memory.
	outboundQueue = 64

	// How long to wait for a stalled peer before giving up on it entirely.
	sendTimeout = 30 * time.Second

	// Relay chunks are 64 KB plus a 4-byte session header; the limit leaves
	// generous headroom without letting a client force a large allocation.
	readLimit = 1 << 20

	// How often to check that a peer is still really there, and how long to
	// wait for its pong before giving up on it.
	pingInterval = 15 * time.Second
	pingTimeout  = 10 * time.Second
)

var errPeerClosed = errors.New("peer closed")

// frame is one queued WebSocket message.
type frame struct {
	typ  websocket.MessageType
	data []byte
}

// Peer is one connected browser.
type Peer struct {
	ID     string
	Name   string
	Device string
	Room   string
	Addr   string
	Joined time.Time

	hub  *Hub
	conn *websocket.Conn
	out  chan frame

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// Info is the peer's public identity.
func (p *Peer) Info() PeerInfo {
	return PeerInfo{ID: p.ID, Name: p.Name, Device: p.Device}
}

// send queues a frame, applying backpressure rather than dropping data. A peer
// that cannot drain within sendTimeout is considered dead and is disconnected.
func (p *Peer) send(f frame) error {
	select {
	case p.out <- f:
		return nil
	case <-p.ctx.Done():
		return errPeerClosed
	case <-time.After(sendTimeout):
		p.close()
		return errPeerClosed
	}
}

// sendJSON queues a control message.
func (p *Peer) sendJSON(m serverMessage) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return p.send(frame{typ: websocket.MessageText, data: b})
}

// sendBinary queues a relay payload frame.
func (p *Peer) sendBinary(b []byte) error {
	return p.send(frame{typ: websocket.MessageBinary, data: b})
}

func (p *Peer) close() {
	p.closeOnce.Do(func() { p.cancel() })
}

// writeLoop is the single writer for this connection, which is what keeps
// concurrent senders from interleaving frames.
func (p *Peer) writeLoop() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case f := <-p.out:
			ctx, cancel := context.WithTimeout(p.ctx, sendTimeout)
			err := p.conn.Write(ctx, f.typ, f.data)
			cancel()
			if err != nil {
				p.close()
				return
			}
		}
	}
}

// heartbeat drops a peer that stops answering pings.
//
// A closed tab normally sends a TCP FIN and is reaped immediately, but a
// suspended laptop, a dropped WiFi link, or a killed browser process leaves the
// socket half-open with no notification. Without this, that peer would sit in
// everyone's roster forever as a device that can never receive anything.
func (p *Peer) heartbeat() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(p.ctx, pingTimeout)
			err := p.conn.Ping(ctx)
			cancel()
			if err != nil {
				p.close()
				return
			}
		}
	}
}

// readLoop dispatches inbound frames until the connection drops.
func (p *Peer) readLoop() {
	p.conn.SetReadLimit(readLimit)
	for {
		typ, data, err := p.conn.Read(p.ctx)
		if err != nil {
			p.close()
			return
		}
		switch typ {
		case websocket.MessageBinary:
			// Relay payload. Routing errors are non-fatal: the session may have
			// closed while chunks were still in flight.
			_ = p.hub.routeRelayFrame(p, data)
		case websocket.MessageText:
			var m clientMessage
			if err := json.Unmarshal(data, &m); err != nil {
				_ = p.sendJSON(serverMessage{Type: msgError, Error: "malformed message"})
				continue
			}
			p.handle(m)
		}
	}
}

// handle processes one decoded control message.
func (p *Peer) handle(m clientMessage) {
	switch m.Type {
	case msgSignal:
		// SDP and ICE candidates are forwarded verbatim; the server never
		// inspects or rewrites them.
		target := p.hub.find(p.Room, m.To)
		if target == nil {
			_ = p.sendJSON(serverMessage{Type: msgError, Error: "peer not found: " + m.To})
			return
		}
		_ = target.sendJSON(serverMessage{
			Type:    msgSignal,
			From:    p.ID,
			Payload: m.Payload,
		})

	case msgRelayOpen:
		p.hub.openRelay(p, m.To)

	case msgRelayAck:
		p.hub.routeRelayAck(p, m.Session, m.Bytes)

	case msgRelayClose:
		p.hub.closeRelay(m.Session, p)

	case msgHello:
		// Renaming after connect.
		if name := sanitizeName(m.Name); name != "" {
			p.Name = name
			p.hub.broadcastPeerUpdate(p)
		}
	}
}
