# Cross-Platform Client Runtime Research

- Reviewed: 2026-09-04
- Scope: loopback control and self-contained packaging boundary
- Status: Client and Local composition implemented; Windows native Host video
  and a cross-NAT media gate proved

## Reusable Evidence

| Project | Observed boundary | Applicable lesson |
| --- | --- | --- |
| Discord RPC | Bounded local endpoints and an explicit handshake | Discovery and session negotiation can stay small |
| OBS WebSocket | Versioned `Hello`/`Identify` before commands | Reject unknown protocol shapes instead of adding compatibility readers |
| Syncthing | Go process with a loopback Browser GUI by default | A native entry and system-Browser UI are a practical cross-platform pair |
| Sunshine | Native streaming host configured through a localhost Browser UI | Native media does not require a second desktop UI |
| LocalSend | One peer exposes a local HTTP service without an external server | LAN operation can be self-contained, while network reachability remains physical |

These are architecture references only. No implementation or copyleft source is
copied.

A read-only inventory of locally installed streaming clients adds one practical
constraint. GameViewer separates its UI, supervised media service, codec
capability detector, streamer, health process, and updater. Discord keeps its
Chromium UI separate from a native voice/media module and updater. Oopz ships
Flutter, a second WebView, FFmpeg, Agora RTC, and Tencent LiteAV together; that
stack is substantially larger and duplicates media ownership. Screener follows
the first two products' process separation but not their UI runtimes, and avoids
Oopz's parallel RTC stacks: one Go supervisor, one Pion media core, and one thin
system capture sidecar per platform remain sufficient. No binary code or private
application data was copied or inspected.

## Current Control Boundary

The Client binds IPv4 loopback on a bounded range (`39721`-`39730`). `/health`
returns the protocol version, service identity, selected port, and an
`instanceToken`. `/control` admits one WebSocket session whose subprotocol
contains that same value. The first frame must be `hello`; subsequent requests
are limited to capability discovery, source preview, and one generation-fenced
share's media controls.

The instance token distinguishes a newly discovered process from a stale or
unrelated listener. It is visible through health and stdout and is not an
authentication secret. Host and Origin checks plus Chromium's Local Network
Access permission form the Browser boundary.

The current protocol advertises only the native capabilities and
generation-fenced media commands that have consumers. It carries no room
credentials or route policy; those stay in the Browser/server protocol.

## Client Composition

The existing TypeScript server owns the room and route contract. A local package
therefore composes three artifacts behind one user entry:

```text
screener-client
runtime/node
app/dist
```

The Client's Go entry starts and supervises the pinned Node runtime in Local
mode; Node serves the same Screener application with explicit local
configuration. In Site mode the system Browser opens the saved Site while the
same Go process remains its loopback native-media owner. The system Browser
remains the UI.

Official Go process APIs require every started child to be waited and provide a
bounded `WaitDelay` for cancellation and stuck I/O. The current supervisor uses
stdin EOF for graceful Node shutdown, waits for the child, and does not restart
it. Windows is physically exercised; macOS and Linux remain package gates.

## Local And Hosted Reachability

A local page completed discovery and the full control exchange in Chromium
151.0.7922.138. The hosted Screener origin completed it after Chromium received
its `loopback-network` permission; without that permission the cross-origin
request was blocked. The gate checks both expected outcomes.

A self-contained LAN room uses a localhost Host URL and a selected LAN IPv4
Viewer URL backed by the same local TypeScript process. Its generated access
password is persisted once and passed only to the Client's Host page in a
consumed fragment. Explicit `--link` mode launches the packaged Cloudflare Quick
Tunnel against that same local HTTP server and supplies its random HTTPS origin
to Node before startup. The public path therefore reuses the exact frontend,
WebSocket signaling, RoomStore, and Viewer grant instead of adding a rendezvous
or second client protocol. Cloudflare carries control traffic; WebRTC media uses
public STUN and remains P2P-only.

## UI Runtime Boundary

The current Client opens the system Browser rather than embedding another Web
runtime. A lightweight launcher chooses the authority mode, then navigates to
the same Host page, where a Client-launched Host can select an exact native
window. This keeps the existing UI, Site cookies, WebRTC behavior, Browser
updates, and permission model intact. Syncthing and Sunshine establish this as a
practical native-process plus Browser-UI deployment shape.

