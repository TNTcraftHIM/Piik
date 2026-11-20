# Verification Status

Last updated: 2026-11-19

This page summarizes the current 3.0 evidence and limits that affect product
claims. [Status](./status.md#isolated-30-prototype) owns delivery readiness;
package receipts own exact tested builds. Published 2.x has its separate
[verification record](https://github.com/TNTcraftHIM/Piik/blob/main/docs/verification-status.md).
Research owns measurements, and [TODO](./todo.md) owns remaining work.

## Current Evidence

The Windows x64 review package opened its native WebView2 launcher, created a
room and decoded a synthetic screen from an independent browser on loopback.
Closing the main window retired the observed WebView processes and listeners.
On Alpine x64, the packaged Server accepted signed chat after the room creator
left, retained the invited reader's grant and history on restart, and hid the
room from a stranger. These runs used disposable data. Physical display capture,
microphone capture and public-network conditions require their own checks.

On Windows, the hosted invite-only policy hid a visitor-created room from a
stranger and admitted its invite recipient. On a lightweight site, the owner
removed an offline room and its old invitation returned the reader to the overview.
The Linux Server and Android emulator restored room archives with chat, replies
and thumbnails. The Linux Server also restored private admission. The Windows
App exercised default WebView entry, explicit browser entry, WebView fallback
and terminal quit. A separate build with a test signing key returned to the
interactive terminal after an update and accepted keyboard input there.
Linux WHIP playback coverage is recorded
in the [local OBS input research](./research/room-interactions.md#local-obs-input).

The matching Channel 33 Android test APK and Windows App ran on a controlled
local network. On an API 35 x86_64 emulator, the Android launcher opened the
system browser, which read a desktop message and displayed the captured Windows
test window. After the site connection returned, the same page resumed its room
and viewing state. Peer media loss and physical handset behavior require
separate measurements.

Three loopback Chromium sessions kept B’s screen playing through A while
B and C established an additional connection. After A left, the original
subscription resumed on that same pair when both ends had confirmed it.
With negotiation delayed until A left, the subscription resumed on a new
pair. [Conditioned join and relay-departure trials](./research/network-lab.md#joining-and-relay-departure-under-measured-loss)
also recorded receiver RTP loss while the original publication remained available.
WAN reachability, mobile power cost and typical recovery time require independent
networks and devices.

Two loopback browsers carried a screen and a 512 KiB attachment on one
WebRTC connection. The recipient saved a file matching the sender's SHA-256.
Its decoded screen frames advanced during the download and after the file
transfer ended. The screen kept its original connection and media flow.

The Core capacity run exercised two active rooms of 20 people each, their
Browser and App endpoints, and one Server endpoint. All 32 rooms had a
maximum-size uploaded picture. The lobby received built-in icons and each
active reader received its room picture. With screen, voice and file demand,
the largest observed full State was 200,775 bytes and HostOutput was 215,279
bytes, both within the 4 MiB frame bound.
Real Browser/Server checks admitted 65 new retained identities, read paged offline
profiles without peer connections, applied rename and avatar removal, found an
unloaded offline mention target, and exported an old author outside the reading
window. Native archive checks retain 200 maximum-image identities and their
credentials in a roughly 5 MB archive. Normal Browser export and restore retain
237 identities across reload; invalid user records, duplicate identities and
CRC errors fail before upload and preserve the existing shares, voice and session.

The current conversation path verifies unread summaries in an unopened room
without browsing or peer connections, local read-position retention after
reload, identity-bound mentions, confirmed replies and navigation to a reference
outside the latest history page. Browser/WASM concurrent first use now shares
one initialization promise; a regression verifies that independently created
signers keep working when components initialize at the same time.

Direct-media synchronized viewing passes local checks with three independent
Browsers: common playback and late joining, local sound isolation, conversation,
and activity retirement through Browser and Server room hosts. Watch-only
participation constructs no peer connections. A separate control verifies real
autoplay refusal and trusted-click recovery. This is source-level evidence;
cross-network clock accuracy and matched packages remain open.
The Windows webpage connector passes normal App/Browser controls with an owned
cross-origin iframe: a Browser without the sharer's cookies independently loads
the selected MP4, follows pause/seek, and retires after the source window closes.
MSE webpage selection, cancellation, independent viewer retirement and source
shutdown also pass. Native module controls cover nested frames, player removal,
navigation, non-secure HTTP and a persistent website profile separated from Piik.
These fixtures do not establish compatibility with every commercial website,
DRM platform or media manifest format.
Original-media forwarding passes the normal Windows App and Browser flow for
MP4 and HLS VOD with separate audio, initialization segments and byte ranges.
A late Browser viewer received a complete range through another Browser relay;
the received and forwarded byte digests matched across that path. Leaving
cancelled an in-flight source read, while disabling forwarding retained the
original webpage's playback. These are controlled local sources and development
artifacts, not independent Internet or whole-website compatibility evidence.
A matching Windows development package with two Apps and an independent Browser
retains the same Reader and Viewer video element across a short Native signaling
interruption. An uncached seek after reconnection completes new range reads and
resumes decoded frames without rejoining. First joining a paused or ended video
presents a real frame. Runtime expiry cancels pending reads while App control
remains connected; reconnecting does not republish the old source. Explicit
new-source preparation plays successfully, and ending that activity releases its
provider. Core checks also reject new offline sources and clear expired or
withdrawn grants. These controlled local-media checks do not establish WAN/NAT
success rates, Linux pairing or general website compatibility.
After a short interruption of Native signaling, an independent viewer continued
playing the same publication and requested a new 64 KiB range. Closing the
Windows App while the local video source still held that request cancelled the
HTTP read and cleared the viewer's subscription and transfer plan. The App
exited normally and released its WebView2 processes and sockets. The cause of
an earlier isolated shutdown stall remains unconfirmed.
With 100 ms source response delay, an approximately 8 Mbps MP4 passes a real
Native-to-Browser-to-Browser path after initial buffering; correction stays
inside received ranges instead of repeatedly seeking beyond them. This is a
short controlled run, not an Internet capacity or endurance guarantee.
MP4 and HLS reception pass the App's self-signed local HTTPS entry without a
Service Worker. The MP4 checks include H264/AAC, a trailing file index,
progressive first picture, forward/backward seeking, and old-buffer removal
after input EOF. Ordinary HLS segments, byte ranges, common controls and
cancellation also pass. Other native-playable containers still need an origin
that permits Service Workers. These adapter checks cover Chrome; broader
Browser and website coverage remains open. The official hls.js demo also passes
Native webpage discovery, controls and peer forwarding.
Clear static DASH passes the packaged Windows WebView discovery and explicit
video/audio selection flow. The App's main player and an independent Browser
without an App receive VP9 video and German AAC through peer forwarding; shared
seek and ending the activity retire playback and the provider window. Earlier
App API controls cover failed replacement and pending-read cancellation. This
uses a local clear source; first-picture latency, account-backed websites and
cross-network delivery remain unverified.
An anonymous HLS webpage also passes Native player selection followed by explicit
Browser source selection: a delayed manifest is discovered after media readiness,
and the viewer directly loads and synchronizes it without App access, uploaded
bytes or added peer demand. Cancelling preparation preserves the existing share;
private-source refusal retains the App and explicit-forwarding choices.
An isolated Core25/App15 candidate passes standard PDT live HLS with a sharer and
two independent Browser viewers through both direct origin loading and Native
byte forwarding. The normal room paths cover late join, common pause/seek,
expired paused rejoin, Go live, ENDLIST retaining the program coordinate, and
retirement with no further origin reads. Native approval, Reader and peer delivery
are real; only page discovery/control is a synthetic provider for owned media.
Focused reader controls cover atomic snapshots, removed-resource grace, failed
reloads and bounded window rotation. This Linux VM evidence does not establish
commercial live website, Windows WebView, WAN or native-only live playback.
No-PDT sources and opaque native-only creator URLs fail explicitly; proven VOD
and explicit ordinary media paths remain covered separately.
Watch audience checks cover direct, peer and Native webpage viewing with the
same participant identities. Both sides show the shared count and names; joining
direct viewing still creates no peer connection. Leave, preparation cancellation
and activity retirement remove only their corresponding audience entries.
A matching Windows App/Web development package verifies the room list, couch
and people panel against actual direct-media playback. The local viewer's
preparing, received and failed states agree across all three surfaces; other
participants report membership without claiming remote picture delivery.
Leaving and source retirement clear activity indicators while retaining room
presence. This covers an owned local source, not physical-network readiness.

Actual website controls have narrower evidence than the local fixtures:

| Source | Observed behavior | Remaining scope |
| --- | --- | --- |
| Bilibili ordinary video | A matched Windows package decodes 1080p AV1/AAC in the sharer's main player and an unlinked Browser without site login. Pause, an unbuffered backward seek and forwarding off/on pass; local playback survives forwarding changes. Closing the provider retires both players while site connections remain. | One ordinary sample; cached Viewer playback may continue after forwarding is disabled. Live sources, cross-network delivery and broader catalogue coverage remain open. |
| Bilibili authorized member video | The same matched package passes 1080p AV1/AAC playback beyond the preview interval in the sharer's main player and an unlinked Browser without site login. Common pause, an unbuffered forward seek and normal retirement pass. Protected tracks remain excluded. | Member-specific backward seeking, cross-network delivery and broader catalogue coverage remain open. |
| YouTube public sample | The official embedded player passes a real Browser-hosted room with an independent Browser viewer: playback, pause, seek, source transfer without reload, and retirement. Separate controls cover hidden-view resumption, failed replacement and submission during navigation. | Advertisements, account/region restrictions, live sources and physical mobile-device behavior remain unverified. |
| Supplied girigirilove page | The original site redirects to a region-unavailable page in the test environment. | No player was accessible; Piik compatibility cannot be concluded. |

The first internal test targets matched Windows and Android packages with the
shared Browser UI. Normal packaged flows have verified room creation and
reopened history, bidirectional confirmed chat, file delivery with an exact
received digest, Native picture reception in both directions, and room voice
with advancing received packets and energy from a synthetic microphone.
Windows Browser camera and Native window checks used owned synthetic inputs.
These package checks ran on a controlled local network.
The matching packages after the private-protocol cleanup also reject the previous
protocol before admission. Current private-room invitation credentials, visitor
authority and signed history survive a normal Server shutdown and reopen.
Native OBS picture and source sound reach an independent Browser through the
Server while room voice continues; stopping the screen retains that voice lease.

The packaged Linux Server also passes optional site forwarding through the
production Browser UI. A Browser-owned room retains its healthy direct pair
when the owner enables forwarding. After an isolated UDP interruption, the
viewer receives advancing synthetic audio through the actual Server Native
endpoint; disabling the room option removes that service lease.
A matching Windows Native OBS source also delivers H264 pictures and Opus sound
through the packaged Linux Server to an independent Browser when that viewer's
direct peer signaling is blocked. A file follows the same service path with an
exact received digest while video continues. An initial delivery failure keeps
the subscription and later recovers without another user action. Two Native-owned
rooms also retain independent leases on one Server pair: revoking one room's
permission removes its flows while the other retains its connection, flow and
advancing audio. Leaving both rooms releases the final connection and capture.
Matching packages also recover a missing screen path while retaining the healthy
base connection and source's local presentation. One viewing request reached its
first recorded video-frame callback after 22.64 seconds, with subsequent picture,
source sound and base voice counters advancing. That callback reported two
presented frames, so it does not identify the absolute first presentation.
The isolated Browser exposed host candidates for the VM to reach its base path.
These checks use synthetic media and a VM port forward, not difficult physical
NATs or an endurance test.

Browser-hosted and App-hosted rooms delivered history, messages, reactions and
attachment descriptions over signaling with RTC blocked. New image messages
carry an optional thumbnail up to 640 pixels on its longer edge, within a shared
512 KiB budget per message. In a protocol 31 hosted-room check, a 1,118-byte
thumbnail remained visible after its sole file holder went offline. The original
became available again when that holder reconnected. The receiver verified all
2,802 bytes against the original digest.

The earlier protocol 14 tests delivered a 2,048-pixel preview of an 8 MB,
4,096-pixel image before fetching the original over P2P. That format could
also carry small PNG and GIF originals inline. With the sender's TCP connection
paced at 1 Mbps each way, Native and Browser room hosts each confirmed a
512 KiB inline original once and continued delivering chat. Supported history
readers still accept those retained originals.

Windows and Linux upgrade checks used copies of the previous candidate's
data, retaining room identity, credentials and confirmed history. Windows App
restarts preserve the saved local origin, a newly retained file's exact bytes and
the chosen interface layout. Old random-origin Browser caches are not migrated.
An earlier Android same-signature update retained compatible room/history and
its invitation after reload. Older private storage formats follow the
[storage reset boundary](../prototype/channel-server/README.md#saved-data-and-files).

Windows package evidence covers fresh empty-site first-use acceptance: the
site started with zero rooms and publications, Skip persisted the workspace view,
manual Quick selection persisted after reload, and no room or capture was created
by the choice. Current Windows package checks also verified private-room
invitation consumption, credential-backed reload and bidirectional chat between
independent Browser identities. The matched Linux Server passed Native-room,
signed-confirmation and clean-shutdown checks.

The matching Windows package's no-browser entry serves discovery and the
launcher with redirected output and no main window. After a Browser share ends
on its local site, Ctrl+C stops that App and releases its site and
control listeners. This does not cover the Native GUI, interactive terminal,
unavailable-WebView fallback or update restart.

The preceding Android candidate passed build, signature, dual-ABI, 16 KiB alignment
and bundled-Web identity checks. A package matching the newly delivered protocol
needs its own acceptance; preceding package and emulator results do not establish its
acceptance. Package receipts retain exact revisions and environment evidence.

Windows package checks also cover normal control request and Host
approval, real pointer and keyboard input to an isolated window, and **End
control** with no held test keys. Closing the Windows console during active
Native capture retires the App, encoder children and listeners. Android's
notification **Stop Piik** joins its runtime and releases projection and listeners.

App-hosted rooms and confirmed conversations survive selecting-page closure and
launcher reentry; personal shares and voice retire with their page. Browser
checks cover reactions after reload, retained drafts and attachments in floating
and Document PiP surfaces, source replacement, SDP track replacement during Native
handover, and signaling recovery with
progressing media on retained connections. Native App and Server package checks
verify bundled Web/WASM identity, notices, startup and orderly shutdown.
Windows Server checks also cover IPv4/IPv6 wildcard listeners with working
internal room hosting, and same-origin WebSockets on IPv6 loopback.
The 216f5ee4 Windows package passed standard room backup and restore. A separate
creator-access check covered a regular member exporting their Server-hosted room,
including only locally available originals, and rejecting another member’s archive request.
The Compose check covers room backup and restore with a read-only root,
invalid-archive rejection, scratch cleanup, and retained site/room identity
after container recreation. Media UDP and NAT have separate network checks.

Local OBS input passed picture and muted stereo-audio checks through the actual
packaged Windows App to an independent Browser, using synthetic sources. Normal
OBS stop and Piik revocation released input permissions and UDP resources. The
unchanged input implementation also passed stop/restart, retired-resource
deletion, reauthorization and controlling-page closure; package receipts identify
that preceding regression separately from the final package's media check.
Other desktop platforms and cross-NAT media remain outside this input evidence. Android compiles
with the shared changes but does not advertise this desktop input capability.

Switching between the full workspace and simple sharing retains actual Browser
picture and Opus tracks, publication and transport identities, microphone
acquisition and drafts. The simple view keeps joined voice visible and permits
leaving it. Browser and Native first-share checks verify explicit room creation,
picker cancellation and retry in the same room, then normal capture and stop.

In an App-hosted room, an independent Browser viewer kept receiving the original
share through a cancelled or rejected source change. Successful replacement
retained the publication and viewer stream. On Windows, Chrome 156 selected
two owned windows in different processes by title and returned window capture
tracks. The viewer kept decoding the first window through cancellation in the
native picker, then received the second window's pixels on the same track.
A separate controlled muted track exercised delayed readiness. Manual selection
on the reporting machine and window audio remain unverified.

A three-Browser run verified picture and voice progress while receiving files
through the same relay under controlled storage backpressure. Cancelling an
active receive released its file lease and temporary storage, preserved media
and conversation, and allowed a retry with the expected file hash.

Packaged Windows checks also combine multiple rooms, pictures, conversation and
voice: source settings remain tied to their own picture, moving the room tool
preserves its draft, and stopping one picture retains the other activities.
On the Android emulator, cancelling a new system source choice retains the active
Native picture; stopping that picture retains independently joined voice.

Native picture preferences now have Windows App/relay and Android normal-App
execution evidence. Both Android codecs use their actual CBR capability path;
preference changes and normal stop release the old workers. The
[network model](./research/channel-network-design.md#implementation-boundary)
owns adaptation behavior and recovery measurements.

## Device Evidence Boundary

### Windows And Android

Windows software H264 processing adaptation has a controlled encoding and
independent decoding check: an injected encode-stage delay produced a lower
resolution through the existing policy, while preserved slow-consumer timings
did not trigger it. The final shared H264/VP8 timing path passes codec, preference
and recovery checks. These results do not establish improved game performance,
physical GPU-overload detection or automatic hardware/software switching.

A prior package with room-scoped endpoint controls established three direct
voice branches from a Native host with an override of three and a room default
of one. Leaving voice released the tracks and connections. Current device
contribution and screen-source controls follow the [forwarding model](./research/channel-forwarding-plan.md#contribution-budget).

Windows has normal App window-capture, Browser viewing and attended input
execution evidence. OS permission, protected/admin application and game
compatibility remain bounded by the
[input assessment](./research/room-interactions.md#attended-remote-control-prototype).

The integrated Windows package retained its Native-hosted room and confirmed
messages across restart into the new window. Its trusted device-permission
window passed microphone allow/deny/Esc, camera cancellation, language/theme
changes and App shutdown while a request was pending. These use synthetic
devices, not physical microphone or camera acceptance. Window sizing, controls,
two-screen viewing, theater and fullscreen were exercised on the same integrated
shell before the permission-window change. The final permission-path shutdown
left no App/WebView processes or TCP/UDP resources. A controlled unavailable-runtime
check used the documented per-process WebView2 runtime override. The delivered
App opened the default Browser, retained Native room/history access and message
submission, then closed normally through the terminal without remaining listeners.

Matching Windows permission checks with fake devices verify saved Allow across
default and explicit microphone selection and same-process reload. Camera and a
different origin receive separate prompts; Deny and closing the prompt do not
persist a refusal. Resetting one site's microphone/camera choices through its
details makes both ask again while another site's microphone grant remains.
The reset preserves the current document, bookmark and App-access state. Physical
devices, reset persistence across process restart and active-capture interruption
remain outside this evidence.

Saved-site and Browser-to-client navigation checks exercised the actual Windows
caption, local confirmation page and SQLite persistence. Viewing the list and
same-document room navigation retained joined voice; cross-site navigation retired
the old page while another Browser still wrote to its Native-hosted room. Complete
synthetic invitation paths and fragments reached the destination without entering
bookmarks or device approval. The caption reopened the list from a failed network
page; reopening the App retained the bookmark. These are local navigation and
resource checks, not public-network or physical-microphone acceptance.

An operator-configured HTTPS entry completed the actual launcher flow through a
local TLS reverse proxy, followed by an App-hosted private room, generated
invitation and confirmed chat in an independent HTTPS Browser. Exact WebSocket
origin checks and App management isolation held, and normal shutdown released
the listeners. Startup tests retained the configured origin, site identity and
port across restart. This establishes the entry and authority boundary, not a
particular proxy provider, Internet certificate setup or media path.

The Windows updater completed a signed whole-bundle replacement using the real
product helper, followed by saved-site and Native room/history recovery. Closing
before helper readiness retained the old program; a blocked directory rename
restarted it. These checks used isolated data, a temporary signing identity and
two local streamed providers. They establish the installation lifecycle, not
public CDN performance, production key distribution or other platforms' installers.

Android runtime evidence from preceding candidates includes the official API35
x64 emulator, system capture consent, decoded picture, compatible room data across
same-signature updates, and normal source/runtime stop. ARM64 is packaged and
checked statically; it has not
received equivalent physical-device acceptance. Phone, tablet and TV performance,
suspension behavior and physical sound remain device acceptance work.

Two observed Android environment limits remain:

- MuMu's legacy software OMX service can abort while creating VP8 or H264
  encoders. Independent platform controls reproduce the failure.
- Firefox on the tested emulator can decode incoming Native H264 while failing
  to convert it into an outgoing relayed picture. Automatic direct replacement
  has delivered picture; no Browser pixel-conversion workaround is integrated.

The [Native runtime reference](../prototype/channel-native/README.md) and its
[evidence/provenance index](../prototype/channel-native/README.md#rtc-dependency)
retain platform details and tested-source records.

### macOS And Linux

Earlier macOS SDK/package checks cover capture, encoding, sound and input compilation,
synthetic encode/decode, LaunchServices startup and startup-error cleanup.
The current audio-continuity change has source review but no new macOS build
or device check; the local cross-build lacks the required Apple C toolchain.
The [current VideoToolbox control](https://github.com/TNTcraftHIM/Piik/actions/runs/42697708222)
also verifies QP feedback, independent geometry changes, a continuing sibling
and source-time preservation in the shared quality implementation.
System Quit, Dock/Finder return, permissions, physical capture, sound and input
still need device acceptance. Automated Quit requires the runner's normal
Automation consent.

Linux VM checks cover software encoding, decoded Browser picture and Opus,
source-picker cancellation and retry, normal sharing stop, and sound-service
loss while picture and chat continue. Software-encoder comparisons also verify
source-cadence correction, balanced FPS/geometry changes and independent output
under a constrained budget. Real GNOME Portal/PipeWire checks cover
capture consent, encrypted keyboard/pointer execution, pending-permission
cancellation and global-stop activation with capture continuity. Hardware
encoding and physical sound still need platform acceptance.

GNOME can leave cancelled shortcut consent visible after Piik releases its
Request/session. A separate Mutter unstarted-session leak also remains an
upstream boundary; Piik releases its own resources and does not start an
unapproved session. The [network design](./research/channel-network-design.md#implementation-boundary)
owns the findings and source references.

These macOS/Linux device gaps are separate from the Windows/Android first
internal test. The [platform reference](../prototype/channel-native/README.md#checks)
owns their check entry points.

## Adaptation Boundaries

The [Rust network controls](./research/network-lab.md#rust-process-controls)
verify ordinary and prepared UDP connections, short interruption and lost-mapping
recovery, and decoded picture/source-sound recovery through Native transit and
Browser relays after longer outages. A normal Android App has also delivered
signed room history, confirmed chat and decoded H264 across independent public
UDP egresses. An earlier same-egress control received STUN replies but no peer
datagrams; that packet-loss point remains unresolved. Population NAT success
rates have not been measured.
Random-port preparation also has [kernel-NAT and socket-retirement controls](./research/nat-traversal.md#random-mapping-collision-control),
including matched production signaling, DataChannels and decoded media. These
cover two capable Native endpoints; they do not establish Browser-only or
single-App random-port coverage.
The single-App linear extension also has matched production forwarding evidence:
decoded video/audio and reverse RTCP on the selected original socket, followed
by target retirement when its Browser closes. Its
[linear-mapping control](./research/nat-traversal.md#random-mapping-collision-control)
retains the experiment's assertion failures and the independent evidence checks.
Virtual-LAN loading reports retain their own investigation in [TODO](./todo.md#now).

Browser WebRTC and the Native RTC SDK own congestion control and transport
adaptation. Current controls establish constrained-output recovery, healthy
sibling isolation and retained source clocks. A current
[desired-capacity control](./research/network-lab.md#native-desired-capacity)
also verifies the source-intent input through restricted and restored media.
Measurements and superseded SDK
experiments stay in the [network laboratory](./research/network-lab.md),
[encoder assessment](./research/webrtc-encoder-pool.md) and
[Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency).

The [fidelity assessment](./research/media-fidelity.md) owns stereo, SDR conversion
and synthetic GPU tone-map evidence. Physical HDR appearance and mixed-display
changes under load remain unaccepted; Browser capture has its own conversion
limits. Full HDR and surround sound are outside this phase.

Synthetic sources verify decoded audio delivery. Microphone acoustics remain
device acceptance work. Native system-output capture can recapture Browser room voice;
automatic voice exclusion remains deferred. Current source-audio exclusion follows
the [playback/AEC boundary](./research/channel-network-design.md#input-and-sound-boundaries).
The [2.x Windows audio measurements](./research/native-client-media.md#windows-audio-exclusion)
are historical evidence, not 3.0 runtime acceptance.

## Interpretation

The linked receipts identify the source, platform and workload of each result.
Browser and OS suspension follow the accepted activity lifecycles. New concrete
failures return to their existing owner for scoped investigation.
