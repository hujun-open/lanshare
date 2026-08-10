// Package netinfo enumerates the machine's LAN addresses and derives the
// subnet keys used to group peers into rooms.
package netinfo

import (
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
)

// Addr is a usable IPv4 address bound to a local interface.
type Addr struct {
	Interface string
	IP        net.IP
	Mask      net.IPMask
}

// String renders the address in "IP (interface)" form for the startup banner.
func (a Addr) String() string {
	return fmt.Sprintf("%s (%s)", a.IP, a.Interface)
}

// LANAddrs returns every up, non-loopback IPv4 address on the machine, ordered
// so that the most likely LAN address comes first.
func LANAddrs() []Addr {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var out []Addr
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, Addr{Interface: iface.Name, IP: ip4, Mask: ipnet.Mask})
		}
	}

	preferred := routedIP()
	sort.SliceStable(out, func(i, j int) bool {
		return addrRank(out[i], preferred) < addrRank(out[j], preferred)
	})
	return out
}

// routedIP reports the address the OS would source traffic from when leaving
// this machine. Dialing a UDP socket sends nothing; it only consults the
// routing table, so this still answers correctly on a LAN with no internet.
//
// This is far more reliable than guessing from interface names, which is what
// separates a real LAN adapter from a VirtualBox or Hyper-V one.
func routedIP() net.IP {
	conn, err := net.Dial("udp4", "8.8.8.8:53")
	if err != nil {
		return nil
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return nil
	}
	return addr.IP.To4()
}

// addrRank orders addresses by how likely they are to be the real LAN address a
// second machine can reach. Home and office subnets first, virtual adapters last.
func addrRank(a Addr, preferred net.IP) int {
	// The interface carrying the default route is the one a peer on the LAN
	// will actually be able to reach.
	if preferred != nil && a.IP.Equal(preferred) {
		return -1
	}
	name := strings.ToLower(a.Interface)
	// Hyper-V, WSL, VirtualBox and Docker adapters are reachable only from the
	// host, so they are never the address to hand to another machine.
	for _, virt := range []string{"vethernet", "wsl", "virtualbox", "vmware", "docker", "loopback", "hyper-v"} {
		if strings.Contains(name, virt) {
			return 100
		}
	}
	switch {
	case a.IP[0] == 192 && a.IP[1] == 168:
		return 0
	case a.IP[0] == 10:
		return 1
	case a.IP[0] == 172 && a.IP[1] >= 16 && a.IP[1] <= 31:
		return 2
	default:
		return 50
	}
}

// PrimaryIP is the best guess at the address other machines should connect to.
func PrimaryIP() net.IP {
	addrs := LANAddrs()
	if len(addrs) == 0 {
		return net.IPv4(127, 0, 0, 1)
	}
	return addrs[0].IP
}

// SubnetKey groups an address into a room. IPv4 is grouped by its /24, which
// matches how a small LAN is almost always laid out.
//
// Loopback clients are the browser running on the server machine itself, so
// they are folded into the server's own LAN subnet rather than being isolated
// in a room of their own.
func SubnetKey(ip net.IP, loopbackFallback net.IP) string {
	if ip == nil {
		return "unknown"
	}
	if ip.IsLoopback() {
		if loopbackFallback == nil {
			return "loopback"
		}
		ip = loopbackFallback
	}
	if ip4 := ip.To4(); ip4 != nil {
		return fmt.Sprintf("%d.%d.%d.0/24", ip4[0], ip4[1], ip4[2])
	}
	// IPv6 peers are grouped by their /64.
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// RemoteIP extracts the client address from a request, tolerating a missing port.
func RemoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}
