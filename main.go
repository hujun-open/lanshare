// Command lanshare runs the LanShare server: a discovery and signaling website
// for browsers on the same LAN, plus a STUN responder that helps them connect
// directly and a relay that carries their data when they cannot.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/hujun-open/myflags/v2"
	"github.com/spf13/cobra"

	"lanshare/internal/firewall"
	"lanshare/internal/netinfo"
	"lanshare/internal/server"
	"lanshare/internal/stun"
)

// version is injected at release build time via -ldflags "-X main.version=..."
var version = "dev"

//go:embed all:web
var webFS embed.FS

// CLI holds all command-line flags and subcommands for lanshare.
type CLI struct {
	Addr                string   `alias:"addr" usage:"interface to bind (0.0.0.0 for all)"`
	Port                int      `alias:"port" usage:"TCP port for the website and signaling WebSocket"`
	StunPort            int      `alias:"stun-port" usage:"UDP port for the embedded STUN responder (0 disables it)"`
	Token               string   `alias:"token" usage:"optional shared secret; clients must open the site with ?t=<token>"`
	TLS                 bool     `alias:"tls" usage:"serve HTTPS with a self-signed certificate, which unlocks streaming saves for very large files"`
	InstallFirewallRule bool     `alias:"install-firewall-rule" usage:"add the inbound Windows Defender rules and exit (requires an elevated prompt)"`
	Version             struct{} `usage:"print version and exit" action:"PrintVersion"`
}

func (c *CLI) PrintVersion(cmd *cobra.Command, args []string) {
	fmt.Println(version)
}

func (c *CLI) Run(cmd *cobra.Command, args []string) {
	rules := firewall.Rules(c.Port, c.StunPort)
	if c.InstallFirewallRule {
		installFirewallRules(rules)
		return
	}

	if err := run(c.Addr, c.Port, c.StunPort, c.Token, c.TLS, rules); err != nil {
		log.Fatalf("lanshare: %v", err)
	}
}

func main() {
	log.SetFlags(0)

	cli := &CLI{Addr: "0.0.0.0", Port: 8080, StunPort: 3478}
	filler := myflags.NewFiller("lanshare", "LAN file sharing via WebRTC",
		myflags.WithRootMethod(cli.Run),
	)
	if err := filler.Fill(cli); err != nil {
		log.Fatalf("lanshare: %v", err)
	}
	if err := filler.Execute(); err != nil {
		log.Fatalf("lanshare: %v", err)
	}
}

func run(host string, port, stunPort int, token string, useTLS bool, rules []firewall.Rule) error {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}

	// STUN is an optimization, never a requirement, so a failure to bind is
	// reported and then tolerated.
	var stunSrv *stun.Server
	if stunPort > 0 {
		stunSrv, err = stun.Listen(host, stunPort)
		if err != nil {
			log.Printf("warning: STUN disabled, could not bind UDP %d: %v", stunPort, err)
			log.Printf("         peers will fall back to mDNS host candidates, which need multicast to work")
			stunSrv = nil
		} else {
			stunPort = stunSrv.Port()
			go func() {
				if err := stunSrv.Serve(); err != nil {
					log.Printf("warning: STUN responder stopped: %v", err)
				}
			}()
			defer stunSrv.Close()
		}
	}

	srv := server.New(server.Options{
		WebFS:    sub,
		HTTPPort: port,
		STUNPort: stunPort,
		STUN:     stunSrv,
		Token:    token,
		TLS:      useTLS,
		Version:  version,
	})

	httpSrv := &http.Server{
		Addr:              net.JoinHostPort(host, strconv.Itoa(port)),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	if useTLS {
		cert, err := selfSignedCert()
		if err != nil {
			return fmt.Errorf("generating self-signed certificate: %w", err)
		}
		httpSrv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}}
	}

	ln, err := net.Listen("tcp", httpSrv.Addr)
	if err != nil {
		return fmt.Errorf("binding TCP %d: %w", port, err)
	}

	printBanner(port, stunPort, stunSrv != nil, token, useTLS, rules)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		if useTLS {
			errCh <- httpSrv.ServeTLS(ln, "", "")
		} else {
			errCh <- httpSrv.Serve(ln)
		}
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		log.Println("\nshutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}

func printBanner(port, stunPort int, stunOn bool, token string, useTLS bool, rules []firewall.Rule) {
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	suffix := ""
	if token != "" {
		suffix = "?t=" + token
	}

	fmt.Printf("\nLanShare %s\n\n", version)
	fmt.Printf("  On this machine:    %s://localhost:%d%s\n", scheme, port, suffix)

	addrs := netinfo.LANAddrs()
	if len(addrs) == 0 {
		fmt.Printf("  No LAN address found; other machines will not be able to reach this server.\n")
	}
	for i, a := range addrs {
		label := "  On other machines:  "
		if i > 0 {
			label = "                      "
		}
		fmt.Printf("%s%s://%s:%d%s   (%s)\n", label, scheme, a.IP, port, suffix, a.Interface)
	}

	fmt.Println()
	if stunOn {
		fmt.Printf("  STUN responder on UDP %d, so peers get real-IP candidates instead of mDNS names.\n", stunPort)
	} else {
		fmt.Printf("  STUN is off. Peers will rely on mDNS host candidates, which need multicast to work.\n")
	}
	if useTLS {
		fmt.Printf("  HTTPS uses a self-signed certificate, so each browser will show a warning once.\n")
	}

	printFirewallStatus(rules)
	fmt.Println("\n  Press Ctrl+C to stop.")
}

// printFirewallStatus reports which inbound rules are missing. It only ever
// reads firewall state; creating rules requires the explicit opt-in flag.
func printFirewallStatus(rules []firewall.Rule) {
	if !firewall.Supported() {
		fmt.Printf("\n  Make sure inbound TCP and UDP to the ports above are allowed on this machine.\n")
		return
	}
	var missing []firewall.Rule
	for _, r := range rules {
		if !firewall.Exists(r) {
			missing = append(missing, r)
		}
	}
	if len(missing) == 0 {
		fmt.Printf("\n  Firewall: inbound rules are already in place.\n")
		return
	}
	fmt.Printf("\n  Firewall: no inbound rule found for")
	for i, r := range missing {
		if i > 0 {
			fmt.Print(",")
		}
		fmt.Printf(" %s %d", r.Protocol, r.Port)
	}
	fmt.Println(".")
	fmt.Println("  Windows may prompt you to allow LanShare the first time a peer connects.")
	fmt.Println("  To add the rules yourself, run these from an elevated prompt:")
	for _, r := range missing {
		fmt.Printf("    %s\n", r.Command())
	}
	fmt.Println("  Or re-run LanShare elevated with --install-firewall-rule.")
}

func installFirewallRules(rules []firewall.Rule) {
	for _, r := range rules {
		if firewall.Exists(r) {
			log.Printf("already present: %s (%s %d)", r.Name, r.Protocol, r.Port)
			continue
		}
		if err := firewall.Install(r); err != nil {
			log.Printf("failed to add %s: %v", r.Name, err)
			log.Printf("  run this from an elevated prompt instead:\n    %s", r.Command())
			continue
		}
		log.Printf("added: %s (%s %d)", r.Name, r.Protocol, r.Port)
	}
}

// selfSignedCert builds an in-memory certificate covering localhost and every
// LAN address, so the same cert works no matter which one a client uses.
func selfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}

	ips := []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	for _, a := range netinfo.LANAddrs() {
		ips = append(ips, a.IP)
	}

	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "LanShare", Organization: []string{"LanShare"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           ips,
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}
