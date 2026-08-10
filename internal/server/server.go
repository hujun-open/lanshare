package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/coder/websocket"

	"lanshare/internal/names"
	"lanshare/internal/netinfo"
	"lanshare/internal/stun"
)

// ChunkSize is the payload size the browser uses for each file chunk. 64 KB is
// comfortably below the SCTP message limits of every current browser and keeps
// relay frames small enough to interleave with control messages.
const ChunkSize = 64 * 1024

const tokenCookie = "lanshare_token"

// Options configures the server.
type Options struct {
	WebFS    fs.FS
	HTTPPort int
	STUNPort int
	STUN     *stun.Server
	Token    string
	TLS      bool
	Version  string
}

// Server serves the web app, the signaling WebSocket, and the relay.
type Server struct {
	opts Options
	hub  *Hub
	mux  *http.ServeMux
}

// New builds the server and wires up its routes.
func New(opts Options) *Server {
	s := &Server{opts: opts, hub: NewHub(), mux: http.NewServeMux()}

	files := http.FileServerFS(opts.WebFS)
	s.mux.Handle("/", files)
	s.mux.HandleFunc("/diag", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, opts.WebFS, "diag.html")
	})
	s.mux.HandleFunc("/config", s.handleConfig)
	s.mux.HandleFunc("/api/diag", s.handleDiag)
	s.mux.HandleFunc("/ws", s.handleWS)

	return s
}

// Handler returns the root handler with the token gate applied.
func (s *Server) Handler() http.Handler {
	return s.withToken(s.mux)
}

// Hub exposes the hub for diagnostics.
func (s *Server) Hub() *Hub { return s.hub }

