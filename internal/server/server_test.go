package server_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"lanshare/internal/server"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := server.New(server.Options{
		WebFS:    fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
		HTTPPort: 8080,
		STUNPort: 3478,
		Version:  "test",
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func dial(t *testing.T, ts *httptest.Server, id, name string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	endpoint := "ws" + strings.TrimPrefix(ts.URL, "http") +
		"/ws?id=" + id + "&name=" + url.QueryEscape(name)
	conn, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", id, err)
	}
	conn.SetReadLimit(1 << 20)
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

// waitFor reads control messages until one of the wanted type arrives.
func waitFor(t *testing.T, conn *websocket.Conn, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		typ, data, err := conn.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("waiting for %q: %v", want, err)
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("bad JSON: %v", err)
		}
		if msg["type"] == want {
			return msg
		}
	}
	t.Fatalf("timed out waiting for %q", want)
	return nil
}

func send(t *testing.T, conn *websocket.Conn, msg any) {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// TestDiscovery covers the roster: a joiner learns who is already present, and
// everyone already present learns about the joiner.
func TestDiscovery(t *testing.T) {
	ts := newTestServer(t)

	alice := dial(t, ts, "alice", "Alice")
	welcome := waitFor(t, alice, "welcome")
	if peers, _ := welcome["peers"].([]any); len(peers) != 0 {
		t.Fatalf("first peer should see an empty roster, got %v", peers)
	}
	if self, _ := welcome["self"].(map[string]any); self["name"] != "Alice" {
		t.Fatalf("self name = %v, want Alice", self["name"])
	}

	bob := dial(t, ts, "bob", "Bob")
	bobWelcome := waitFor(t, bob, "welcome")
	peers, _ := bobWelcome["peers"].([]any)
	if len(peers) != 1 {
		t.Fatalf("Bob should see Alice, got %d peers", len(peers))
	}

	join := waitFor(t, alice, "peer-join")
	if peer, _ := join["peer"].(map[string]any); peer["id"] != "bob" {
		t.Fatalf("peer-join id = %v, want bob", peer["id"])
	}

	bob.Close(websocket.StatusNormalClosure, "")
	leave := waitFor(t, alice, "peer-leave")
	if leave["id"] != "bob" {
		t.Fatalf("peer-leave id = %v, want bob", leave["id"])
	}
}

// TestSignalForwarding checks that SDP and ICE pass through untouched, since
// the server must never rewrite them.
func TestSignalForwarding(t *testing.T) {
	ts := newTestServer(t)

	alice := dial(t, ts, "alice", "Alice")
	waitFor(t, alice, "welcome")
	bob := dial(t, ts, "bob", "Bob")
	waitFor(t, bob, "welcome")
	waitFor(t, alice, "peer-join")

	send(t, alice, map[string]any{
		"type":    "signal",
		"to":      "bob",
		"payload": map[string]any{"description": map[string]any{"type": "offer", "sdp": "v=0 test"}},
	})

	msg := waitFor(t, bob, "signal")
	if msg["from"] != "alice" {
		t.Fatalf("from = %v, want alice", msg["from"])
	}
	payload := msg["payload"].(map[string]any)
	description := payload["description"].(map[string]any)
	if description["sdp"] != "v=0 test" {
		t.Fatalf("SDP was altered: %v", description["sdp"])
	}
}

// TestRelayRoundTrip is the fallback path end to end: session setup, payload
// forwarding with the session header intact, and the ack that drives the
// sender's credit window.
func TestRelayRoundTrip(t *testing.T) {
	ts := newTestServer(t)

	alice := dial(t, ts, "alice", "Alice")
	waitFor(t, alice, "welcome")
	bob := dial(t, ts, "bob", "Bob")
	waitFor(t, bob, "welcome")
	waitFor(t, alice, "peer-join")

	send(t, alice, map[string]any{"type": "relay-open", "to": "bob"})

	ready := waitFor(t, alice, "relay-ready")
	session := uint32(ready["session"].(float64))
	if session == 0 {
		t.Fatal("session ID should never be zero")
	}
	incoming := waitFor(t, bob, "relay-incoming")
	if uint32(incoming["session"].(float64)) != session {
		t.Fatal("both ends must agree on the session ID")
	}
	if incoming["from"] != "alice" {
		t.Fatalf("from = %v, want alice", incoming["from"])
	}

	payload := []byte("chunk of file data")
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame[:4], session)
	copy(frame[4:], payload)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := alice.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write frame: %v", err)
	}

	typ, got, err := bob.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("expected a binary frame, got %v", typ)
	}
	if binary.BigEndian.Uint32(got[:4]) != session {
		t.Fatal("session header was not preserved")
	}
	if string(got[4:]) != string(payload) {
		t.Fatalf("payload = %q, want %q", got[4:], payload)
	}

	send(t, bob, map[string]any{"type": "relay-ack", "session": session, "bytes": len(payload)})
	ack := waitFor(t, alice, "relay-ack")
	if uint64(ack["bytes"].(float64)) != uint64(len(payload)) {
		t.Fatalf("ack bytes = %v, want %d", ack["bytes"], len(payload))
	}

	// A departing peer must tear the session down rather than leaving the
	// sender waiting on a transfer that can never finish.
	bob.Close(websocket.StatusNormalClosure, "")
	closed := waitFor(t, alice, "relay-close")
	if uint32(closed["session"].(float64)) != session {
		t.Fatal("wrong session closed")
	}
}

// TestRelayToUnknownPeer makes sure a bad target is refused instead of
// allocating a dangling session.
func TestRelayToUnknownPeer(t *testing.T) {
	ts := newTestServer(t)

	alice := dial(t, ts, "alice", "Alice")
	waitFor(t, alice, "welcome")

	send(t, alice, map[string]any{"type": "relay-open", "to": "nobody"})
	msg := waitFor(t, alice, "error")
	if !strings.Contains(msg["error"].(string), "nobody") {
		t.Fatalf("unhelpful error: %v", msg["error"])
	}
}

// TestTokenGate checks that the shared secret actually gates access.
func TestTokenGate(t *testing.T) {
	srv := server.New(server.Options{
		WebFS: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
		Token: "s3cret",
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	resp, err := client.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("without a token: status = %d, want 403", resp.StatusCode)
	}

	resp2, err := client.Get(ts.URL + "/?t=s3cret")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusFound {
		t.Fatalf("with a token: status = %d, want a redirect", resp2.StatusCode)
	}
	if len(resp2.Cookies()) == 0 {
		t.Fatal("a valid token should set a cookie")
	}
}
