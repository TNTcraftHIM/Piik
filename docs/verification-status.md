# Verification Status

Last updated: 2026-11-12

This page summarizes the current 3.0 evidence and limits that affect product
claims. [Status](./status.md#isolated-30-prototype) owns delivery readiness;
package receipts own exact tested builds. Published 2.x has its separate
[verification record](https://github.com/TNTcraftHIM/Piik/blob/main/docs/verification-status.md).
Research owns measurements, and [TODO](./todo.md) owns remaining work.

## Current Evidence

The capacity scenario exercises the real Core with two rooms of 20 users, each
using Browser and App endpoints, plus the Server endpoint. It includes screen,
voice, watching and file plans. The largest observed full State was 970,935 bytes
and HostOutput 409,583 bytes within the existing 4 MiB frame bound. This is route
and serialization acceptance; the network/media checks below own transport evidence.
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

The first internal test targets matched Windows and Android packages with the
shared Browser UI. Normal packaged flows have verified room creation and
reopened history, bidirectional confirmed chat, file delivery with an exact
received digest, Native picture reception in both directions, and room voice
with advancing received packets and energy from a synthetic microphone.
Windows Browser camera and Native window checks used owned synthetic inputs.
These package checks ran on a controlled local network.

The newer conversation path passes normal Browser-hosted and App-hosted room
checks with peer signaling blocked: history, bidirectional messages and saved
reactions work without RTC connections. Attachment descriptions also arrive
without RTC. Current image rendition checks verified a 4096px, 8 MB original
arriving as a 2048px preview without a peer connection, then loading its unchanged
original through P2P with the expected digest. Small PNG and GIF originals
remained unchanged, and the preview was readable from Native history after its
sender left. Preparation checks retain transparent alpha and skip Canvas for
over-budget animations. Rendition and original validation, history pagination
and backup/copy retention share the confirmed-message boundary.
An actual sender TCP connection paced at 1 Mbps each way verified a full-budget
inline image through both Native and Browser room hosts. Both committed once,
received their confirmation and continued ordinary chat; the adjusted conversation
deadline no longer reports failure before that confirmation arrives.
Delivered candidates include peer-independent conversation and the current image
path. Windows and Linux upgrade checks used copies of the previous candidate's
data, retaining room identity, credentials and confirmed history. Windows App
restarts preserve the saved local origin, a newly retained file's exact bytes and
the chosen interface layout. Old random-origin Browser caches are not migrated.
An earlier Android same-signature update retained compatible room/history and
its invitation after reload. Older private storage formats follow the
[storage reset boundary](../prototype/channel-server/README.md#saved-data-and-files).

The beta.17 Windows candidate passed fresh empty-site first-use acceptance: the
site started with zero rooms and publications, Skip persisted the workspace view,
manual Quick selection persisted after reload, and no room or capture was created
by the choice. The matched Linux beta.17 Server passed the existing Native-room,
signed-confirmation and clean-shutdown checks. The matched Android beta.17
candidate passed build, signature, dual-ABI, 16 KiB alignment and bundled-Web
identity checks but has not been installed for runtime acceptance. An Android
runtime comparison remains pending.

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
The Compose check covers room backup and restore with a read-only root,
invalid-archive rejection, scratch cleanup, and retained site/room identity
after container recreation. Media UDP and NAT have separate network checks.

Switching between the full workspace and simple sharing retains actual Browser
picture and Opus tracks, publication and transport identities, microphone
acquisition and drafts. The simple view keeps joined voice visible and permits
leaving it. Browser and Native first-share checks verify explicit room creation,
picker cancellation and retry in the same room, then normal capture and stop.

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

Windows has normal App window-capture, Browser viewing and attended input
execution evidence. OS permission, protected/admin application and game
compatibility remain bounded by the
[input assessment](./research/room-interactions.md#attended-remote-control-prototype).

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
Virtual-LAN loading reports retain their own investigation in [TODO](./todo.md#now).

Browser WebRTC and the Native RTC SDK own congestion control and transport
adaptation. Current controls establish constrained-output recovery, healthy
sibling isolation and retained source clocks. Measurements and superseded SDK
experiments stay in the [network laboratory](./research/network-lab.md),
[encoder assessment](./research/webrtc-encoder-pool.md) and
[Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency).

The [fidelity assessment](./research/media-fidelity.md) owns stereo, SDR conversion
and synthetic GPU tone-map evidence. Physical HDR appearance and mixed-display
changes under load remain unaccepted; Browser capture has its own conversion
limits. Full HDR and surround sound are outside this phase.

Synthetic sources verify decoded audio delivery. Microphone acoustics remain
device acceptance work. Native system-output capture can recapture Browser room voice;
automatic voice exclusion remains deferred. Platform-specific source-audio
exclusion follows the [audio assessment](./research/native-client-media.md#windows-audio-exclusion)
and the [playback/AEC boundary](./research/channel-network-design.md#implementation-boundary).

## Interpretation

The linked receipts identify the source, platform and workload of each result.
Browser and OS suspension follow the accepted activity lifecycles. New concrete
failures return to their existing owner for scoped investigation.
