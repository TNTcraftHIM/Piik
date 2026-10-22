# Cross-Platform App Runtime Research

- Reviewed: 2026-09-04
- Scope: loopback control and self-contained packaging boundary
- Status: App and Local composition implemented; Windows native Host video
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

Piik separates the Browser UI from native capture and media ownership. One Go
process, one Pion media core, and one thin system capture sidecar per platform
remain sufficient; additional UI runtimes or parallel RTC stacks need an actual
consumer and a distinct responsibility.

## Current Control Boundary

The App binds IPv4 loopback on a bounded range (`39721`-`39730`). `/health`
returns the protocol version, service identity, selected port, and an
`instanceToken`. `/control` admits up to two WebSocket sessions whose subprotocols
contain that same value. The first frame must be `hello`; subsequent requests
are limited to capability discovery, source preview, and one generation-fenced
share's media controls.

The instance token distinguishes a newly discovered process from a stale or
unrelated listener. It is visible through health and stdout and is not an
authentication secret. Host and Origin checks plus Chromium's Local Network
Access permission form the Browser boundary.

The current protocol advertises native capabilities and generation-fenced media
commands that have consumers. The Browser also delivers authenticated remote-input
peer identities and their scoped secrets to the native input owner. Room access
credentials and route policy stay in the Browser/server protocol.

## App Composition

The App and Hosted Piik run the same server core, so the local package is
one executable carrying the built Browser assets plus the optional capture and
tunnel sidecars; [the App README](../../cmd/piik-app/README.md) owns
that layout. In Local mode the App runs the server in its own process with
explicit local configuration. While waiting for an approved Site it starts no
room server; the same process remains the Site's loopback native-media owner.
The persistent launcher owns local approval and room startup independently.
The system Browser remains the UI.

Official Go process APIs require every started child to be waited and provide a
bounded `WaitDelay` for cancellation and stuck I/O. That guidance now covers the
capture and cloudflared sidecars only: the room authority is no longer a child
process, and Local shutdown is one bounded in-process sequence that ends rooms
before closing signaling and HTTP. Windows is physically exercised; macOS and
Linux remain package gates.

## Local And Hosted Reachability

A local page completed discovery and the full control exchange in Chromium
151.0.7922.138. The hosted Piik origin completed it after Chromium received
its `loopback-network` permission; without that permission the cross-origin
request was blocked. The gate checks both expected outcomes.

Run `npm run probe:app-loopback` with `PIIK_CLIENT_LOOPBACK_GATE=true`,
`CHROME_PATH`, `PIIK_CLIENT_EXE`, and `PIIK_CLIENT_GATE_SITE_URL` pointing to
the reachable HTTPS Site being tested. Use `PIIK_CLIENT_GATE_GRANT_LOOPBACK=true`
for the permission-granted run; omit it for the permission-blocked run. The gate
uses an isolated App configuration and Browser profile, and rejects navigation
failures or redirects to another origin as acceptance evidence.

A self-contained LAN room uses a localhost Host URL and a selected LAN IPv4
Viewer URL backed by the same local App process. The App persists an
optional user-chosen access password and passes it only to its Host page in a
consumed fragment; a blank value leaves the Local site open. Explicit `--link`
mode launches the packaged Cloudflare Quick
Tunnel against that same local HTTP server and supplies its random HTTPS origin
to the local server configuration before it starts listening. The public path
therefore reuses the exact frontend,
WebSocket signaling, RoomStore, and Viewer grant instead of adding a rendezvous
or second client protocol. Cloudflare carries control traffic; WebRTC media uses
public STUN and remains P2P-only.

## UI Runtime Boundary

The current App opens the system Browser rather than embedding another Web
runtime. A lightweight launcher chooses the authority mode, then navigates to
the same Host page, where an App-launched Host can select an exact native
window. This keeps the existing UI, Site cookies, WebRTC behavior, Browser
updates, and permission model intact. Syncthing and Sunshine establish this as a
practical native-process plus Browser-UI deployment shape.

An embedded shell remains a decision gate rather than a rejected category.
Current WebView2 exposes `getDisplayMedia` screen-capture events and its
Evergreen runtime updates independently; WebKitGTK exposes display capture and
uses GStreamer for WebRTC. Electron instead bundles one Chromium and Node but
makes the App responsible for shipping those updates and adds substantial
package size.

Only a reproduced Browser-launch failure should open a comparative physical
gate for Electron, Tauri, Wails, Neutralino, or another shell. That gate must
compare actual capture, audio, H.264/VP8 sender implementation, 1080p cadence,
relay, background behavior, and resource use on every target platform. The
result selects one UI runtime; it does not create parallel products.