// withToken enforces the optional shared secret. A token supplied in the query
// string is moved into a cookie so that it does not linger in the address bar
// or leak through Referer headers on subsequent navigations.
func (s *Server) withToken(next http.Handler) http.Handler {
	if s.opts.Token == "" {
		return next
	}
	want := []byte(s.opts.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query().Get("t"); q != "" {
			if subtle.ConstantTimeCompare([]byte(q), want) == 1 {
				http.SetCookie(w, &http.Cookie{
					Name:     tokenCookie,
					Value:    q,
					Path:     "/",
					HttpOnly: true,
					SameSite: http.SameSiteLaxMode,
				})
				stripped := *r.URL
				query := stripped.Query()
				query.Del("t")
				stripped.RawQuery = query.Encode()
				http.Redirect(w, r, stripped.RequestURI(), http.StatusFound)
				return
			}
			http.Error(w, "invalid token", http.StatusForbidden)
			return
		}
		c, err := r.Cookie(tokenCookie)
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), want) != 1 {
			http.Error(w, "this LanShare server requires a token: append ?t=<token> to the URL", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientConfig is what the browser needs to bootstrap.
type clientConfig struct {
	ICEServers  []iceServer `json:"iceServers"`
	StunEnabled bool        `json:"stunEnabled"`
	ServerIPs   []string    `json:"serverIPs"`
	HTTPPort    int         `json:"httpPort"`
	StunPort    int         `json:"stunPort"`
	TLS         bool        `json:"tls"`
	Version     string      `json:"version"`
	ChunkSize   int         `json:"chunkSize"`
	// ShareSuffix is appended to the URLs shown for other machines. It carries
	// the token when one is configured, which is safe because reaching this
	// endpoint already required knowing it.
	ShareSuffix string `json:"shareSuffix"`
}

type iceServer struct {
	URLs []string `json:"urls"`
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := clientConfig{
		ICEServers:  []iceServer{},
		StunEnabled: s.opts.STUN != nil,
		HTTPPort:    s.opts.HTTPPort,
		StunPort:    s.opts.STUNPort,
		TLS:         s.opts.TLS,
		Version:     s.opts.Version,
		ChunkSize:   ChunkSize,
	}
	if s.opts.Token != "" {
		cfg.ShareSuffix = "?t=" + url.QueryEscape(s.opts.Token)
	}

	// The STUN URL is built from the host the browser actually used to reach
	// us, not from a guessed interface. On a multi-homed server that is the
	// only address guaranteed to be routable from this particular client.
	if s.opts.STUN != nil {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		// ICE wants an address it can send a UDP packet to; a literal is safer
		// than relying on the browser resolving "localhost" for a STUN URL.
		if host == "localhost" {
			host = "127.0.0.1"
		}
		if host != "" {
			url := "stun:" + net.JoinHostPort(host, strconv.Itoa(s.opts.STUNPort))
			cfg.ICEServers = append(cfg.ICEServers, iceServer{URLs: []string{url}})
		}
	}

	for _, a := range netinfo.LANAddrs() {
		cfg.ServerIPs = append(cfg.ServerIPs, a.IP.String())
	}

	writeJSON(w, cfg)
}

// diagResponse is the machine-readable half of the diagnostics page.
type diagResponse struct {
	Stats        Stats    `json:"stats"`
	ServerIPs    []string `json:"serverIPs"`
	HTTPPort     int      `json:"httpPort"`
	StunPort     int      `json:"stunPort"`
	StunEnabled  bool     `json:"stunEnabled"`
	StunRequests uint64   `json:"stunRequests"`
	TLS          bool     `json:"tls"`
	Version      string   `json:"version"`
	YourIP       string   `json:"yourIp"`
	YourSubnet   string   `json:"yourSubnet"`
}

func (s *Server) handleDiag(w http.ResponseWriter, r *http.Request) {
	ip := netinfo.RemoteIP(r)
	resp := diagResponse{
		Stats:       s.hub.Stats(),
		HTTPPort:    s.opts.HTTPPort,
		StunPort:    s.opts.STUNPort,
		StunEnabled: s.opts.STUN != nil,
		TLS:         s.opts.TLS,
		Version:     s.opts.Version,
		YourIP:      ipString(ip),
		YourSubnet:  netinfo.SubnetKey(ip, netinfo.PrimaryIP()),
	}
	if s.opts.STUN != nil {
		resp.StunRequests = s.opts.STUN.Requests()
	}
	for _, a := range netinfo.LANAddrs() {
		resp.ServerIPs = append(resp.ServerIPs, a.IP.String())
	}
	writeJSON(w, resp)
}

// handleWS upgrades the connection and runs the peer until it disconnects.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	// CloseNow is a no-op once a clean close has happened, so this is only the
	// abnormal-exit path.
	defer conn.CloseNow()

	q := r.URL.Query()
	id := sanitizeID(q.Get("id"))
	if id == "" {
		id = randomID()
	}
	name := sanitizeName(q.Get("name"))
	if name == "" {
		name = names.FromID(id)
	}

	remote := netinfo.RemoteIP(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p := &Peer{
		ID:     id,
		Name:   name,
		Device: sanitizeDevice(q.Get("device")),
		Room:   netinfo.SubnetKey(remote, netinfo.PrimaryIP()),
		Addr:   ipString(remote),
		Joined: time.Now(),
		hub:    s.hub,
		conn:   conn,
		out:    make(chan frame, outboundQueue),
		ctx:    ctx,
		cancel: cancel,
	}

	go p.writeLoop()
	go p.heartbeat()
	s.hub.join(p)
	p.readLoop()
	s.hub.leave(p)

	conn.Close(websocket.StatusNormalClosure, "")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func ipString(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

// sanitizeID keeps peer IDs to an opaque, safe alphabet since they are echoed
// back to other clients.
func sanitizeID(s string) string {
	if len(s) > 64 {
		s = s[:64]
	}
	var b strings.Builder
	for _, r := range s {
		if r == '-' || r == '_' || unicode.IsDigit(r) || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// sanitizeName strips control characters from a display name and bounds its
// length. The name is rendered as text on other clients, never as HTML.
func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
		if b.Len() >= 40 {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

func sanitizeDevice(s string) string {
	switch s {
	case "phone", "tablet", "laptop", "desktop":
		return s
	default:
		return "desktop"
	}
}
