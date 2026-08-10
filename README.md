# LanShare

Send files and text between two browsers on the same LAN. One machine runs a
single self-contained binary; the other devices just open a web page. Transfers
go directly peer-to-peer over WebRTC, and fall back to relaying through the
server when a firewall blocks the direct path.

No installation on the client devices, no cloud, no accounts, no build step.

## Quick start

```bash
go build -o lanshare .
./lanshare
```

The startup banner prints every URL the server is reachable on:

```
LanShare v0.0.1

  On this machine:    http://localhost:8080
  On other machines:  http://192.168.1.100:8080   (Ethernet)
```

`lanshare version` prints the build version (a git tag like `v0.0.1` for
releases, or `dev` for a plain local build).

Open one of those URLs on each device. They find each other automatically and
appear as tiles. Click a tile or drag files onto it to send.

## How it works

Three roles. **S** runs the binary and is the only machine that needs open
inbound ports. **A** and **B** are the devices exchanging files; they only ever
run a browser and only ever make outbound connections.

```
   A (browser)                S (binary)                B (browser)
       |                          |                          |
       |---- WebSocket: roster, SDP/ICE ---------------------|
       |---- STUN: "what is my address?" --------------------|
       |                          |                          |
       |======== WebRTC data channel, direct ================|   preferred
       |- - - - - relay frames - -|- - - relay frames - - - -|   fallback
```

1. Both browsers load the page from S and open a WebSocket to it.
2. S groups them into a room by subnet and tells each about the other.
3. They exchange SDP and ICE candidates through S and try to connect directly.
4. Payload flows over the data channel. S sees none of it.
5. If no ICE candidate pair validates within 8 seconds, both sides fall back to
   relaying through the WebSocket, and the UI marks the transfer "via server".

### Why the direct path usually works even with a firewall

A browser cannot listen on a port, so neither side can be a server in the
ordinary sense. WebRTC solves this with ICE hole punching, which needs only
**one** of the two machines to accept an unsolicited inbound packet.

Both sides send STUN connectivity checks at the same time. If A accepts inbound
and B does not, B's check reaches A, and A's reply gets back to B because B's
stateful firewall now holds outbound state for that exact 5-tuple. A's own check
would be dropped, but ICE immediately re-sends it on that same 5-tuple, which B
now permits. Both directions open.

Nothing in the app chooses who "hosts". ICE resolves the asymmetry below the
application layer.

### Why there is a STUN server built in

Chrome and Edge hide your LAN address behind a random `.local` mDNS hostname
instead of putting it in a host candidate. Resolving that name needs multicast
UDP 5353 to survive both host firewalls and the access point, which is a fragile
thing to depend on.

mDNS obfuscation applies only to **host** candidates. The binary answers STUN
Binding requests on UDP 3478, so each browser also gets a server-reflexive
candidate carrying its real IP and port as a literal address. No multicast
involved. STUN is an optimization, never a requirement: if UDP 3478 is blocked,
ICE falls back to mDNS, and if that fails too the relay still works.

## Firewall

Only machine S needs inbound rules, and it needs two: TCP for the website and
UDP for STUN. The startup banner checks for them and prints the exact commands
when they are missing:

```
netsh advfirewall firewall add rule name="LanShare HTTP" dir=in action=allow protocol=TCP localport=8080
netsh advfirewall firewall add rule name="LanShare STUN" dir=in action=allow protocol=UDP localport=3478
```

Run `lanshare --install-firewall-rule` from an elevated prompt to add them
automatically. Nothing touches the firewall without that flag. In practice
Windows also offers a one-click "Allow access" prompt the first time the binary
listens, which does the same job.

### If transfers say "via server"

That means ICE could not establish a direct path. Open `/diag` on both devices.
The likely causes, in order:

- **Both hosts block inbound UDP to the browser.** Chrome and Edge normally
  install their own allow rules, but a locked-down machine may not have them.
- **WiFi client isolation.** Many guest and enterprise access points block all
  station-to-station traffic at layer 2. Discovery still works because both
  devices can reach S, but the direct path never will. Nothing on the client can
  fix this; either use a different network or accept the relay.
- **The two devices are on different subnets.** They will not even see each
  other, since rooms are keyed by the client's /24. `/diag` shows which room
  each device landed in.

Relaying is correct, just slower: the data makes two hops and consumes the
server's bandwidth instead of one hop between peers.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--addr` | `0.0.0.0` | Interface to bind |
| `--port` | `8080` | TCP port for the site and WebSocket |
| `--stun-port` | `3478` | UDP port for STUN; `0` disables it |
| `--token` | none | Shared secret; clients must open the site with `?t=<token>` |
| `--tls` | off | Serve HTTPS with a self-signed certificate |
| `--install-firewall-rule` | off | Add the inbound rules and exit (needs elevation) |

### Subcommands

| Command | Meaning |
| --- | --- |
| `lanshare version` | Print the build version and exit |

## Releases

Pushing a git tag that matches `v*` (for example `v0.0.1`) triggers a GitHub
Actions workflow that builds and publishes binaries for Linux, macOS, and
Windows, each for both amd64 and arm64. The tag becomes the value printed by
`lanshare version`.

```bash
git tag v0.0.1
git push origin v0.0.1
```

### About `--tls`

On plain HTTP a received file is assembled as a Blob before being handed to the
browser's downloader. Chrome pages large blobs to disk, so multi-gigabyte
transfers still work, but the data does pass through memory first.

`--tls` makes the page a secure context, which unlocks `showSaveFilePicker` and
lets single-file transfers stream straight to disk. The cost is that each
browser shows a certificate warning once, since the certificate is self-signed.
The certificate is generated in memory at startup and covers localhost plus
every LAN address.

Note that the browser on S itself always gets a secure context via
`http://localhost`, with or without the flag.

## Diagnostics

`/diag` reports what each side can actually see:

- Which ICE candidate types this browser gathered, and whether STUN answered
- Whether this browser is a secure context and can stream saves to disk
- The server's LAN addresses, ports, and how many STUN requests it has answered
- Which room each connected peer landed in
- Relay session count and total relayed bytes

## Security

LanShare is a LAN tool with no authentication by default. Anyone who can reach
the port can see the roster and send files to it. Use `--token` on a network you
do not control. Peers are only ever addressable within their own subnet room, so
a client on another subnet cannot signal or relay to yours.

Payload on the direct path is encrypted by DTLS, which WebRTC mandates. Payload
on the relay path is not encrypted beyond whatever the transport provides, so
use `--tls` if the relay path matters to you.

## Layout

```
main.go                      flags, listeners, startup banner, self-signed cert
internal/server/             HTTP routes, signaling hub, relay routing
internal/stun/               RFC 5389 Binding responder
internal/netinfo/            LAN address discovery and subnet rooms
internal/names/              deterministic peer names
internal/firewall/           inbound rule inspection and opt-in creation
web/                         the app, embedded into the binary with go:embed
```

## Tests

```bash
go test ./...
```

Covers the STUN wire format including the XOR-MAPPED-ADDRESS round trip, roster
join and leave, verbatim SDP forwarding, and the relay path end to end with
session teardown.
