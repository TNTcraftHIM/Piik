# ADR-0010: Cross-Platform App Runtime

- Status: accepted capability-provider architecture and native endpoint media boundary
- Date: 2026-09-05
- Superseded in part: items 1, 5, 7, 12 (its supervisor sentence), 13, 14, and
  the local-package consequence were amended in place by
  [ADR-0012](./0012-shared-go-backend-core.md), which replaced the TypeScript
  server with one shared Go core.
- [ADR-0013](./0013-embedded-node-local-media.md) supersedes item 8's single-output,
  Pion-GCC-observation-only and Browser-mediated LiveKit publisher details for
  the current candidate. The shared encoded-media adapter and direct Native SFU
  publisher preserve this ADR's participant and capability boundaries. The
  independent bounded control-session contract remains current; historical
  acceptance below does not validate the new media implementation.

## Context

The Browser is the current Piik interaction surface, but it cannot own native
capture, hardware encode, or reusable native sockets. A self-contained package
must add those capabilities without creating another room model, signaling
protocol, route controller, or UI.

Existing Piik room, admission, signaling, and routing behavior already has
one TypeScript implementation. Rewriting that behavior in the Helper would make
Hosted and Local deployments diverge without improving the media path.

Room authority and local media capability are independent choices. A room may
come from Local, a temporary public link, or a configured Site while each
participant independently uses Browser media or available App capability.
Binding these choices into exclusive App modes prevents mixed Browser/Native
topologies and makes a saved Site unavailable while another room source runs.

## Decision

1. One shared core is the sole owner of HTTP, room authority, admission,
   signaling, and routing in every deployment. The local package runs that same
   core and the same built Browser assets with local configuration; no
   deployment gets a second product core. Its implementation is owned by
   [ADR-0012](./0012-shared-go-backend-core.md).
2. The packaged product is Piik App. Its Go process is the cross-platform
   entry and native capability provider. It starts `/health` and one `/control`
   endpoint on IPv4 loopback within ports `39721` through `39730` before room-
   source selection and retains them until the process exits.
3. Discovery returns a per-process `instanceToken`. The WebSocket subprotocol
   echoes it so the Browser connects to the process it discovered. This value is
   public process identity, not authentication. The listener accepts the current
   Local Host origin and the one user-saved Site origin. Origin and Host
   validation plus the Browser's local-network permission own this boundary.
4. Loopback v9 starts with a strict `hello` handshake. Up to two participant
   control sessions may coexist; each retains its own share and media lifetime.
   This bounds concurrent Native work, not the shared server's room count.
   Ending one control session cannot end another; App exit waits for all
   owned sessions to retire. Health discovery reports
   only separately probed native capture booleans. Native Viewer receive/NAT
   remains available when capture or hardware encode is absent. An active control session may
   list local screen/window choices, request bounded previews, and own one share's generation-fenced SDP/ICE
   edges, including at most one loopback media bridge outside route-copy
   capacity; it carries no room password, Host token, Viewer grant, or route
   policy. An activated participant tab opens this connection lazily on its first
   native action, reuses it across successive media generations, and closes it
   with the page; a picker, share, or room source does not own the socket. The
   Browser forwards current signaling and remains the participant.
5. A platform package contains one Go executable carrying the same core and
   embedded Browser assets used by Hosted Piik. It may also carry one
   process-isolated capture binary and the pinned `cloudflared` sidecar. Those
   sidecars are the only supervised children and keep their bounded lifetime.
   Platform packaging is metadata around that entry, not another long-running
   wrapper or UI.
6. The system Browser remains the UI. Browser extensions, userscripts, Electron,
   Tauri, and resident services need new evidence before they can replace this
   smaller boundary. An App-opened Site stores a non-secret opt-in at that
   exact Browser origin, so later manually opened pages may discover the running
   App. Pages without that opt-in do not probe localhost or request local-
   network permission. Clearing Site data simply requires opening it from the
   App again.
7. A self-contained Local deployment serves reachable LAN peers without a
   central Piik service. Its explicit `--link` mode starts one accountless
   Cloudflare Quick Tunnel for the same HTTP/WebSocket surface. The App
   reserves the exact IPv4 listener before creating that tunnel, then applies
   its HTTPS origin before the server starts serving that listener. It retains the same
   memory RoomStore, Browser UI, Viewer grant, signaling, and route controller.
   The Host sends the ordinary invitation link and the Viewer needs only a
   Browser. Cloudflare terminates this temporary control path; WebRTC media stays
   P2P and uses public STUN. The link ends with the App and is not a persistent
   Site, SFU, or TURN fallback.
