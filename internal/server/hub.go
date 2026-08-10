package server

import (
	"sort"
	"sync"
	"sync/atomic"
)

// Hub tracks connected peers, grouped into rooms by subnet, and owns the relay
// session table.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*Peer

	sessMu   sync.Mutex
	sessions map[uint32]*relaySession
	nextSess uint32

	relayBytes    atomic.Uint64
	relaySessions atomic.Uint64
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{
		rooms:    make(map[string]map[string]*Peer),
		sessions: make(map[uint32]*relaySession),
	}
}

// join registers a peer, hands it the current roster, and announces it to the
// rest of its room.
func (h *Hub) join(p *Peer) {
	h.mu.Lock()
	room, ok := h.rooms[p.Room]
	if !ok {
		room = make(map[string]*Peer)
		h.rooms[p.Room] = room
	}
	// A reconnect or a second tab reusing the same identity replaces the old
	// connection rather than creating a confusing duplicate in the roster.
	displaced := room[p.ID]
	room[p.ID] = p

	others := make([]PeerInfo, 0, len(room))
	targets := make([]*Peer, 0, len(room))
	for id, other := range room {
		if id == p.ID {
			continue
		}
		others = append(others, other.Info())
		targets = append(targets, other)
	}
	h.mu.Unlock()

	if displaced != nil {
		_ = displaced.sendJSON(serverMessage{Type: msgError, Error: "replaced by a newer connection"})
		displaced.close()
	}

	sort.Slice(others, func(i, j int) bool { return others[i].Name < others[j].Name })

	self := p.Info()
	_ = p.sendJSON(serverMessage{
		Type:  msgWelcome,
		Self:  &self,
		Peers: others,
		Room:  p.Room,
	})

	for _, other := range targets {
		_ = other.sendJSON(serverMessage{Type: msgPeerJoin, Peer: &self})
	}
}

// leave removes a peer, tears down its relay sessions, and announces the
// departure.
func (h *Hub) leave(p *Peer) {
	h.mu.Lock()
	room, ok := h.rooms[p.Room]
	if !ok {
		h.mu.Unlock()
		return
	}
	// Only remove the entry if it is still this connection; a displaced peer
	// must not evict the connection that replaced it.
	if room[p.ID] != p {
		h.mu.Unlock()
		return
	}
	delete(room, p.ID)
	if len(room) == 0 {
		delete(h.rooms, p.Room)
	}
	targets := make([]*Peer, 0, len(room))
	for _, other := range room {
		targets = append(targets, other)
	}
	h.mu.Unlock()

	h.closePeerSessions(p)

	for _, other := range targets {
		_ = other.sendJSON(serverMessage{Type: msgPeerLeave, ID: p.ID})
	}
}

// broadcastPeerUpdate re-announces a peer whose display name changed. Clients
// upsert by ID, so a join message doubles as an update.
func (h *Hub) broadcastPeerUpdate(p *Peer) {
	info := p.Info()
	for _, other := range h.roomPeers(p.Room) {
		if other.ID == p.ID {
			continue
		}
		_ = other.sendJSON(serverMessage{Type: msgPeerJoin, Peer: &info})
	}
}

// find looks up a peer within a room. Cross-room addressing is not possible,
// which keeps peers on other subnets invisible and unreachable.
func (h *Hub) find(room, id string) *Peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[room][id]
}

// roomPeers snapshots the members of a room.
func (h *Hub) roomPeers(room string) []*Peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	peers := make([]*Peer, 0, len(h.rooms[room]))
	for _, p := range h.rooms[room] {
		peers = append(peers, p)
	}
	return peers
}

// RoomSummary describes one room for the diagnostics page.
type RoomSummary struct {
	Subnet string     `json:"subnet"`
	Peers  []PeerInfo `json:"peers"`
}

// Stats reports hub state for the diagnostics page.
type Stats struct {
	Rooms               []RoomSummary `json:"rooms"`
	PeerCount           int           `json:"peerCount"`
	ActiveRelaySessions int           `json:"activeRelaySessions"`
	TotalRelaySessions  uint64        `json:"totalRelaySessions"`
	RelayBytes          uint64        `json:"relayBytes"`
}

// Stats snapshots the hub.
func (h *Hub) Stats() Stats {
	h.mu.RLock()
	s := Stats{Rooms: make([]RoomSummary, 0, len(h.rooms))}
	for subnet, room := range h.rooms {
		summary := RoomSummary{Subnet: subnet, Peers: make([]PeerInfo, 0, len(room))}
		for _, p := range room {
			summary.Peers = append(summary.Peers, p.Info())
		}
		sort.Slice(summary.Peers, func(i, j int) bool { return summary.Peers[i].Name < summary.Peers[j].Name })
		s.PeerCount += len(room)
		s.Rooms = append(s.Rooms, summary)
	}
	h.mu.RUnlock()
	sort.Slice(s.Rooms, func(i, j int) bool { return s.Rooms[i].Subnet < s.Rooms[j].Subnet })

	h.sessMu.Lock()
	s.ActiveRelaySessions = len(h.sessions)
	h.sessMu.Unlock()

	s.TotalRelaySessions = h.relaySessions.Load()
	s.RelayBytes = h.relayBytes.Load()
	return s
}
