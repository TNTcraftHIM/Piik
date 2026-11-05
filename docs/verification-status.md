# Verification Status

Last updated: 2026-11-05

This file summarizes evidence boundaries that materially affect product claims.
[Status](./status.md) owns candidate and deployment readiness; research owns
measurements and platform details.

## Current Evidence

Windows App and Browser are the primary acceptance targets. Room voice
passed the normal Host/Viewer flows on P2P and embedded SFU, including
channel activation, forwarding, source replacement and recovery. Controlled voice
checks cover Browser/App endpoint combinations, SFU fallback and UDP interruption;
they do not establish a population connection rate. Native H264/VP8,
constrained-network recovery, the media lifecycle, responsive UI and packaging
checks also passed. Exact results stay with their measured artifacts and revision.

The owner accepted the earlier scoped interaction, Native and Browser media
phases, including NAT and Auto codec behavior.

Isolated 3.0 Native processes pass calibrated Linux kernel-NAT controls for
ordinary and prepared UDP connections, short-interruption continuity and
replacement after a lost NAT mapping. These controls observe DataChannel
readiness and bidirectional transport traffic. Real Browser capture also decodes
through a Native room operator and through a prepared two-Native transit path,
with progressing voice and source sound. Prepared Native transit and Browser
relay controls also recover decoded picture and current source sound after
50-second UDP interruptions. The
[network laboratory](./research/network-lab.md#rust-process-controls) owns these
controls; platform-specific integration remains in [TODO](./todo.md).

## Device Evidence Boundary

- The isolated 3.0 Windows desktop archive serves its bundled Web/WASM and build
  identity from an independent directory, then exits cleanly on native Ctrl+C.
  Current str0m App and Server archives pass their normal package checks,
  including served source identity, WASM/notices, SQLite room creation and
  listener release. The [cross-platform candidate build](https://github.com/TNTcraftHIM/Piik/actions/runs/41970650750)
  at `5e56589e` passes all six App and three Server packages. Both Linux
  container architectures pass shared-Web loading, authenticated Native rooms,
  persistence across recreation and clean shutdown.
- The combined Windows App and Server pass normal production-UI chat, voice and
  viewing flows. The App's native window capture decodes as H264 in the Browser;
  closing the captured window retires its share while room chat continues.
  A normal App-hosted room retains GUI message reactions across peer reloads,
  including removal. Synthetic-microphone voice keeps its capture and controls
  through floating and actual Document PiP surfaces, retaining drafts and attachments.
  Server's default dual-stack listeners retain usable IPv4 paths when IPv6 has
  no advertisable address. Both programs release their listeners on native Ctrl+C.
  The `5e56589e` packaged App also retains its hosted rooms and confirmed
  conversations across selecting-page exit and launcher reentry, while personal
  voice and screen activities retire independently. Its normal two-Browser flow
  carries verified files, synthetic-microphone voice and decoded picture.
- macOS/Linux builds and bounded native checks are distinct from physical
  capture and input. Physical platform coverage remains limited.
- The isolated 3.0 macOS Native and App pass an
  [Apple SDK and package check](https://github.com/TNTcraftHIM/Piik/actions/runs/41970650750)
  at `5e56589e` on both architectures, including ScreenCaptureKit, VideoToolbox,
  source sound, native microphone capture/conversion and Quartz input.
  A [synthetic VideoToolbox control](https://github.com/TNTcraftHIM/Piik/actions/runs/41779145779)
  at `4cbd5664` also runs H264 encode/decode, source-time preservation, forced
  keyframes and encoder teardown on hosted macOS through the production adapter.
  Both architectures verify LaunchServices startup, startup-error cleanup and
  direct-process startup and shutdown. The runner requires Automation consent
  before sending Quit. System Quit,
  Dock/Finder reentry, permissions, capture, sound and input remain device acceptance work.
- The isolated 3.0 Linux adapter passes Native/App/Server compilation and real
  GStreamer encoding checks in a Linux VM. Synthetic frames cover independent
  encoders, backpressure, resizing, source timestamps, keyframes and teardown;
  synthetic PCM covers queue-loss gaps. A real GNOME Portal session supplies
  PipeWire frames with the source clock. Cancelling pending control permission
  preserves that stream and the Portal service; accepting it delivers encrypted
  keyboard and pointer input to a desktop window. Stopping capture releases
  its Portal sessions and stream. Closing a source during pending control
  permission cancels the old request and dismisses its dialog; a subsequent
  capture produces fresh frames with input Off and no input endpoint.
  The GNOME cancellation cleanup defect is
  recorded in the [network design](./research/channel-network-design.md#implementation-boundary).
  Real GlobalShortcuts approval binds the preferred Super + Alt + F10; actual
  EIS keyboard activation retires input grants while the original PipeWire
  capture produces a newer frame. Source cancellation retains input Off but
  the GNOME shortcut provider leaves its dialog visible, as recorded by the
  same evidence owner.
  Hardware encoding and physical sound remain platform acceptance work.
- The isolated 3.0 Android Rust App builds ARM64/x64 packages and passes emulator
  system-browser linkage, screen selection, decoded H.264 picture and captured
  source sound. Its packaged Web/WASM loads in the system Browser; room history
  and message reactions survive page reloads. Same-signature updates preserve
  App data. Picker cancellation,
  pending-page cancellation and capture stop preserve the running room.
  Notification Stop joins the runtime and closes its listeners; launcher reentry
  retains the running domain without resuming capture. App-owned public rooms
  deliver picture directly from their Native host to the desktop Browser.
  Firefox Site approval from a Browser-hosted public room completes automatically,
  including permission waits longer than the network deadline. Stopping the share
  retains the App connection without late retired-path errors.
  Android receiver controls also carry VP8 and source sound through the Native
  room operator; an unsuccessful background direct trial preserves that path.
  A separate Chromium control forwards a received VP8 track through the shared
  Browser transport and encoding pool to a desktop receiver. The room supplies
  that VP8 input through a desktop Browser relay after Native H264 capture.
  An approved Android Native helper also forwards compatible H264 through normal
  room plans to Firefox and a desktop child, without Browser re-encoding.
  Capability-aware Native H264 capture passes source replacement while retaining
  the physical peer and continuing to decode. Native VP8 also delivers decoded
  picture. The normal `76066c41` package delivers 720p VP8 and actual source
  sound to Chromium: decoded PCM follows a 440 Hz source and returns to silence
  on pause. Cancelling replacement keeps the same receiver, stream, audio track
  and SSRC; concurrent room microphone capture and final capture cleanup pass.
  The normal `5fe433e9` package also passes same-device Native-to-Chrome
  capture on the official Android 15/API35 emulator with C2 H264 and VP8 encoders.
  Each codec passes two consent/start/stop cycles with fresh decoded and presented
  frames. Rotating the captured display preserves the selected SSRC and advances
  playback; stopping releases the projection and encoder workers. Chrome 124 runs
  the normal Web/WASM.
  An active encoder failure reaches the selecting page without ending the App or
  room. The same page can start another decoded share and stop it normally.
  A failed picture route stays visible during retries while the source and chat
  remain live; normal sharing stop clears that result and releases capture.
  Normal-package codec-rejection retries keep the same physical peer and media
  section count; a later supported capture decodes on that retained connection.
  MuMu's software OMX service has crashed during both VP8 and H264
  encoder creation. Independent Java/Surface VP8 controls reproduce that
  assertion with direct release and with stop before release. The normal H264
  trial's service failure precedes worker release; Android restarts the service,
  and subsequent encoding produces the public-peer picture below.
  The same normal package passes the
  [public-peer control](./research/network-lab.md#rust-process-controls): a remote
  Browser receives signed room history, confirmed chat and decoded H264 directly
  from its Native endpoint across independent public UDP egresses. Desktop Web
  controls this trial's App through loopback forwarding; Android system-browser
  behavior remains covered by its separate checks above. Earlier same-egress
  failed controls receive STUN discovery replies but no peer datagrams; that
  packet-loss point remains open.
  The Firefox relay failure is now traced to Gecko image-conversion errors:
  incoming Native H264 decodes while outgoing video remains unencoded. Automatic
  direct replacement delivers picture.
  On that emulator, exporting the decoded input through 2D Canvas, WebGL or
  VideoFrame did not provide usable picture data; a synthetic Canvas VP8
  control worked. Mozilla's Android tests disable hardware decoders for their
  [SurfaceTexture readback failure](https://bugzilla.mozilla.org/show_bug.cgi?id=2050179#c6).
  No picture-conversion workaround is integrated.
  Independent Rust encoder controls pass bitrate updates, keyframe requests,
  source-clock preservation and sibling isolation on the emulator's software codec.
- The published 2.x Android system-browser App passed emulator screen/camera sharing
  with concurrent room voice. Browser consent returns to the same tab; source
  replacement, cancellation and background return preserve the share. Local/public
  startup and launcher reentry also have emulator evidence. Full-App checks now
  cover concurrent original/lower encoding, live-budget reduction and recovery,
  static-source late joins, lower-output retirement, capture stop and restart.
  The [capture assessment](./research/cross-platform-client-runtime.md#android-encoder-budget)
  owns measured bitrate bounds and the stock FrameDropper's saturation limit.
  Phone/tablet/TV hardware coverage and physical audio remain limited.
- The separate iOS system-browser implementation passes Apple SDK device and
  simulator builds and its session/encoder checks. Physical capture, background
  lifetime and hosted-site linkage remain in the [held iOS scope](./todo.md#held-by-owner).
- Windows HDR-to-SDR has synthetic GPU and decoded-video evidence; it does not
  establish Browser-capture HDR conversion or end-to-end HDR. The
  [fidelity assessment](./research/media-fidelity.md#hdr-to-sdr) owns that boundary.
  The isolated Rust source adapter also passes GPU tone-map controls and normal
  SDR App sharing/preview regression; physical HDR display checks remain separate.
- Audio-exclusion availability follows actual platform capability. The
  [audio assessment](./research/native-client-media.md#windows-audio-exclusion)
  owns supported interfaces and isolation evidence.
- Room-voice acceptance uses synthetic microphones. It establishes the route and
  membership lifecycle, not acoustic echo performance on every physical device.
- Remote-control UI and routed input have local evidence. OS permissions,
  protected/admin applications and game compatibility retain the limits in the
  [input assessment](./research/room-interactions.md#attended-remote-control-prototype).
- A two-device Windows virtual-LAN trial established direct packaged-App web
  access and remote video after scoped firewall permission. Other networks must
  likewise carry HTTP/WebSocket and media UDP. [Virtual LAN research](./research/nat-traversal.md#routed-virtual-lan-discovery)
  owns the measured setup.

## Adaptation Boundaries

WebRTC and LiveKit own adaptation. The
[encoder-pool research](./research/webrtc-encoder-pool.md) and
[network controls](./research/network-lab.md#sustained-quality-recovery) distinguish
Native recovery fixes from Browser-controlled recovery and sustained-loss limits.
Browser scripts cannot tune the encoder's internal QP thresholds.

The combined 3.0 Native candidate's capture-free embedded Server passes the
VP8 and H264 dual-downlink restoration and healthy-sibling isolation controls.
When the connection grant falls below every available source representation,
forwarding pauses rather than changing another connection's source.
The H264 startup reproduction traced sequence gaps to a 64 KiB UDP receive
buffer. The shared socket correction receives the complete burst, and the
same Browser/Server startup reports zero loss for both supplied layers.
The combined Server candidate also carries room data and Opus/H264 RTP through
one real FRP UDP entry alongside IPv6. Peers retire independently; closing them
and the shared transport releases both address families' ports.
Its funded H264 encoding handoff survives an ignored first refresh request;
the old encoding keeps playing until the new keyframe is adopted.
In the earlier RTC/GoogCc Browser-to-Native H264 control, the constrained encoding follows
GoogCc's budget and ordinary AIMD growth; the supplied Original encoding is not reused within
the observed 20 seconds. A bounded check of the same controller exercises its
existing ALR probe requests when actual sending becomes supply-limited.

The selected str0m replacement passes real Browser-to-Native-to-Browser VP8
constrain/restore with a separate healthy voice pair, shared A/V source-time
mapping, warm-output handover and fixed/prepared UDP ownership. Normal room
acceptance also carries stereo sound, confirmed history and file data through
the Native operator. Its STUN and authenticated coturn checks use the same public
socket adapter. The current WGC/H264 8 Mbps → 600 kbps → 8 Mbps observation
uses the SDK controller and corrected local deadline handling. During restoration,
the lower encoding continues decoding while the higher encoding waits for its
budget. Both supplied feeds resume between 5.1 and 6.1 seconds after restoration.
The final ten seconds deliver about 16.2 fps on all four receiver/encoding paths;
matched high-encoding snapshots are byte-identical between receivers. The observer
now follows the production per-SSRC AU path, removing its obsolete shared replay
filter. Earlier failed observations retain their original source and results.
Receipts retain their exact source identities in the
[Native candidate index](../prototype/channel-native/README.md#rtc-dependency).
Windows received-VP8 controls also exercise the real shared decoder and two
constrained encoders, including independent pause/recovery and decoder retirement.
Original access-unit bytes and the source RTP/Sender Report clock remain unchanged.

Windows H264 retains CBR after the [burst and recovery controls](./research/webrtc-encoder-pool.md#h264-burst-and-recovery):
the smaller-burst VBR candidates failed live-quality recovery. CBR restores
encoding rate and quality after low-rate startup. Normal Windows App checks
also cover H264 sharing, visible Stop, retained room access and resource release.

## Interpretation

Evidence applies to its tested revision, device and workload. Builds and local
controls establish their named behavior; they do not promise every remote network
or device or a population NAT success rate. Browser/OS suspension is not a
keepalive guarantee.
