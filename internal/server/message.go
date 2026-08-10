package server

import "encoding/json"

// Control-channel message types. Text frames carry JSON in these shapes;
// binary frames are relay payload and are handled separately in relay.go.
const (
	// Server to client.
	msgWelcome       = "welcome"
	msgPeerJoin      = "peer-join"
	msgPeerLeave     = "peer-leave"
	msgRelayReady    = "relay-ready"
	msgRelayIncoming = "relay-incoming"
	msgError         = "error"

	// Client to server.
	msgHello      = "hello"
	msgRelayOpen  = "relay-open"
	msgRelayClose = "relay-close"

	// Bidirectional: forwarded verbatim between two peers.
	msgSignal   = "signal"
	msgRelayAck = "relay-ack"
)

// PeerInfo is the public identity of a peer, as shown in the roster.
type PeerInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Device string `json:"device"`
}

// clientMessage is the union of everything a browser may send.
type clientMessage struct {
	Type    string          `json:"type"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Session uint32          `json:"session,omitempty"`
	Bytes   uint64          `json:"bytes,omitempty"`
	Name    string          `json:"name,omitempty"`
}

// serverMessage is the union of everything the hub sends back.
type serverMessage struct {
	Type    string          `json:"type"`
	Self    *PeerInfo       `json:"self,omitempty"`
	Peers   []PeerInfo      `json:"peers,omitempty"`
	Peer    *PeerInfo       `json:"peer,omitempty"`
	ID      string          `json:"id,omitempty"`
	From    string          `json:"from,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Session uint32          `json:"session,omitempty"`
	Bytes   uint64          `json:"bytes,omitempty"`
	Room    string          `json:"room,omitempty"`
	Error   string          `json:"error,omitempty"`
}