## Current Evidence

The runs below exercised the former Node-bundled package. They retain capture,
discovery and network observations from that revision. Current single-binary
packaging and startup checks follow [App development](../../cmd/piik-app/DEVELOPMENT.md).

On Windows with Chrome for Testing 151.0.7922.138:

- the Local App started its built static application and reached `/healthz`;
- the Host fragment was removed, existing SiteAccess became authenticated, and
  the ordinary Host page loaded;
- the room API generated an invitation from the selected LAN origin;
- one synthetic Host and three Viewers formed a P2P-only tree with one relay,
  every Viewer advanced decoded frames, and no SFU publication appeared; and
- Enter-driven App shutdown released the Browser, App, Node, loopback and
  application ports, and disposable profile.
- the immutable App release was assembled with Node 24.19.0 and the Go App
  from the same full revision; that packaged directory passed the Local and Site
  gates, while a deliberately mismatched `app/REVISION` was rejected before a
  listener started.
- the explicit target assembler produced Windows amd64, Linux amd64, and macOS
  arm64 outputs from one clean revision. The Linux package ran its bundled Node
  Local authority on Ubuntu, and its full package exposed and then closed a
  public link reachable from another network. The macOS App and Node inputs
  are both Mach-O arm64; execution there remains unproved.
- the native Host path created a Local room and a remote Pion Viewer received
  30 packets over a selected `srflx`-to-`srflx` pair; the reverse SSH link in
  that gate carried signaling only.
- a Windows App created an accountless Quick Tunnel, generated its ordinary
  invitation on that origin, and served the Viewer page plus `/signal` WebSocket
  upgrade to an independent Linux host; a native Host then repeatedly delivered
  30+ H.264 RTP packets to a Linux Pion Viewer over selected direct paths using
  a reflexive candidate. Stopping the App closed the URL.

The [App package target inventory](../../scripts/app-package-targets.mjs) owns
the official `cloudflared` version and per-platform archive checksums. The
sidecar remains an explicit package input rather than a linked App dependency.

The peer topology gate now treats native `getStats()` RTP identity and frame
totals as its portable core proof. Detailed Piik quality metrics enrich a
development run when its source module is served, but their absence on a static
deployment no longer erases valid native RTCStats.

### Public Invitation Startup

The pinned cloudflared Quick Tunnel defaults to explicit QUIC, which disables
its HTTP/2 fallback. Piik requests `--protocol auto` and
`--max-edge-addr-retries 0`: try QUIC once, then let cloudflared fall back within
the existing 30-second startup budget. This affects HTTP/WebSocket control only;
media routes, tunnel identity and ordered shutdown keep their existing owners.
DNS failures, API rejection and networks blocking both transports can still fail.
The preceding Quick Tunnel allocation is a single HTTPS request with a 15-second
dependency timeout; failure exits before transport fallback applies. The exit
code alone does not identify that cause. An abnormal exit now retains the latest
sanitized dependency error or plain stderr detail in the existing failure result.
This detail contains the last reported error. Use the same run's `public-tunnel`
diagnostics for the full retained context.
Piik retries a child that exits before readiness, up to four starts with a
one-second pause between starts, all within the same 30-second acquisition
deadline. The previous child, output readers and temporary config retire before
the next start. Cancellation and local setup errors stop acquisition; a ready
tunnel retains its original identity and explicit ordered-close owner.

