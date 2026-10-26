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
package size. These facts do not prove equivalent Piik media behavior.

Only a reproduced Browser-launch failure should open a comparative physical
gate for Electron, Tauri, Wails, Neutralino, or another shell. That gate must
compare actual capture, audio, H.264/VP8 sender implementation, 1080p cadence,
relay, background behavior, and resource use on every target platform. The
result selects one UI runtime; it does not create parallel products.

## Historical Package Evidence

The runs below exercised the earlier package that bundled Node and an extracted
application tree. They retain their measured revision's results. The current
single-binary composition is described above; [verification status](../verification-status.md)
owns current acceptance and platform coverage.

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

The one-link gate used the official Windows amd64 `cloudflared` 2026.8.3 asset
with SHA-256 `83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae`.
The sidecar remains an explicit package input rather than a linked App
dependency.

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
This is the last reported observation, not a classification or a complete log;
match the same run's `public-tunnel` diagnostics when the detail is insufficient.
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
US host, then confirms App exit and link retirement. These bounded checks do not
establish regional reachability, uninterrupted connector availability or the
cause of reports without matching diagnostics. Upstream
[Quick Tunnel setup](https://github.com/cloudflare/cloudflared/blob/2026.8.3/cmd/cloudflared/tunnel/quick_tunnel.go)
and [protocol fallback](https://github.com/cloudflare/cloudflared/blob/2026.8.3/supervisor/tunnel.go)
own the dependency behavior. An early-exit fixture confirms fourth-start recovery
and bounded exhaustion; these checks do not identify a reporter's API or network
failure or guarantee four starts when earlier attempts consume the deadline.

A 2026-10-08 Windows check against a deliberately refused local allocation API
confirmed that cloudflared 2026.8.3 emits its final allocation error as plain
stderr even with `--output json`. A JSON-only error reader therefore misses it.
The process boundary retains that detail without changing retries or shutdown;
normal cancellation still stays clean, and late cleanup cannot erase an already
observed failure. The launcher applies its existing redaction and display limit.

The public App log in [#452](https://github.com/TNTcraftHIM/Piik/issues/452),
reviewed on 2026-10-07, records a QUIC timeout followed by a TCP port-7844
connect timeout within that deadline. Thus fallback ran; the report does not
establish a local port-80/443 collision. Its accelerator dependency remains a
network-path hypothesis requiring the same endpoint with/without the accelerator.
The attachment contains no capture start, so it cannot diagnose the separately
reported H.264 failure.

[HTTP 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)
means Cloudflare cannot find a healthy tunnel connector. App readiness requires
both the assigned origin and a registered connection; later reconnection belongs
to cloudflared, while process exit ends that App's public-link runtime. This
HTTP failure precedes WebRTC candidate exchange and is distinct from media-route
exhaustion on an already reachable site.
The pinned [supervisor](https://github.com/cloudflare/cloudflared/blob/2026.8.3/supervisor/supervisor.go)
uses [indefinite retries with bounded exponential backoff](https://github.com/cloudflare/cloudflared/blob/2026.8.3/retry/backoffhandler.go)
for recoverable edge disconnects. Piik's four-start acquisition limit is not a
four-reconnect limit after readiness. Restarting the Quick Tunnel process would
allocate a new public address rather than repair the old invitation.

### Alternative Invitation Providers

Reviewed 2026-10-16 against provider documentation and upstream discussions.
No matched evidence establishes a universally more reachable replacement for
Quick Tunnel, especially across mainland networks. These are candidates, not
accepted Piik integrations. Viewers must only open the invitation in a Browser;
requiring their own account, extra software or proxy/network configuration is
outside this path. Operator-managed tunnels belong with self-hosted Sites.

| Candidate | Relevant capability | Cost to Piik's account-free invitation |
| --- | --- | --- |
| [localhost.run](https://localhost.run/docs/forever-free/) | Account-free HTTPS/SSH; the bounded probe below passes Piik HTTP and signaling, including an in-process Go client. | Free domains rotate and are speed-limited. Anonymous reconnection changed the URL; the cold page load was slow. |
| [Pinggy](https://pinggy.io/) | Account-free temporary tunnels and several global regions. | Free tunnels expire after 60 minutes and show a [browser screening page](https://pinggy.io/docs/http_tunnels/screening/). Paid service changes that boundary. |
| [ngrok](https://ngrok.com/docs/pricing-limits/free-plan-limits) | Account-bound domains; free endpoints have no session timeout. | Account/token setup, usage quotas and a browser interstitial prevent a transparent free replacement. |
| [cpolar](https://www.cpolar.com/docs) | HTTP(S), WebSocket and selectable mainland/Hong Kong regions. | Requires account/token setup; free addresses may change within 24 hours. Region choice is not proof of access from every ISP. |
| [frp](https://gofrp.org/en/docs/overview/) | Open-source HTTP(S) forwarding with operator-selected hosting. | Someone must run the public endpoint, domain/TLS and admission. It is not a hosted, account-free service by itself. |

The pinned cloudflared has two separate proxy gaps: [Quick Tunnel allocation](https://github.com/cloudflare/cloudflared/blob/2026.8.3/cmd/cloudflared/tunnel/quick_tunnel.go)
constructs an HTTP transport without `ProxyFromEnvironment`, and [edge dialing](https://github.com/cloudflare/cloudflared/blob/2026.8.3/edgediscovery/dial.go)
uses a direct TCP dialer. Browser proxy settings or `HTTP_PROXY`/`HTTPS_PROXY`
alone therefore do not route these connections. [Community #1076](https://github.com/cloudflare/cloudflared/issues/1076)
reports the same distinction; the still-open [proxy PR #1514](https://github.com/cloudflare/cloudflared/pull/1514)
does not establish a working Quick Tunnel fix. For users with an existing proxy,
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
unregistered Ed25519 key was refused, so this check did not establish account-free
address retention. The [provider FAQ](https://localhost.run/docs/faq/) documents
free-name rotation after a few hours and SSH keepalives/restarts, not seamless
anonymous URL recovery. TCP port 22 being reachable here does not establish
mainland ISP coverage or an advantage over Cloudflare's transports.

One cold Piik load reached DOMContentLoaded at 18.4 seconds and load at 20.3
seconds; its 592 kB main script took 17.1 seconds. This is an observed run, not a
regional benchmark or proof that the documented free-tier speed limit was the
only cause. The tunnel carries the page and signaling, not Piik's P2P video.
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
clients still follow their released behavior; a notice cannot substitute for
actual App/Site compatibility checks.

## Android Capture Bridge Assessment

The [Android App candidate](../../mobile/README.md) builds an APK for arm64 and
x86-64 from the repository's single Go dependency graph. The system browser
presents the shared Web UI at its loopback origin or an explicitly approved
site. `AppRuntimeService` owns the one Go runtime and pending OS requests;
the Activity owns visible permission dialogs. A user-started `specialUse`
foreground service keeps local rooms and the native companion available while
the system browser is in front, with ordinary open/stop notification actions.
The shared launcher's add-site action displays the exact origin for explicit
approval before opening it. Its management popup preserves the opener, so the
existing approval notification and close return to the original live Host.
The App management page owns approval, revocation and the starred startup site.
Local mode starts the Go room and LAN HTTPS invitation only when
selected; Hosted mode uses that site's room service. Room signaling stays with
the same Web UI. Public-link mode reuses the desktop supervised cloudflared
process and the same room server. Its Android PIE executable is installed in
the APK native-library directory; temporary configuration uses the Android
cache directory rather than a process-wide temporary-path override. Runtime
shutdown joins startup work, ends the room server, then joins the sidecar.
An unexpected sidecar exit ends the runtime and presents an explicit restart.

A `mediaProjection` foreground service owns the approved Projection, VirtualDisplay,
MediaCodec and AudioRecord. A narrow
[gomobile AAR](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile) bridge supplies
frames and controls through `nativehost.CaptureProvider`; desktop capture keeps
its supervised process adapter. Both use the same Host, packetization and route
owners. Android admits one native control session because one Projection owns
the shared display; desktop admission remains two.

Capture prefers hardware AVC and otherwise uses an available Surface-capable
MediaCodec VP8 encoder. Device capabilities bound the existing quality controls.
The APK uses the ordinary responsive UI for phones and tablets; TV availability
depends on an installed browser, Projection and encoder support.

[MediaProjection](https://developer.android.com/media/grow/media-projection)
requires consent for each capture session; Android 14 permits one VirtualDisplay
per consent token. System `onStop` retires the capture resources. Source audio
uses [playback capture](https://developer.android.com/media/platform/av-capture)
from Android 10, subject to `RECORD_AUDIO` permission, the same user profile and the
source application's capture policy.

Native commentary uses AudioRecord VOICE_COMMUNICATION with the same per-share stream/ready
handshake and existing Go audio mixer. Its input and replacement stay independent
of playback capture; the Projection service holds microphone eligibility until
the last commentary reader joins. Mono PCM is adapted to the existing PCM48
stereo contract. Device preferences use AudioManager input identities and verify
the actual recording route; the empty choice follows Android's default. This is
separate from room voice's Browser microphone and does not add a mixer or route.
Android's [audio-input sharing policy](https://developer.android.com/media/platform/sharing-audio-input)
limits concurrent microphone input across separate apps. System echo processing
does not make the two microphone paths share one capture or eliminate that limit.

The earlier prototype API 35 emulator run delivered a live 480-by-800 VP8 picture
to an independent Windows Browser Viewer. Sharing continued after switching to another
App. A separate allowed-capture AudioTrack source reached that Viewer as Opus
with measurable tone energy. The lab Browser used explicit local candidates
because mDNS does not cross the emulator's isolated network. Physical-device
acceptance and distribution remain in [TODO](../todo.md#next).

The system browser owns camera, room voice, page permissions and fullscreen.
Native playback audio requests recording permission separately; pure-video
Projection does not. The Activity and service retain native capture ownership
across rotation; runtime detachment precedes asynchronous shutdown so an old
close cannot retire a newly opened runtime.

Emulator checks cover Local/public startup, screen and browser-camera
replacement, concurrent room voice, portrait-to-landscape resizing,
cancellation/retry, background return and new-Viewer admission. The packaged
public-link helper established its tunnel without extra DNS configuration.
[Verification status](../verification-status.md#device-evidence-boundary) owns
the current rate-control and physical-device acceptance boundaries.

### Android Encoder Budget

A 2026-10-26 standalone API 35 emulator probe isolated the software
`OMX.google.vp8.encoder` from Piik's room and transport. A changing 1080p30
Surface produced about 2.65 Mbps at either a 1 Mbps or 100 kbps CBR request.
Extending the keyframe interval reduced keyframes, but not that output rate.
The [AOSP software VPX implementation](https://android.googlesource.com/platform/frameworks/av/+/ffede69924118c5454484164fd590b3474cc716a/media/libstagefright/codecs/on2/enc/SoftVPXEncoder.cpp)
disables frame dropping and CBR resizing; reaching its compression limit can
therefore exceed the budget even when bitrate updates succeed.

The same probe reused the unmodified
[WebRTC FrameDropper](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/video_coding/utility/frame_dropper.cc)
from the existing native SDK pin, with the
[VideoStreamEncoder call sequence](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/video/video_stream_encoder.cc).
The 960x540 lower output at 100 kbps averaged 99.1 kbps over the final 20 seconds;
1080p at 1 Mbps reached about 1.03 Mbps over the final three seconds. Restoring
3 Mbps restored full frame submission. At 1080p and 100 kbps, output remained
about 175 kbps: the stock component bounds frame suppression rather than
promising an arbitrary hard byte ceiling. These are synthetic platform/component
comparisons, not a full-App capture or network result. Android reuses that same
component at each encoder's Surface input, with one capture clock and existing
demand-driven lower outputs.

### Android Browser Handoff

The Android App uses the system browser with the same Go room, authorization and media code.
[Chrome Intents](https://developer.chrome.com/docs/android/intents) allow an
explicit gesture to wake App, then return to the current browser tab. Waking is
not authorization: the exact site still needs approval and an authorized-health
recheck. The browser's existing approval popup retains its real opener.
[Verified App Links](https://developer.android.com/training/app-links/verify-applinks)
require domain association, so they cannot be the universal entry for arbitrary
self-hosted sites.

Each new recording uses a user-visible return to App for system consent;
[background activity restrictions](https://developer.android.com/guide/components/activities/secure-bal)
prevent the Go callback from simply opening that UI behind the browser.
Outside recording, the runtime service keeps Local/public rooms alive rather
than relying on a background Activity's static runtime. Android can suspend or
kill [cached processes](https://developer.android.com/guide/components/activities/process-lifecycle).
The external browser owns camera, voice and local-network permission. The
optional native activation description adds a foreground action without changing native
commands or the published control version. A normal App open also processes a
current pending request, independently of whether its site has the shortcut.

### iOS External-Browser Assessment

An explicit native session can use iOS 26's `BGContinuedProcessingTask` before
opening the local Web UI in Safari. [Apple DTS](https://developer.apple.com/forums/thread/840384)
describes user-controlled sessions without a fixed duration ceiling; admission,
progress, cancellation and retirement remain part of that session's lifecycle.
[Synctrain](https://github.com/pixelspark/sushitrain/blob/main/Sushitrain/BackgroundManager.swift)
provides an existing Go/gomobile implementation to reference.

The next implementation gate is one background-task owner bound to Piik's Go
runtime, with explicit Start/Stop and shutdown on expiration. Exercise local
HTTP/WebSocket, idle room, voice, native capture and return to Safari on a device.
Hosted HTTPS access to insecure loopback remains a separate
[WebKit boundary](https://bugs.webkit.org/show_bug.cgi?id=171934).
`SFSafariViewController` is a system-managed in-App browser alternative; it is
distinct from the requested standalone-browser workflow.

## Current Follow-up

[TODO](../todo.md) owns remaining work; [verification status](../verification-status.md)
owns current device and network coverage. The historical runs above do not form
a second acceptance ledger.

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
- [WebView2 Evergreen runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)
- [WebView2 screen capture](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs)
- [WebKitGTK multimedia](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Multimedia.html)
- [WebKitGTK display capture](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebView.html)
- [Electron architecture](https://www.electronjs.org/docs/latest/why-electron)
