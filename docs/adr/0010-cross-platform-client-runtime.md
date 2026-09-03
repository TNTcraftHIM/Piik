# ADR-0010: Cross-Platform Client Runtime

- Status: accepted Client/Local foundation and Windows native Host media boundary
- Date: 2026-09-04

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
4. Loopback v5 starts with a strict `hello` handshake. Health discovery reports
   only separately probed native capture booleans. An active control session may
   list local screen/window choices, request bounded previews, and own one share's generation-fenced SDP/ICE
   edges, including at most one loopback media bridge outside route-copy
   capacity; it carries no room password, Host token, Viewer grant, or route
   policy. The Browser forwards current Site signaling and remains the
   participant.
5. A platform package contains the Go entry, a pinned Node runtime, and the same
   server/client build used by Hosted Screener. It may also carry one process-
   isolated capture binary and the pinned `cloudflared` sidecar. The Go entry
   supervises child processes with bounded lifetime. Platform packaging is
   metadata around that entry, not another long-running wrapper or UI.
6. The system Browser remains the UI. Browser extensions, userscripts, Electron,
   Tauri, and resident services need new evidence before they can replace this
   smaller boundary.
7. A self-contained Local deployment serves reachable LAN peers without a
   central Screener service. Its explicit `--link` mode starts one accountless
   Cloudflare Quick Tunnel for the same Node HTTP/WebSocket surface, injects the
   resulting HTTPS origin before Node starts, and otherwise retains the same
   memory RoomStore, Browser UI, Viewer grant, signaling, and route controller.
   The Host sends the ordinary invitation link and the Viewer needs only a
   Browser. Cloudflare terminates this temporary control path; WebRTC media stays
   P2P and uses public STUN. The link ends with the Client and is not a persistent
   Site, SFU, or TURN fallback.
8. Native media is selected for an entire Host share generation. One isolated
   platform capture feeds one encoded source and bounded independent Pion
   transports, with process-loopback audio for windows or system-loopback audio
   for screens sharing the same PeerConnection when available. Each Site or one-link share makes one bounded, best-effort PCP,
   UPnP, or NAT-PMP mapping for that same Pion UDP socket before its first edge
   gathers ICE; pure LAN Local mode does not. Absence or rejection leaves
   ordinary ICE/STUN unchanged. Native P2P quality uses Pion's transport-wide
   GCC estimate only after feedback and source-frame progress, comparing its
   target payload bitrate with the measured encoded payload supplied to that
   edge. The existing route evidence windows own persistence; no custom score,
   second adaptation policy, or queued pacer is introduced. The one loopback
   edge supplies Host preview and the existing Browser LiveKit publisher. It
   neither consumes route-copy capacity nor starts port mapping; an assigned SFU
   publication still consumes its existing route copy. Native code does not
   implement LiveKit or another representation policy. The Client discovers
   packaged capture capability at startup. Its Host page offers the Browser's
   standard picker and each exact Client-owned screen/window; the user must select one
   and the Client never guesses a target. Only a consumed Client-launch marker
   travels in the URL fragment. Exact target identity travels over loopback.
9. The Client uses the system Browser as its only UI. A lightweight loopback
   launcher selects Local, one-link, or a saved Site before starting that
   composition, then navigates into the same application. Command-line mode
   selectors remain automation inputs rather than the normal interface. An
   embedded shell requires a reproduced product failure and one comparative
   decision.
10. Local mode is one explicit server composition: static current assets,
    memory-only rooms, peer-assisted media, no SQLite, no SFU, no NAT prediction,
    and localhost plus current LAN IPv4 origins. It uses no STUN by default;
    `--link` adds its exact temporary HTTPS origin and Cloudflare's public STUN
    to existing Browser media edges. It changes no Hosted shutdown or
    persistence behavior.
11. One Client configuration owns the optional Site origin and a generated
    Local access password. The Client bootstraps its own Host page through a
    fragment that is consumed before authentication; friends use the existing
    room invitation grant. No Client-specific authorization system is added.
12. Local authority shutdown first ends every in-memory room through the current
    `room-closed` path, then closes signaling and HTTP. The Go supervisor closes
    Node stdin, waits, and applies one bounded process timeout. It does not
    restart a vanished authority.
13. Client assembly consumes the immutable Web/Server application release from
   the same full Git revision and an explicit supported target. The Go binary,
   matching target Node runtime, and `app/REVISION` form one package; revision
   mismatch fails rather than loading a stale private contract. Client-scoped
   pull requests build every target and must start the assembled Local authority,
   pass `/healthz`, and stop it cleanly before the candidate is accepted.
14. The root package manifest is the single build/runtime dependency contract:
    Browser-only libraries stay in `devDependencies`, while release and Client
    assembly install the same manifest with `--omit=dev` for the server runtime.
    No second Client dependency list or post-install package surgery is used.

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
decoded by Chrome, and bounded process cleanup. The native Host path uses the
current Browser route; its explicit in-page window picker also passes source
end, same-room reselection, and restored Viewer delivery. A remote Pion gate has
received video over a direct
`srflx`-to-`srflx` pair. A Windows Browser gate also receives process-loopback
Opus on both native edges. A separate remote gate proves that `--link` generates
the ordinary public invitation and carries the unchanged Viewer page and
WebSocket control path, then disappears when the Client exits. An isolated
LiveKit gate also proves native capture through the loopback Browser bridge and
the existing SFU publisher to 1280x720 Viewer playback with complete cleanup.
Physical macOS capture, Linux native capture, and one-link Browser media remain
separate gates.

The macOS arm64 capture sidecar compiles on GitHub `macos-15` and its
permission-free VideoToolbox self-test produces a constrained-baseline SPS/PPS/
IDR. Real ScreenCaptureKit permission, source lifecycle, static-screen recovery,
and endurance remain physical acceptance gates. Source previews are best-effort;
the current macOS sidecar falls back to its source glyph until a physical
ScreenCaptureKit preview gate justifies a platform-specific implementation.

The v5 loopback gate also proves that a real Chrome receiver produces Pion
transport feedback and that a non-unknown native sender-quality window reaches
the existing route controller. Unknown feedback and stopped-source windows stay
ineligible.

A physical home-router gate created and removed a UPnP mapping for an ephemeral
UDP listener. The integrated native Host gate still passed capture, two-edge
delivery, source restart, and cleanup with mapping enabled. A selected mapped
path across a pair that fails with STUN alone remains field evidence rather than
an architectural claim.

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
- [Native Client media evidence](../research/native-client-media.md)
