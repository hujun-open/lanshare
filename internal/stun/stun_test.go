package stun_test

import (
	"encoding/binary"
	"net"
	"strconv"
	"testing"
	"time"

	"lanshare/internal/stun"
)

const (
	magicCookie          = 0x2112A442
	typeBindingSuccess   = 0x0101
	attrXorMappedAddress = 0x0020
)

// TestBindingResponse checks that a browser asking "what address do you see me
// on?" gets its real source address back, which is what turns into the srflx
// ICE candidate that lets peers skip mDNS.
func TestBindingResponse(t *testing.T) {
	srv, err := stun.Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve() }()

	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(srv.Port())))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:2], 0x0001)
	binary.BigEndian.PutUint16(req[2:4], 0)
	binary.BigEndian.PutUint32(req[4:8], magicCookie)
	for i := 8; i < 20; i++ {
		req[i] = byte(i * 7)
	}

	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	resp := buf[:n]

	if got := binary.BigEndian.Uint16(resp[0:2]); got != typeBindingSuccess {
		t.Fatalf("message type = %#04x, want %#04x", got, typeBindingSuccess)
	}
	if got := binary.BigEndian.Uint32(resp[4:8]); got != magicCookie {
		t.Fatalf("magic cookie = %#08x", got)
	}
	if string(resp[8:20]) != string(req[8:20]) {
		t.Fatal("transaction ID was not echoed")
	}
	if want := int(binary.BigEndian.Uint16(resp[2:4])) + 20; want != n {
		t.Fatalf("declared length %d does not match packet size %d", want, n)
	}

	ip, port := findXorMappedAddress(t, resp)
	local := conn.LocalAddr().(*net.UDPAddr)
	if port != local.Port {
		t.Errorf("reflected port = %d, want %d", port, local.Port)
	}
	if !ip.Equal(local.IP) {
		t.Errorf("reflected IP = %s, want %s", ip, local.IP)
	}

	if srv.Requests() != 1 {
		t.Errorf("Requests() = %d, want 1", srv.Requests())
	}
}

// TestIgnoresNonStun makes sure stray traffic on the port does not produce a
// reply or get counted.
func TestIgnoresNonStun(t *testing.T) {
	srv, err := stun.Listen("127.0.0.1", 0)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve() }()

	conn, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(srv.Port())))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("this is not a STUN packet at all")); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if n, err := conn.Read(make([]byte, 512)); err == nil {
		t.Fatalf("got a %d byte reply to non-STUN traffic", n)
	}
	if srv.Requests() != 0 {
		t.Errorf("Requests() = %d, want 0", srv.Requests())
	}
}

// findXorMappedAddress walks the attribute list and decodes XOR-MAPPED-ADDRESS.
func findXorMappedAddress(t *testing.T, resp []byte) (net.IP, int) {
	t.Helper()
	attrs := resp[20:]
	for len(attrs) >= 4 {
		typ := binary.BigEndian.Uint16(attrs[0:2])
		length := int(binary.BigEndian.Uint16(attrs[2:4]))
		padded := (length + 3) &^ 3
		if len(attrs) < 4+padded {
			t.Fatal("truncated attribute")
		}
		value := attrs[4 : 4+length]

		if typ == attrXorMappedAddress {
			if len(value) < 8 {
				t.Fatal("XOR-MAPPED-ADDRESS too short")
			}
			port := int(binary.BigEndian.Uint16(value[2:4]) ^ uint16(magicCookie>>16))
			var cookie [4]byte
			binary.BigEndian.PutUint32(cookie[:], magicCookie)
			ip := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				ip[i] = value[4+i] ^ cookie[i]
			}
			return ip, port
		}
		attrs = attrs[4+padded:]
	}
	t.Fatal("response had no XOR-MAPPED-ADDRESS attribute")
	return nil, 0
}