8. Browser and Native are local media adapters beneath the same authenticated
   participant, connection identity, copy capacity, and committed route graph.
   Browser-to-Browser, Native-to-Browser, and Native-to-Native edges use the same
   WebRTC signaling contract. Native media currently covers the Host adapter;
    Viewer receive/relay follows the same boundary rather than adding a second
    participant or route protocol. A Native Viewer accepts only a negotiated
    H.264/VP8 and Opus offer, forwards encoded RTP into bounded local sources, and uses
    the existing Browser bridge for playback; compatible child edges reuse those
    sources. Unsupported media or a failed native bridge falls back to the
    existing Browser peer. One isolated
   platform capture feeds one encoded source and bounded independent Pion
   transports, with process-loopback audio for windows or system-loopback audio
   for screens sharing the same PeerConnection when available. Each Site or one-link share makes one bounded, best-effort PCP,
   UPnP, or NAT-PMP mapping for that same Pion UDP socket before its first edge
   gathers ICE; pure LAN Local mode does not. Once ordinary STUN observes a
   public address, Native advertises the mapped port as one lower-priority,
   srflx-shaped candidate on that address. Absence or rejection leaves ordinary
   ICE/STUN unchanged. Native P2P quality uses Pion's transport-wide
   GCC estimate only after feedback and source-frame progress, comparing its
   target payload bitrate with the measured encoded payload supplied to that
   edge. The existing route evidence windows own persistence; no custom score,
   second adaptation policy, or queued pacer is introduced. The one loopback
   edge supplies Host preview and the existing Browser LiveKit publisher. It
   neither consumes route-copy capacity nor starts port mapping; an assigned SFU
   publication still consumes its existing route copy. Native code does not
   implement LiveKit or another representation policy. The App discovers
   packaged capture capability at startup. Its Host page offers the Browser's
   standard picker and each exact App-owned screen/window; the user must select one
   and the App never guesses a target. The same room quality settings select
   native capture size, frame rate, video/audio bitrate, and the platform
   encoder's quality-versus-speed hint. A live quality or source change prepares
   a replacement capture/encoder generation and swaps it behind the existing
   Pion source; room, route, and PeerConnections do not change. Windows uses
   Graphics Capture, Media Foundation, and WASAPI; macOS uses ScreenCaptureKit,
   VideoToolbox, and AudioToolbox; Linux uses the ScreenCast Portal, PipeWire,
   and an installed GStreamer hardware-H.264 element. These adapters end at the
   same bounded encoded-frame protocol and do not own WebRTC or product state.
   The shared Native encode is the normal path. For a persistently degraded
   Native sender edge, the existing quality operation may prepare an overlapping
   stock Browser sender from the stable local bridge; existing evidence alone
   decides commit or rollback, and a later operation may return to Native. No
   extra threshold, timer, score, route operation, or representation ladder is
   added. Only a consumed App-launch marker travels in the URL fragment.
   Exact target identity travels over loopback.
9. The App uses the system Browser as its only UI. On every launch, the current
   lightweight control center offers Local, public link, and Site. The Site value
   is stored in App configuration and remains one click on later launches;
   selecting Local or public link does not disable background RPC access for the
   saved Site. Command-line mode
   selectors remain automation inputs rather than the normal interface. An
   embedded shell requires a reproduced product failure and one comparative
   decision.
10. Local mode is one explicit server composition: static current assets,
    memory-only rooms, peer-assisted media, no SQLite or SFU, and localhost plus
    current LAN IPv4 origins. It uses no public discovery by default. Public-link
    mode adds its temporary HTTPS origin, one ordinary public STUN destination,
    and two bounded public survey destinations. Site mode consumes that Site's
    configured STUN survey. Both feed the same connection-local prediction
    adapter; Native additionally owns its UDP socket and best-effort port mapping.
11. One App configuration owns the optional Site origin and an optional,
    user-chosen Local access password. A blank value leaves the Local site open;
    a value gates that site through the existing SiteAccess authority. The
    App bootstraps a selected page through a fragment consumed before
    authentication; the page retains only the non-secret App opt-in at its
    origin. Friends use the existing room invitation grant. No App-specific
    room authorization system is added.
