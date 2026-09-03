# ADR-0010: Cross-Platform Client Runtime

- Status: accepted Client/Local foundation and Windows native Host media boundary
- Date: 2026-09-03

## Context

The Browser is the current Screener interaction surface, but it cannot own native
capture, hardware encode, or reusable native sockets. A self-contained package
must add those capabilities without creating another room model, signaling
protocol, route controller, or UI.

Existing Screener room, admission, signaling, and routing behavior already has
one TypeScript implementation. Rewriting that behavior in the Helper would make
Hosted and Local deployments diverge without improving the media path.

## Decision

1. The TypeScript/Node core remains the sole owner of HTTP, room authority,
   admission, signaling, and routing in every deployment. A future local package
   runs that same server and the same built Browser assets with local
   configuration; Go does not reimplement the product core.
2. The packaged product is Screener Client. Its Go process is the one
   cross-platform user entry and future native-media owner.
   Its current process exposes `/health` and one `/control` WebSocket on IPv4
   loopback within ports `39721` through `39730`.
3. Discovery returns a per-process `instanceToken`. The WebSocket subprotocol
   echoes it so the Browser connects to the process it discovered. This value is
   public process identity, not authentication. Origin and Host validation plus
   the Browser's local-network permission own the current Browser boundary.
4. Loopback v2 starts with a strict `hello` handshake. Health discovery reports
   only separately probed native capture booleans. An active control session may
   list local capture choices and own one share's generation-fenced SDP/ICE
   edges; it carries no room password, Host token, Viewer grant, or route policy.
   The Browser forwards current Site signaling and remains the participant.
5. A platform package contains the Go entry, a pinned Node runtime, and the same
   server/client build used by Hosted Screener. A Windows package may also carry
   one process-isolated capture binary. The Go entry supervises child processes
   with bounded lifetime. Platform packaging is metadata around that entry, not
   another long-running wrapper or UI.
6. The system Browser remains the UI. Browser extensions, userscripts, Electron,
   Tauri, and resident services need new evidence before they can replace this
   smaller boundary.
7. A self-contained local deployment may serve reachable LAN peers without a
   central Screener service. Public-Internet use still needs persistent
   signaling and a reachable ICE path; removing a server does not create either.
   Cross-network Local use requires either explicit Client-to-Client pairing or
   an independently accepted rendezvous; a configured Site remains a different
   deployment mode.
8. Native media is selected for an entire Host share generation. One isolated
   platform capture feeds one encoded source and bounded independent Pion
   transports, with process-loopback audio sharing the same PeerConnection when
   available. Native quality evidence must either map real encoder/transport
   observations into the existing categorical contract or remain ineligible for
   quality convergence. It does not introduce a custom score.
9. The Client currently uses the system Browser as its only UI. With no saved
   Site it supervises the same TypeScript server in Local mode; with a saved
   Site it opens that origin while retaining the loopback runtime. An embedded
   shell requires a reproduced product failure and one comparative decision.
10. Local mode is one explicit server composition: static current assets,
    memory-only rooms, peer-assisted media, no SQLite, no SFU, no STUN/NAT
    prediction, and localhost plus current LAN IPv4 origins. It changes no
    Hosted shutdown or persistence behavior.
11. One Client configuration owns the optional Site origin and a generated
    Local access password. The Client bootstraps its own Host page through a
    fragment that is consumed before authentication; friends use the existing
    room invitation grant. No Client-specific authorization system is added.
12. Local authority shutdown first ends every in-memory room through the current
    `room-closed` path, then closes signaling and HTTP. The Go supervisor closes
    Node stdin, waits, and applies one bounded process timeout. It does not
    restart a vanished authority.
13. Client assembly consumes the immutable Web/Server application release from
    the same full Git revision. The Go binary, bundled Node runtime, and
    `app/REVISION` form one package; revision mismatch fails rather than loading
    a stale private contract.

## Consequences

Hosted and Local operation share one product contract and one route model. The
Go runtime acts as the Client's native-media owner when a Site or Local page
discovers it, but it is not a second room product. It stays small until a
proven native capability needs a protocol field. The local package may contain
two internal processes while presenting one user entry; the supervisor, not a
compatibility protocol, owns their lifetime.

Windows gates prove loopback discovery, Local static startup, automatic Host
access, LAN invitation construction, a three-Viewer Browser relay tree, two
process-isolated hardware-H.264/Pion edges sharing one encoded source and
decoded by Chrome, and bounded process cleanup. The native Host path now uses
  the current Browser route and a remote Pion gate has received video over a
  direct `srflx`-to-`srflx` pair. A Windows Browser gate also receives
  process-loopback Opus on both native edges. Native SFU/quality evidence,
  other platform capture, and no-Site Internet rendezvous remain separate
  gates.

## Primary Sources

- [Go child-process lifecycle](https://pkg.go.dev/os/exec)
- [WebRTC peer connections and signaling](https://webrtc.org/getting-started/peer-connections)
- [RFC 6455 WebSocket Origin model](https://www.rfc-editor.org/rfc/rfc6455.html)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Discord local RPC](https://docs.discord.com/developers/topics/rpc)
- [OBS WebSocket protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
- [LocalSend protocol](https://github.com/localsend/protocol/blob/main/README.md)
- [Sunshine local Web UI](https://docs.lizardbyte.dev/projects/sunshine/latest/)
- [Syncthing local GUI/API](https://docs.syncthing.net/users/config.html)
- [Native Client media evidence](../research/native-client-media.md)
