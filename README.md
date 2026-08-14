# LanShare

Send files, text, and pasted web pages between two browsers on the same LAN.Transfers
go directly peer-to-peer over WebRTC, and fall back to relaying through the
server when a firewall blocks the direct path.

run lanshare on a separated server, or on one of file transferring peer. 

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

Three roles. **S** runs the lanshare and is the only machine that needs open
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

## Pasted pages and formatted text

"Send text" opens an editable box rather than a plain field. Type in it and a
plain text message is sent, exactly as before. Paste into it from a browser or
from Word and the formatting comes along: headings, lists, tables, links, and
images. What the box shows is what the other device will show, so trim the parts
you do not want before sending.

Images are the reason this is more than a string copy. A page's markup points at
images by URL, and the receiving device usually cannot reach that server, so on
paste every image is fetched and embedded into the message as a `data:` URI.
The result needs nothing from the network, which is what makes it readable on a
device with no internet at all.

- Up to **2 MB** per image and **24 MB** per message. Anything over that is left
  out and reported.
- An image the sender's browser is not allowed to read is left out too, and the
  composer says how many. This is the browser's cross-origin rule: bytes of an
  image from another site are only readable when that site permits it, which
  many image hosts do and many do not.
- Word images pasted from a local document arrive as `file:` references that no
  browser will read. Copy the image itself, or a screenshot, to send it.
- A screenshot on the clipboard can be pasted straight in.

Because embedded images make a message file-sized, formatted text is streamed in
64 KB chunks over the same path files use, with the same progress and
backpressure. One over 2 MB asks the receiver to accept it first.

On the receiving side each message appears in **Received text** with buttons to
copy it with formatting intact, save it as a self-contained `.html` file, and
look at its markup.

### What stops a pasted page from attacking the other device

Rendering markup somebody else sent is the one place this app handles untrusted
content, so it does not rely on any single defence.

- The markup is sanitized against an allowlist twice, once by the sender on
  paste and again by the receiver on arrival. The second pass is the one that
  matters: the sender's assurance is worth nothing. Scripts, frames, objects,
  forms, event handler attributes, `javascript:` URLs, and style sheets are all
  removed.
- It is then rendered in an `iframe` with neither `allow-scripts` nor
  `allow-same-origin`, so it runs no code and sits in an opaque origin that
  cannot see the page around it.
- That frame carries `default-src 'none'` with images restricted to `data:`.
  Every image is already embedded, so nothing legitimate needs the network and
  nothing else gets it. A tracking pixel cannot report that the message was
  opened.
- The markup is never inserted into the app's own page, in either direction.

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
