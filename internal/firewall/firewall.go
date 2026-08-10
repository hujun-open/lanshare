// Package firewall inspects and, only when explicitly asked, creates the
// inbound Windows Defender rules LanShare needs.
//
// Machine S is the only machine that needs open ports: TCP for the website and
// WebSocket, UDP for the embedded STUN responder. Nothing here modifies the
// system unless Install is called, which happens only behind an opt-in flag.
package firewall

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// Rule describes one inbound allow rule.
type Rule struct {
	Name     string
	Protocol string // "TCP" or "UDP"
	Port     int
}

// Command renders the netsh invocation that creates the rule.
func (r Rule) Command() string {
	return fmt.Sprintf(
		`netsh advfirewall firewall add rule name="%s" dir=in action=allow protocol=%s localport=%d`,
		r.Name, r.Protocol, r.Port,
	)
}

// Rules lists what LanShare wants open for the given ports.
func Rules(httpPort, stunPort int) []Rule {
	return []Rule{
		{Name: "LanShare HTTP", Protocol: "TCP", Port: httpPort},
		{Name: "LanShare STUN", Protocol: "UDP", Port: stunPort},
	}
}

// Supported reports whether rule inspection is possible on this OS.
func Supported() bool { return runtime.GOOS == "windows" }

// Exists reports whether a rule of this name is already present. A false result
// on a non-Windows OS simply means "unknown", and callers treat it as such.
func Exists(r Rule) bool {
	if !Supported() {
		return false
	}
	// "show rule" is read-only and works without elevation. It exits non-zero
	// when no rule matches the name.
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name="+r.Name).CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), r.Name)
}

// Install creates the rule. This requires an elevated process and is only
// reached through the --install-firewall-rule flag.
func Install(r Rule) error {
	if !Supported() {
		return fmt.Errorf("automatic firewall rules are only supported on Windows; open %s port %d manually", r.Protocol, r.Port)
	}
	out, err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+r.Name,
		"dir=in",
		"action=allow",
		"protocol="+r.Protocol,
		fmt.Sprintf("localport=%d", r.Port),
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