A 2026-09-21 Windows check used the packaged binary with an isolated UDP sink and
TCP forwarder. The previous arguments timed out at 30 seconds without trying TCP.
The candidate connected in about 11 seconds, served the public page and echoed a
WebSocket message, then joined the child on close. The ordinary-network App link
gate also serves the invitation page and upgrades its WebSocket from an external
US host, then confirms App exit and link retirement. Regional reachability and
long-running connector behavior need separate measurements. Upstream
[Quick Tunnel setup](https://github.com/cloudflare/cloudflared/blob/2026.10.3/cmd/cloudflared/tunnel/quick_tunnel.go)
and [protocol fallback](https://github.com/cloudflare/cloudflared/blob/2026.10.3/supervisor/tunnel.go)
own the dependency behavior. An early-exit fixture confirms fourth-start recovery
and bounded exhaustion. Earlier attempts can consume the deadline before four starts.

A 2026-10-08 Windows check against a deliberately refused local allocation API
confirmed that cloudflared 2026.8.3 emits its final allocation error as plain
stderr even with `--output json`. A JSON-only error reader therefore misses it.
The process boundary retains that detail without changing retries or shutdown;
normal cancellation still stays clean, and late cleanup cannot erase an already
observed failure. The launcher applies its existing redaction and display limit.

The public App log in [#452](https://github.com/TNTcraftHIM/Piik/issues/452),
reviewed on 2026-10-07, records a QUIC timeout followed by a TCP port-7844
connect timeout within that deadline. Fallback ran and both outbound transports
failed. Compare the same endpoint with/without the accelerator to test its
effect on the network path. The attachment ends before capture starts;
the H.264 report needs capture diagnostics.

[HTTP 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)
means Cloudflare cannot find a healthy tunnel connector. App readiness requires
both the assigned origin and a registered connection; later reconnection belongs
to cloudflared, while process exit ends that App's public-link runtime. This
HTTP failure precedes WebRTC candidate exchange and is distinct from media-route
exhaustion on an already reachable site.
The pinned [supervisor](https://github.com/cloudflare/cloudflared/blob/2026.10.3/supervisor/supervisor.go)
uses [indefinite retries with bounded exponential backoff](https://github.com/cloudflare/cloudflared/blob/2026.10.3/retry/backoffhandler.go)
for recoverable edge disconnects. Piik's four-start acquisition limit is not a
four-reconnect limit after readiness. Restarting the Quick Tunnel process would
allocate a new public address rather than repair the old invitation.

### Alternative Invitation Providers

Reviewed 2026-10-16 against provider documentation and upstream discussions.
Keep Quick Tunnel for this phase. The alternatives below remain candidates;
their regional reachability needs direct comparison. Viewers must only open the invitation in a Browser;
requiring their own account, extra software or proxy/network configuration is
outside this path. Operator-managed tunnels belong with self-hosted Sites.

| Candidate | Relevant capability | Cost to Piik's account-free invitation |
| --- | --- | --- |
| [localhost.run](https://localhost.run/docs/forever-free/) | Account-free HTTPS/SSH; the bounded probe below passes Piik HTTP and signaling, including an in-process Go client. | Free domains rotate and are speed-limited. Anonymous reconnection changed the URL; the cold page load was slow. |
| [Pinggy](https://pinggy.io/) | Account-free temporary tunnels and several global regions. | Free tunnels expire after 60 minutes and show a [browser screening page](https://pinggy.io/docs/http_tunnels/screening/). Paid service changes that boundary. |
| [ngrok](https://ngrok.com/docs/pricing-limits/free-plan-limits) | Account-bound domains; free endpoints have no session timeout. | Account/token setup, usage quotas and a browser interstitial prevent a transparent free replacement. |
| [cpolar](https://www.cpolar.com/docs) | HTTP(S), WebSocket and selectable mainland/Hong Kong regions. | Requires account/token setup; free addresses may change within 24 hours. Check access from the intended ISP. |
| [frp](https://gofrp.org/en/docs/overview/) | Open-source HTTP(S) forwarding with operator-selected hosting. | Someone must run the public endpoint, domain/TLS and admission. It is not a hosted, account-free service by itself. |

The pinned cloudflared has two separate proxy gaps: [Quick Tunnel allocation](https://github.com/cloudflare/cloudflared/blob/2026.10.3/cmd/cloudflared/tunnel/quick_tunnel.go)
constructs an HTTP transport without `ProxyFromEnvironment`, and [edge dialing](https://github.com/cloudflare/cloudflared/blob/2026.10.3/edgediscovery/dial.go)
uses a direct TCP dialer. Browser proxy settings or `HTTP_PROXY`/`HTTPS_PROXY`
alone therefore do not route these connections. [Community #1076](https://github.com/cloudflare/cloudflared/issues/1076)
reports the same distinction; [proxy PR #1514](https://github.com/cloudflare/cloudflared/pull/1514)
was still open at review. For users with an existing proxy,
process/transparent routing must actually cover cloudflared; avoid routing Piik's
unrelated media traffic through it. DNS overrides and another retry cannot repair
an unreachable edge. Cloudflare's [China Network](https://developers.cloudflare.com/china-network/)
is a separate Enterprise subscription, not a Quick Tunnel region switch.

An alternative must preserve HTTPS, the advertised origin and signaling WebSocket.
Do not substitute its executable for cloudflared: the current process boundary
expects Cloudflare's readiness and origin events. A provider switch changes the
invitation address; it cannot silently repair an active room's old link.

The existing Site path already separates public web hosting from App capture.
Use a reachable Site when Quick Tunnel is unavailable, adding its SFU only when
media fallback is needed. This reuses current room authority and App authorization
instead of adding a public tunnel service to operate. If an account-free fallback
is reconsidered, localhost.run has the bounded evidence below; account-bound cpolar/frp
setup is an operator choice, not a new task for Viewers. None is accepted as a
built-in provider; the [owner hold](../todo.md#held-by-owner) excludes integration
from the current phase.
Ordinary STUN redundancy and its independent failure controls remain
owned by [NAT research](./nat-traversal.md); changing the invitation provider
does not repair blocked STUN or UDP.

#### localhost.run Probe

On 2026-10-16, an isolated Windows probe established anonymous `nokey` tunnels
in about 2.5 seconds with OpenSSH and 3 seconds with the existing
`golang.org/x/crypto/ssh` dependency. The Go probe forwarded only a new in-memory
Piik core: its public page, invitation origin, Host/Viewer authentication,
chat delivery and Viewer WebSocket reconnection passed. A fresh Browser reached
the HTTPS page without an interstitial; a separate fixture passed Browser WSS
echo and WebSocket ping/pong. All temporary tunnels and listeners were closed.
No production provider or room/media model changed.

The service can therefore work without a separate executable or user account.
System SSH is another option, but [Windows treats it as an optional feature](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview).
The Go probe verified the server key against its isolated OpenSSH known-hosts
file. The service emitted the registration event without acknowledging an SSH
`exec` request; requesting no acknowledgement, as OpenSSH does, avoided waiting
for an absent reply. A TCP bridge to the existing core preserved its HTTP and
WebSocket ownership. Probe sources and results stay in ignored
`build/invitation-provider-probe/`.

The remaining tradeoff is service behavior. Reconnecting `nokey` allocated a
different origin; the retired URL no longer served the fixture. A fresh,
unregistered Ed25519 key was refused. The [provider FAQ](https://localhost.run/docs/faq/)
documents free-name rotation after a few hours and SSH keepalives/restarts.
Anonymous address retention and regional reachability require separate testing.

One cold Piik load reached DOMContentLoaded at 18.4 seconds and load at 20.3
seconds; its 592 kB main script took 17.1 seconds. The run did not isolate the
free-tier speed limit from other network delay. The tunnel carries the page and
signaling; Piik video remains P2P.
Together, address turnover and page-load cost favor evaluating it as an initial
invitation fallback rather than replacing Cloudflare by default or switching an
active room's address silently.

## Major-Upgrade Delivery Assessment

Reviewed 2026-10-06 against released update checkers and simulated v2.0.0
metadata. The v1.0.0 checker opens a provider's release page; v1.1.0 and v1.9.1
choose a matching ZIP on both GitHub and the Gitee fallback. Detection does not
download or install anything: the user must click. These clients have no
major-upgrade warning. The bounded replay used the released source, not the
current candidate's checker.

The legacy checkers accept exact provider release/asset URLs; release metadata
cannot redirect them to `piik.tv`. A valid GitHub API response wins without
checking whether its page or attachment is reachable. Gitee fallback selects
the highest stable version itself, so keeping GitHub's Latest on a transition
release does not constrain both discovery paths. Publishing a transition
release first cannot guarantee that every installed client receives it.

[Sparkle](https://sparkle-project.org/documentation/publishing/#major-upgrades)
separates major-upgrade presentation from installation and supports
[website downloads](https://sparkle-project.org/documentation/publishing/#downloading-from-a-web-site).
Its [feature-upgrade guidance](https://sparkle-project.org/documentation/publishing/#upgrading-to-newer-features)
also requires capable readers or a separate feed; metadata alone cannot teach
older readers a new rule.

Piik's primary action opens the download for the target version; release notes
are optional context. This action hierarchy does not require another installer
or update infrastructure.

The evidence supports direct manual downloads with an optional release-note
link and inline major-upgrade guidance. The accepted behavior belongs to
[versioning](../standards/versioning.md#major-upgrade-guidance). Historical
clients still follow their released behavior. App/Site compatibility follows
the current [public compatibility contract](../standards/versioning.md#public-compatibility-promise).

## Remaining Gates

These are gaps from the original runtime assessment. [TODO](../todo.md) owns
current work and deferrals; [verification status](../verification-status.md) owns platform coverage.

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
- [cloudflared releases](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3)
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
- [WebView2 Evergreen runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)
- [WebView2 screen capture](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs)
- [WebKitGTK multimedia](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Multimedia.html)
- [WebKitGTK display capture](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebView.html)
- [Electron architecture](https://www.electronjs.org/docs/latest/why-electron)
