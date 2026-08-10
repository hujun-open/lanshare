// Package stun implements the minimum of RFC 5389 needed to hand a browser a
// server-reflexive ICE candidate: the Binding request/response exchange.
//
// This exists to remove LanShare's dependency on multicast. Chrome and Edge
// replace LAN host candidates with random ".local" mDNS names, whose resolution
// needs multicast UDP 5353 to survive both host firewalls and the access point.
// mDNS obfuscation applies only to host candidates, so reflecting a browser's
// real address back to it as a srflx candidate sidesteps the problem entirely.
//
// No authentication, no allocations, no TURN. A Binding response carries no
// MESSAGE-INTEGRITY, which matches how public STUN servers behave and is what
// browser ICE agents expect.
package stun

import (
	"encoding/binary"
	"errors"
	"net"
	"strconv"
	"sync/atomic"
)

const (
	magicCookie = 0x2112A442
	headerSize  = 20
	maxPacket   = 1500

	typeBindingRequest = 0x0001
	typeBindingSuccess = 0x0101

	attrMappedAddress    = 0x0001
	attrXorMappedAddress = 0x0020
	attrSoftware         = 0x8022

	familyIPv4 = 0x01
	familyIPv6 = 0x02
)

var software = []byte("LanShare")

// Server answers STUN Binding requests on a UDP socket.
type Server struct {
	conn     *net.UDPConn
	requests atomic.Uint64
}

// Listen binds the UDP socket. A port of 0 picks any free port.
func Listen(host string, port int) (*Server, error) {
	udpAddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, err
	}
	return &Server{conn: conn}, nil
}

// Port reports the bound port, which matters when 0 was requested.
func (s *Server) Port() int {
	if a, ok := s.conn.LocalAddr().(*net.UDPAddr); ok {
		return a.Port
	}
	return 0
}

// Requests counts Binding requests answered, surfaced on the diagnostics page
// so a user can tell whether STUN traffic is reaching the server at all.
func (s *Server) Requests() uint64 { return s.requests.Load() }

// Close stops the server and unblocks Serve.
func (s *Server) Close() error { return s.conn.Close() }

// Serve reads and answers requests until the socket is closed.
func (s *Server) Serve() error {
	buf := make([]byte, maxPacket)
	for {
		n, addr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			// A transient read error on one packet should not kill the server.
			continue
		}
		resp, err := buildResponse(buf[:n], addr)
		if err != nil {
			continue
		}
		s.requests.Add(1)
		_, _ = s.conn.WriteToUDP(resp, addr)
	}
}

// buildResponse validates a Binding request and renders the success response.
func buildResponse(pkt []byte, from *net.UDPAddr) ([]byte, error) {
	if len(pkt) < headerSize {
		return nil, errors.New("stun: short packet")
	}
	msgType := binary.BigEndian.Uint16(pkt[0:2])
	// The two most significant bits of a STUN message are always zero, which is
	// what distinguishes STUN from other traffic multiplexed on the same port.
	if msgType&0xC000 != 0 || msgType != typeBindingRequest {
		return nil, errors.New("stun: not a binding request")
	}
	if binary.BigEndian.Uint32(pkt[4:8]) != magicCookie {
		return nil, errors.New("stun: bad magic cookie")
	}
	txID := pkt[8:20]

	var attrs []byte
	attrs = appendXorMappedAddress(attrs, from, txID)
	attrs = appendMappedAddress(attrs, from)
	attrs = appendAttr(attrs, attrSoftware, software)

	resp := make([]byte, 0, headerSize+len(attrs))
	resp = binary.BigEndian.AppendUint16(resp, typeBindingSuccess)
	resp = binary.BigEndian.AppendUint16(resp, uint16(len(attrs)))
	resp = binary.BigEndian.AppendUint32(resp, magicCookie)
	resp = append(resp, txID...)
	resp = append(resp, attrs...)
	return resp, nil
}

// appendAttr writes one TLV, padding the value to a 4-byte boundary while
// leaving the declared length as the true value length.
func appendAttr(dst []byte, typ uint16, value []byte) []byte {
	dst = binary.BigEndian.AppendUint16(dst, typ)
	dst = binary.BigEndian.AppendUint16(dst, uint16(len(value)))
	dst = append(dst, value...)
	for pad := (4 - len(value)%4) % 4; pad > 0; pad-- {
		dst = append(dst, 0)
	}
	return dst
}

// appendXorMappedAddress is the attribute browsers actually read. The address
// is XORed with the magic cookie so that NATs rewriting payloads cannot
// accidentally mangle it.
func appendXorMappedAddress(dst []byte, addr *net.UDPAddr, txID []byte) []byte {
	value := []byte{0, 0}
	xorPort := uint16(addr.Port) ^ uint16(magicCookie>>16)

	if ip4 := addr.IP.To4(); ip4 != nil {
		value[1] = familyIPv4
		value = binary.BigEndian.AppendUint16(value, xorPort)
		var cookie [4]byte
		binary.BigEndian.PutUint32(cookie[:], magicCookie)
		for i := 0; i < 4; i++ {
			value = append(value, ip4[i]^cookie[i])
		}
	} else {
		ip6 := addr.IP.To16()
		value[1] = familyIPv6
		value = binary.BigEndian.AppendUint16(value, xorPort)
		var key [16]byte
		binary.BigEndian.PutUint32(key[:4], magicCookie)
		copy(key[4:], txID)
		for i := 0; i < 16; i++ {
			value = append(value, ip6[i]^key[i])
		}
	}
	return appendAttr(dst, attrXorMappedAddress, value)
}

// appendMappedAddress is the pre-RFC5389 form, included for older clients.
func appendMappedAddress(dst []byte, addr *net.UDPAddr) []byte {
	value := []byte{0, 0}
	if ip4 := addr.IP.To4(); ip4 != nil {
		value[1] = familyIPv4
		value = binary.BigEndian.AppendUint16(value, uint16(addr.Port))
		value = append(value, ip4...)
	} else {
		value[1] = familyIPv6
		value = binary.BigEndian.AppendUint16(value, uint16(addr.Port))
		value = append(value, addr.IP.To16()...)
	}
	return appendAttr(dst, attrMappedAddress, value)
}
