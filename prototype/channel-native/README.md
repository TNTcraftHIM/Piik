# Native channel participant

This isolated Rust participant operates rooms through the same [shared `RoomHost` core](../channel-core/README.md)
as the Browser adapter. SQLite stores each room's policy and confirmed history;
the domain supplies admission, directory views and transport leases. Its actual
WebRTC endpoint carries room DataChannels, encoded media and requested file
ranges without retaining file contents in SQLite. The media adapter forwards
Opus, VP8 and H264 Constrained Baseline with packetization mode 1, without
decoding or transcoding.

The [network design](../../docs/research/channel-network-design.md) owns the model.
This executable is an explicitly started development host. Chat, history, room voice and files
use the base paths, and screen startup reuses those paths through the same participant.
The default Server embeds one participant for its three rooms and owns its
service lifetime. The [App composition](../channel-server/README.md#local-app-link) owns its Native hosting endpoint, separately
from the Browser's personal activities. The App reuses the product's site approval
and saved-site interface, and starts its own domain through the shared
Local/public-invitation launcher. Windows WGC captures each source once in the
parent; each encoding owns a separate same-executable child for D3D11 conversion,
hardware H264, bitrate, keyframe requests and ordered output. Demand-driven GPU
handoff preserves the source's presentation clock and copies the texture into
the child's private resource before encoding. An unread encoding rests on its
bounded output queue without continuing GPU transfers. The Encoding owner stops
and joins its child; a Windows Job also releases it when the App exits.
Encoding failure affects only outputs using that encoder. Stopping capture ends
all its encodings and input authority while App-hosted rooms continue.
Frame-rate selection retains the original timestamps and accumulates its sampling
interval across frames. The [network design](../../docs/research/channel-network-design.md)
owns the process and output boundaries.
Windows encoders feed their actual output size into the existing WebRTC FrameDropper
algorithm; raw-frame admission adjusts when hardware rate control overshoots,
without discarding encoded reference frames or changing the source clock.
The macOS 13+ adapter uses ScreenCaptureKit and VideoToolbox through the published
MIT-licensed `cidre` bindings. It plugs into the same producer, source picker,
encoding demand and page lease; it does not use the Windows worker process.
Its source, source sound and encoding owners are defined in the
[network design](../../docs/research/channel-network-design.md).
[Platform verification](../../docs/verification-status.md#device-evidence-boundary)
owns SDK builds and native acceptance.

Linux uses the system Portal picker through `ashpd` and one PipeWire capture.
Each hardware H264 encoding has its own GStreamer pipeline; system-output audio
uses the PulseAudio monitor, including PipeWire's PulseAudio compatibility service.
The App enables the Native `capture`
Cargo feature; Server disables it so forwarding does not require desktop media
libraries. Linux App builds need GStreamer 1.20+ development libraries and
`pkg-config`; runtime capture needs the PipeWire, conversion, H264 parser and
hardware encoder plugins, plus a working desktop Portal backend. Hardware
selection uses the VA/VA-API, NVENC, MSDK and QSV plugins only when the installed encoder exposes
live bitrate control. Selection opens the actual device and skips unavailable encoders.
The [network design](../../docs/research/channel-network-design.md) owns source,
clock and encoder lifetimes; [verification status](../../docs/verification-status.md#device-evidence-boundary)
owns platform acceptance. `ashpd` and the `reis` input bindings use MIT licensing;
the GStreamer Rust bindings use MIT/Apache-2.0. GStreamer and system-installed
plugins retain their own licenses.

The App's source picker starts that producer on its existing Native endpoint.
Local and received sources share the same encoded outputs and room routes.
Each local output packetizes complete access units on its own stable RTP clock;
selecting another encoding of the same capture keeps its sender and SSRC and
switches at a replacement keyframe. A slow output recovers independently of its siblings.
The selecting page holds the capture lease: closing it stops its captures while
App-hosted rooms continue. Startup completes after the first encoded access unit;
errors before that point return to the page. Optional WASAPI source audio uses
process loopback for a selected window and render-device loopback for a screen.
The Rust Opus encoder shares the picture's capture clock and routes. Silence does
not delay picture startup; an audio failure warns the page while picture sharing
continues. Each physical connection's target now allocates its confirmed local
video outputs. Constrained outputs control their own encoding; zero demand pauses
only that output, and restoration waits for a newer baseline keyframe before
retiring its encoder. The [network design](../../docs/research/channel-network-design.md)
owns measured behavior and the source-sized encoding boundary;
[TODO](../../docs/todo.md) owns remaining adaptation, input and platform work.

Windows keyboard, mouse and text input share one App-owned desktop executor.
The Browser reuses the existing remote-control and source-consent components;
input returns over the selected screen route on the same peer connections.
Capture leases own consent and held-key cleanup, independently of room hosting.
Global stop uses a process-only Windows hotkey selected by the Browser preference.
The [activity model](../../docs/research/channel-network-design.md#activity-and-lifecycle)
owns authorization and retirement. Optional Windows gamepads use an already
installed ViGEmBus through `vigem-rust`; Piik bundles or installs neither a
driver nor a client DLL. Up to four approved controllers have independent
device workers. Focus/reset keeps the neutral device, while grant retirement
stops it; gamepad failures leave keyboard and mouse permission intact.
The macOS input backend uses public Quartz/Accessibility bindings in the same
executor, including physical keys, Unicode text, pointer/drag/scroll and the
Browser-selected stop chord observed by the existing App tick. Only the source
page enabling control can request Accessibility permission. Window identity,
focused-window geometry and permission are checked separately; macOS does not
advertise gamepad support. macOS packaging and real-device capture/input
acceptance remain open.
Linux control requests the system RemoteDesktop permission when the source page
enables it. The selected monitor and its EIS input connection belong to that one
Portal session. Approval preserves the existing producer, encoders and media
clock; cancelling keeps the current sharing session. The same source consent
owner cancels pending permission on replacement, local stop or capture closure.
The backend must provide RemoteDesktop and ConnectToEIS; text entry is advertised
only when the granted device provides it. Linux global stop shortcuts and
gamepads remain platform work.

The App entry point keeps the Windows MTA alive outside its async runtime.
Cached WinRT factories span successive captures and source-list refreshes; their
runtime must therefore span the process, while capture workers still stop and
join with their individual page lease.

Each incoming audio/video track keeps its RTP clock and source Sender Report
mapping. Outputs in one flow share a stream while owning separate SSRCs and
bounded writers; WebRTC handles each hop's retransmission and congestion control.
The pinned SDK does not provide RTCP round-trip-time statistics.
Readers, outputs and their completion reports belong to the exact directed flow
lease. Removing that lease retires its work even if the same publication is
subscribed again on the shared connection; the replacement has a new flow ID.
Each outgoing lease references its admitted incoming flow. Incumbent and shadow
inputs can forward concurrently; selecting the shadow preserves its already
warm output, stream, SSRC, source clock and feedback owner.

## RTC Dependency

Native and Server pin `rtc` to commit
`32373f88e1d1e170b37f3725c8bb2ba57b251b5c` in the temporary
[fork](https://github.com/TNTcraftHIM/rtc/tree/32373f88e1d1e170b37f3725c8bb2ba57b251b5c).
It contains two submitted fixes on the published 0.21.1 baseline:

- [PR #296](https://github.com/webrtc-rs/rtc/pull/296) retires stale RTP extension
  mappings and preserves the active section's negotiated IDs. Changing voice and
  screen tracks on a retained connection otherwise produces invalid Browser offers.
- [PR #298](https://github.com/webrtc-rs/rtc/pull/298) keeps local H264 capabilities
  separate from negotiated formats, matches equivalent profiles and applies
  directional levels. Piik uses those formats for each output and checks the
  actual encoded SPS at its input boundary. The [network design](../../docs/research/channel-network-design.md)
  owns the distinction between a Browser's SDP level and its actual decoder.

Cargo's patch belongs to each workspace root, so both executable manifests carry
the same pin. The fork retains upstream MIT/Apache-2.0 licensing; no build-time
source patch or registry-cache edit is used. When an upstream release includes
both fixes, update both pins, run the existing App and Native Browser checks, and
remove both patch entries.

Use the shared [upstream refresh procedure](../../CONTRIBUTING.md#temporary-dependency-patches)
to prepare and review updates without changing the current pin.

The unpublished combination includes the application GoogCc adapter, complete
H264 access units, shared encoding ownership and coordinated UDP socket handoff.
Its current-source patch, frozen dependencies and Windows/Linux evidence are
indexed by `build/native-current-assembly/receipt.json`; the adjacent README
describes the local acceptance candidate. Whole-App acceptance and promotion
remain in [TODO](../../docs/todo.md), alongside the dependency-publication hold.
That index also owns the separately frozen Linux and macOS incoming-H264
extensions, which reuse the same derived producer, source clock and independent
encoding owners. Each candidate's receipt records its platform checks.

## Run

Start the [domain and shared Web interface](../channel-server/README.md#run),
then run this participant with Rust 1.91. The shared core and Browser/WASM adapter
retain their Rust 1.86 requirement; the newer toolchain belongs to this Native
media dependency.

```powershell
$env:CHANNEL_WS_URL = "ws://127.0.0.1:8791/prototype/channel"
$env:CHANNEL_UI_ORIGIN = "http://127.0.0.1:8790"
$env:PIIK_CHANNEL_NATIVE_KEY = "<the configured domain owner key>"
New-Item -ItemType Directory -Force build/channel-native-data | Out-Null
cargo +1.91.0 run --manifest-path prototype/channel-native/Cargo.toml -- --room build/channel-native-data/lounge.sqlite lounge "Lounge"
```

Use your configured key, never the placeholder. An existing user credential can
instead be supplied through `PIIK_CHANNEL_NATIVE_CREDENTIAL`; the optional
`PIIK_CHANNEL_NATIVE_NAME` selects the user's display name. Credentials are not
printed or saved by this launcher. Reopening saved room data requires the same
authenticated user. Reuse the domain owner's stable key for the example above.

Repeat `--room <database> <id> <name>` to operate several rooms. Each room has a
separate database and an OS file lock held by its runtime. A second process
cannot open that room while the first holds it. Existing files restore their
saved policy; command-line names do not overwrite it. Live calls, captures and
routes are never restored from disk.

Open the normal Web interface in separate Browser profiles, enter the room and
join voice. The Native endpoint is the base root; it does not borrow the domain
administrator page's peer connection. Ctrl+C ends hosting and confirms departure
through the existing domain protocol. An abrupt process loss uses the normal
20-second recovery window.

## Checks

```powershell
cargo +1.91.0 test --manifest-path prototype/channel-native/Cargo.toml
cargo +1.91.0 build --manifest-path prototype/channel-native/Cargo.toml
node prototype/channel-server/run-browser-check.mjs --native
```

The Browser check also needs a built domain executable and the existing
`agent-browser` environment. `CHANNEL_NATIVE_EXECUTABLE` and `CHANNEL_EXECUTABLE`
can select separate Native and domain builds. The runner owns its processes,
temporary databases and Browser sessions, and stops them on completion.

The peer check uses real WebRTC endpoints for source replacement, signaling
recovery, encoded audio/video forwarding and feedback under backpressure. The Browser
check covers concurrent Native-rooted picture, voice and file forwarding,
room-owned history, independent picture playback and process restart. Generated evidence stays under
ignored `build/`.

The real session and App integration tests live with the
[Server/App runtime](../channel-server/README.md#checks). Build this participant
first; `CHANNEL_NATIVE_EXECUTABLE` can select its executable when using a custom
Cargo target directory.