12. Local authority shutdown first ends every in-memory room through the current
    `room-closed` path, then closes signaling and HTTP. The App cancels the
    server context, calls that end-then-close sequence under one bounded
    timeout, and only then closes the public tunnel and the loopback service. It
    does not restart a vanished authority.
13. App assembly consumes the immutable application release from the same full
    Git revision and an explicit supported target. The Go binary embeds that
    release's built Browser assets and the package `REVISION` records the same
    revision; a revision mismatch fails rather than loading a stale private
    contract. App-scoped pull requests build every
    target and must start the assembled Local authority, pass `/healthz`, and
    stop it cleanly before the candidate is accepted.
14. The root package manifest is the single dependency contract for the Browser
    bundle and repository tooling. No host installs packages to run Piik, so
    the manifest has no runtime half, and no second App dependency list or
    post-install package surgery is used.

## Consequences

Hosted and Local operation share one product contract and one route model. The
Go runtime acts as an optional capability provider when an activated Site or
Local page discovers it, but it is not a second room product. A mixed room does
not expose endpoint implementation to routing policy. The runtime stays small until a
proven native capability needs a protocol field. The local package presents one
user entry and runs its room authority inside that same process; only the
optional capture and tunnel sidecars remain supervised children, and that entry,
not a compatibility protocol, owns their lifetime.

Windows gates prove loopback discovery, Local static startup, automatic Host
access, LAN invitation construction, a three-Viewer Browser relay tree, two
process-isolated hardware-H.264/Pion edges sharing one encoded source and
decoded by Chrome, and bounded process cleanup. The native Host path uses the
current Browser route; its explicit in-page window picker also passes source
end, same-room reselection, and restored Viewer delivery. A remote Pion gate has
received 30+ H.264 RTP packets over a selected direct
`srflx`-to-`srflx` pair; this proves packet delivery, not decoded Browser video.
A Windows Browser gate also receives process-loopback
Opus on both native edges. A separate remote gate proves that `--link` generates
the ordinary public invitation and carries the unchanged Viewer page and
WebSocket control path, then disappears when the App exits. An isolated
LiveKit gate also proves native capture through the loopback Browser bridge and
the existing SFU publisher, including a live 1080p-to-480p profile change and
complete cleanup.
A Browser-Host-to-Native-Viewer gate additionally proves that the Viewer claims
the v8 App control session and Chrome decodes the 1280x720 source; the encoded
downstream edge has a separate H.264/Opus RTP integration gate.
One-link Browser media and physical non-Windows capture remain separate gates.
GitHub runners compile all three platform adapters. The macOS arm64 sidecar also
creates a hardware-only VideoToolbox encoder and produces a constrained-baseline
SPS/PPS/IDR; its ScreenCaptureKit video/audio permission, source lifecycle,
static-screen recovery, and endurance still require a physical Mac. The Linux
candidate probes and packages its Portal/PipeWire/GStreamer adapter, while a
real desktop, hardware encoder, system audio, and lifecycle still require a
physical Linux gate. Source previews remain best-effort on both platforms.

The v8 loopback gate also proves that a real Chrome receiver produces Pion
transport feedback and that a non-unknown native sender-quality window reaches
the existing route controller. Unknown feedback and stopped-source windows stay
ineligible.

The local trust boundary is intentionally per-user: the instance token identifies
the running App but is not authentication against another local process.

A physical home-router gate created and removed a UPnP mapping for an ephemeral
UDP listener. The integrated native Host gate still passed capture, two-edge
delivery, source restart, and cleanup with mapping enabled. The mapped port is
now advertised on the observed public address; a selected mapped path across a
pair that fails with STUN alone remains field evidence rather than an
architectural claim.

## Primary Sources

- [Go child-process lifecycle](https://pkg.go.dev/os/exec)
- [WebRTC peer connections and signaling](https://webrtc.org/getting-started/peer-connections)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Tunnel WebSocket support](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
- [RFC 6455 WebSocket Origin model](https://www.rfc-editor.org/rfc/rfc6455.html)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Discord local RPC](https://docs.discord.com/developers/topics/rpc)
- [OBS WebSocket protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
- [LocalSend protocol](https://github.com/localsend/protocol/blob/main/README.md)
- [Sunshine local Web UI](https://docs.lizardbyte.dev/projects/sunshine/latest/)
- [Syncthing local GUI/API](https://docs.syncthing.net/users/config.html)
- [Native App media evidence](../research/native-client-media.md)