An embedded shell remains a decision gate rather than a rejected category.
Current WebView2 exposes `getDisplayMedia` screen-capture events and its
Evergreen runtime updates independently; WebKitGTK exposes display capture and
uses GStreamer for WebRTC. Electron instead bundles one Chromium and Node but
makes the Client responsible for shipping those updates and adds substantial
package size. These facts do not prove equivalent Screener media behavior.

Only a reproduced Browser-launch failure should open a comparative physical
gate for Electron, Tauri, Wails, Neutralino, or another shell. That gate must
compare actual capture, audio, H.264/VP8 sender implementation, 1080p cadence,
relay, background behavior, and resource use on every target platform. The
result selects one UI runtime; it does not create parallel products.

## Current Evidence

On Windows with Chrome for Testing 151.0.7922.138:

- the Local Client started its built static application and reached `/healthz`;
- the Host fragment was removed, existing SiteAccess became authenticated, and
  the ordinary Host page loaded;
- the room API generated an invitation from the selected LAN origin;
- one synthetic Host and three Viewers formed a P2P-only tree with one relay,
  every Viewer advanced decoded frames, and no SFU publication appeared; and
- Enter-driven Client shutdown released the Browser, Client, Node, loopback and
  application ports, and disposable profile.
- the immutable App release was assembled with Node 24.19.0 and the Go Client
  from the same full revision; that packaged directory passed the Local and Site
  gates, while a deliberately mismatched `app/REVISION` was rejected before a
  listener started.
- the explicit target assembler produced Windows amd64, Linux amd64, and macOS
  arm64 outputs from one clean revision. The Linux package ran its bundled Node
  Local authority on Ubuntu, and its full package exposed and then closed a
  public link reachable from another network. The macOS Client and Node inputs
  are both Mach-O arm64; execution there remains unproved.
- the native Host path created a Local room and a remote Pion Viewer received
  30 packets over a selected `srflx`-to-`srflx` pair; the reverse SSH link in
  that gate carried signaling only.
- a Windows Client created an accountless Quick Tunnel, generated its ordinary
  invitation on that origin, and served the Viewer page plus `/signal` WebSocket
  upgrade to an independent Linux host; a native Host then repeatedly delivered
  30+ H.264 RTP packets to a Linux Pion Viewer over selected direct paths using
  a reflexive candidate. Stopping the Client closed the URL.

The one-link gate used the official Windows amd64 `cloudflared` 2026.8.3 asset
with SHA-256 `83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae`.
The sidecar remains an explicit package input rather than a linked Client
dependency.

The peer topology gate now treats native `getStats()` RTP identity and frame
totals as its portable core proof. Detailed Screener quality metrics enrich a
development run when its source module is served, but their absence on a static
deployment no longer erases valid native RTCStats.

## Remaining Gates

- Run the exact clean-revision package on macOS; Linux amd64 is proved.
- Prove a physical second-device LAN Viewer on desktop, Android, and iOS.
- Prove first-run Browser local-network permission outside CDP automation.
- Record no-STUN mDNS behavior on ordinary and AP-isolated LANs.
- Exercise the native Host on a configured Site and representative Browsers;
  the local SFU bridge is proved in isolation, while full Site recovery,
  representative audio, and non-Windows capture remain undefined.
- Exercise one-link Browser media on a physical second device; the current gate
  proves the complete public control path and independent Pion media, not
  decoded Browser frames.

## Sources

- [Go `os/exec`](https://pkg.go.dev/os/exec)
- [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections)
- [Cloudflare public STUN endpoint](https://developers.cloudflare.com/realtime/turn/)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Tunnel WebSockets](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
- [cloudflared releases](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.3)
- [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html)
- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [Microsoft Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [Apple SCContentSharingPicker](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker)
- [XDG ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [OBS window-capture source](https://github.com/obsproject/obs-studio/blob/master/plugins/win-capture/window-capture.c)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Discord RPC](https://docs.discord.com/developers/topics/rpc)
- [OBS WebSocket](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
- [LocalSend protocol](https://github.com/localsend/protocol/blob/main/README.md)
- [Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/)
- [Syncthing GUI configuration](https://docs.syncthing.net/users/config.html)
- [GameViewer product](https://uuyc.163.com/)
- [Discord desktop architecture](https://discord.com/blog/how-discord-maintains-performance-while-adding-features)
- [WebView2 Evergreen runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)
- [WebView2 screen capture](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs)
- [WebKitGTK multimedia](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Multimedia.html)
- [WebKitGTK display capture](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebView.html)
- [Electron architecture](https://www.electronjs.org/docs/latest/why-electron)
