# Realtime Screen-Share Quality Adaptation

- Research date: 2026-08-19
- Scope: realtime game screen sharing in the browser
- Status: implementation input; real-device quality remains unverified

## Finding

Screener should not optimize one quality dimension at the expense of the
others. `maintain-framerate` may preserve motion by reducing resolution until
game UI, maps, subtitles, and text become unreadable; `maintain-resolution`
may instead lower frame rate. Neither preference overrides congestion control.

The current bounded implementation retains the game-oriented `motion` hint,
defaults to `maintain-resolution`, and offers explicit balanced and fluid
choices. This is a readability-first default, not a quality guarantee: the
WebRTC API describes a user-agent preference rather than its algorithm, so
Chromium, Firefox, and Safari behavior still needs measured comparison.

The inspected Chromium/libwebrtc source chain makes a screen-only shortcut
especially unsafe to assume for Screener. The JavaScript `motion` hint reaches
`VideoRtpSender` as `kFluid`, which explicitly clears `options.is_screencast`.
`WebRtcVideoSendStream` then configures the encoder as `kRealtimeVideo`, while
`VideoStreamEncoder` only reinterprets `BALANCED` as `MAINTAIN_RESOLUTION` when
its encoder is marked as screen share. The explicit `balanced` preference still
wins the earlier preference-selection branch, but the later screen-only remap
does not follow from this project path. Treat the effective tradeoff as an
implementation detail to verify, not a product guarantee.

An older libwebrtc experiment could detect animated screen content under
`balanced` and cap it to 1280x720. Commit `1d7d0e6e2c50` deleted that experiment
on 2024-05-22; the commit says it had already been disabled for several years
and was not maintained. Current Chromium behavior must therefore not be
described as automatically detecting game motion and forcing a 720p cap.

## Production Degradation Report

On 2026-08-19 production `769de201f7cc` was reported to become severely blurry
while the host repeatedly showed a sustained native
`qualityLimitationReason=bandwidth`, despite one capable viewer on the same LAN
and the UI showing direct P2P. This is a user report, not yet an instrumented
root cause. The probe is read-only, requires three consecutive windows, and
does not change media. Same-LAN/direct does not exclude Wi-Fi loss or queuing,
per-PeerConnection GCC, aggregate host-uplink contention, or browser bandwidth
underestimation; isolated encoder pressure would more commonly report `cpu`.

Only a full Host refresh and re-share was reported to restore immediate
high-definition, fluid video; Viewer refresh did not. With a stable
session-storage `clientId` and reconnect inside the five-second grace, Viewer
reauth reuses its `peerId` and emits `peer-joined`, while `HostPage.startPeer`
retains an already-connected `HostPeer`; a new tab, storage failure, or expired
grace can instead allocate a new peer. The reported Viewer refresh therefore
did not create a new host PeerConnection/GCC generation. Host-page cleanup
disposes every peer,
stops capture, and creates all-new capture, sender, PC, and GCC generations.
This makes a stuck host sender/PC/GCC or shared-capture generation a priority
hypothesis, not a conclusion. A further report that quality may remain low
after the old viewer leaves and a new viewer joins must likewise be tested
against lifecycle evidence rather than assumed.

Use this as the first A+B/C reproduction before the viewer controller or
`LOW` runtime:

1. Reproduce one wired LAN/direct viewer first, then Wi-Fi, two/three viewers,
   and forced TURN, using the same high-motion scene for 60 to 90 seconds.
2. In one window record A capture; B actual/target/available outbound bitrate,
   dimensions/FPS, codec, encode cost, loss/RTT/retransmission, selected path,
   limitation, and PC/track generations; and C inbound decode/drop/freeze.
3. First retain capture and every healthy peer while rebuilding only the
   affected `HostPeer`/`connectionId`. Separately compare capture/track
   replacement with PCs retained, then a full Host rebuild; do not combine the
   interventions.
4. For viewer churn and stable-`clientId` reconnect, retain old/new
   `peerId`/`connectionId`, `peer-left`-to-dispose time, active sender count
   inside/outside the five-second grace, old snapshot removal, whether a new PC
   actually exists, capture settings, and new-path BWE/limitation.

A single-edge rebuild passes only if the affected viewer recovers, unaffected
viewers neither migrate nor interrupt, and the host-edge cap holds. Only proven
generation-specific failure can justify a later automatic one-edge recovery
with sustained-bandwidth and healthy-counterpart evidence, cooldown, and a
generation guard. Do not add periodic reconnect, blindly raise a ceiling, or
change the current controller before this gate.

Missing `scaleResolutionDownBy` is not itself a root cause for a single encoding
because its effective default is 1.0. Likewise, the current 3/5/8 Mbps values
are ceilings rather than targets. Raising them cannot repair CPU or bandwidth
limitation and should only follow evidence that the encoder is already pinned
to the ceiling while spare transport capacity remains.

The same production release is also reported to reduce game-stream frame rate
and consume noticeable Host resources. That report applies only to deployed
`769de201f7cc`, not automatically to the newer diagnostics on `main`. The Web
sender creates one independent `RTCRtpSender` per viewer and has no cross-PC
shared-encoder guarantee; its muted local preview creates no media edge or
server traffic but may still consume compositor/GPU work. Compare the exact
release and current `main` under one fixture, with preview on/off as a separate
binary intervention.

## Codec And Hardware Gate

Do not default to AV1 from compression efficiency alone. The deployed release
does not call `setCodecPreferences()`, and a browser may expose a negotiable
codec without a power-efficient WebRTC encoder. `getCapabilities()` establishes
only an optimistic negotiation set; Media Capabilities supplies
supported/smooth/power-efficient candidate evidence; outbound `codecId`,
`encoderImplementation`, and `powerEfficientEncoder` describe the stream only
when the browser exposes them. Final acceptance still requires interval encode
cost, game FPS, CPU/GPU video-encode activity, and active sender count. Chromium
`main` on the access date gates WebRTC AV1 hardware encoding off by default on
Windows even when a platform accelerator exists; this is an implementation
snapshot, not a permanent browser contract.

First diagnose the Host-refresh case using the browser-selected codec. Only if
encode cost or `cpu` limitation is abnormal, hold scene, resolution/FPS/bitrate,
network, and viewer constant while comparing browser default, H.264, and VP8.
VP9 or AV1 enters that spike only when both endpoints can negotiate it and
Media Capabilities reports the exact configuration supported, smooth, and
power-efficient. A preference change must retain negotiated repair codecs and
is successful only when outbound stats prove the codec actually in use; silent
software fallback fails the gate.

Discord's published Go Live material is a useful architecture comparison, not
a preset to copy. It describes native OS/driver-integrated capture and encoding,
GPU hardware encoding, WebRTC transport, and product-specific rate-control
tuning. It also documents a feedback loop that could lock 60 fps output down to
30 fps. This supports measuring the complete capture/encoder/congestion loop;
it does not show that Discord servers re-encode each viewer stream or that AV1
is universally cheaper. No equivalent first-party implementation evidence was
found for KOOK or Oopz, so they are not used as design facts.

## Evidence Before Adaptation

Verified specification facts: the W3C stats model supports the needed
separation but does not produce the product decision itself.
`MediaStreamTrack.getSettings()` supplies the actual
capture dimensions/frame rate. Outbound RTP exposes emitted dimensions/FPS,
byte and retransmission counters, encode time, target bitrate when available,
and the current `qualityLimitationReason`; the selected candidate pair can
expose RTT and available outgoing bitrate. Inbound RTP exposes received
dimensions/FPS, byte/loss/jitter counters, decoded/dropped frames, and freeze
counters when implemented. Stats members may be absent, and cumulative values
must be compared across two samples rather than treated as interval values.

The user-facing loss value should therefore be an RTP interval loss rate, not
the cumulative `packetsLost` counter and not a claim about UDP itself. For one
unchanged RTP stats object, compute `lostDelta / (receivedDelta + lostDelta)`;
an initial sample, reset, negative delta, zero denominator, or absent field is
unknown. `RTCReceivedRtpStreamStats` defines both counters and notes that
`packetsLost` can be negative. `RTCIceCandidateStats.address` is privacy-sensitive
and remote addresses are null by default unless the application supplied the
candidate. Screener may show a selected address locally in collapsed details,
but it must never enter Viewer C, signaling, logs, exports, persistence, route
selection, or NAT/geography inference.

Correlate one time interval and media generation across:

| Evidence | Fields |
| --- | --- |
| A. Host capture | actual width, height, FPS from `getSettings()` |
| B. Host outbound | width/FPS/bitrate, target/available bitrate, interval encode time, limitation reason, path, RTT, loss/retransmission, and derived negotiated codec/profile/parameters plus applicable `scalabilityMode` |
| C. Viewer inbound | width/FPS/bitrate, loss, jitter, interval decode/drop/freeze, corresponding derived codec/profile/parameters/layer, and actual decode behavior |

Product inference from those facts: use the following ordered classification:

| Correlated observation | Likely boundary |
| --- | --- |
| Capture low | capture or constraints |
| Capture high; outbound low; `cpu` | encoder/resource pressure |
| Capture high; outbound low; `bandwidth` | GCC, uplink, or TURN/path pressure |
| Outbound healthy; inbound low | transport or receiver path |
| Inbound healthy; image visibly blurry | bitrate/quantization, codec, or display scaling |

This is a diagnostic classification, not a weighted health score. Missing or
reset evidence remains unknown and rebases the interval.

The smallest implementation sequence is local A+B correlation in one host
sampling tick, followed by a minimal authenticated C report carrying the
receive/decode and derived negotiation signals needed by the two-state
predicate. It never carries raw SDP, raw stats, candidate addresses, or raw
device/network identifiers. Server-authoritative path and connection generations
provide authorization and correlation; a general remote stats stream or
telemetry pipeline is unnecessary.

The repository implements the local host A+B foundation: same-tick capture
settings plus one uniquely matched outbound RTP sample, explicit sample/media
identity and adjacent deltas, `remoteId` linkage, and the selected path reached
through that RTP stream's transport. Source replacement blocks sampling and
invalidates in-flight generations.

Authenticated Viewer C is also implemented for each current ordinary or
peer-assisted P2P hop. A viewer sends one nullable, sanitized aggregate window
on the existing two-second stats cadence, bounded to 2 KiB; the server derives
the current viewer, parent, connection, and route revision, while the parent
accepts only the matching local generation and expires it. The report contains
no raw SDP, stats, candidates, addresses, device identifiers, or room identity,
is neither stored nor used for media or routing action, and fails closed for an
SFU-fed root until a real SFU last-hop B/generation exists.

Codec evidence follows only that outbound RTP object's `codecId`, and the
referenced `RTCCodecStats` must use the same transport. The local diagnostics
expose nullable, bounded MIME plus a normalized profile token and an ASCII allowlist of
format parameters: H.264 `profile-level-id`, `packetization-mode`, and
`level-asymmetry-allowed`; VP9 `profile-id`, `max-fr`, and `max-fs`; VP8
`max-fr` and `max-fs`; and AV1 `profile`, `level-idx`, and `tier`. Unknown,
invalid, duplicated, oversized, or non-allowlisted fields such as H.264
parameter sets are discarded. This diagnostic path does not expose or persist
raw `sdpFmtpLine`, SDP, candidates, or complete stats, and it does not infer
specification defaults. Profile tokens remain self-describing, for example
H.264 `profile-level-id=42e01f`; they are not translated into quality,
hardware, support, or capability conclusions.

The same unique outbound object supplies nullable current configured
`scalabilityMode`. Sender parameter readback exposes an applied mode only for
one unambiguous encoding. Current quality settings do not request a mode, so
the requested value remains null and a browser-reported default is not called
a mismatch; multiple encodings remain unknown. Inbound stats provide no current
standard `scalabilityMode` source, so C does not carry a null-only placeholder.
The two-state controller and on-demand `LOW` runtime remain unimplemented, and
browser support remains subject to the controlled matrix.

Official W3C text checked 2026-08-19 defines names ending in `Id` as stats-object
references. In particular, outbound [`mediaSourceId`](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-mediasourceid)
references the sender's current media source, whose
[`trackIdentifier`](https://www.w3.org/TR/webrtc-stats/#dom-rtcmediasourcestats-trackidentifier)
is the `MediaStreamTrack.id`; RTP [`transportId`](https://www.w3.org/TR/webrtc-stats/#dom-rtcrtpstreamstats-transportid)
references its transport, and that transport's
[`selectedCandidatePairId`](https://www.w3.org/TR/webrtc-stats/#dom-rtctransportstats-selectedcandidatepairid)
references its selected pair. Therefore an ambiguous RTP set or a broken or
cross-transport reference remains unknown; an opaque stats ID is not a safe
substitute for those relationships.

The same specification defines [`codecId`](https://www.w3.org/TR/webrtc-stats/#dom-rtcrtpstreamstats-codecid)
as the RTP stream's reference to `RTCCodecStats`, whose `sdpFmtpLine` contains
format-specific negotiated parameters, and defines outbound
[`scalabilityMode`](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-scalabilitymode)
as present only when a mode is currently configured for that stream.
WebRTC-SVC separately permits post-negotiation `getParameters()` to return a
different configured mode from one explicitly requested. If no mode was
provided, its absence must not be replaced with an implementation-dependent
default. Chromium currently maps its configured per-stream mode into the
outbound stats field; other browser implementations may omit any optional
member, which remains null rather than a capability conclusion.

## Accepted Adaptation Direction

ADR-0007 rejects room-wide worst-link adaptation. Healthy operation has one
shared `HIGH` representation. A viewing path enters `FALLBACK` only after
multiple consecutive windows show insufficient bandwidth, freezes, or decode
pressure in correlated sender/viewer evidence. The first verified weak path
starts one shared `LOW`; all weak paths reuse it while healthy paths remain on
`HIGH`. Recovery requires a longer stable window than entry. When the last weak
path recovers, stop `LOW`. The hard representation limit is two, never one per
viewer.

`LOW` itself is conditional: if no qualified hardware/power-efficient media
path exists or the additional representation exceeds the measured CPU/GPU/game budget, the
controller preserves `HIGH` and fails visibly for the weak path. It never buys
weak-path recovery by degrading healthy paths.

That fail-closed result is exceptional damage containment, not a supported
steady state. A supported sender cohort that cannot reliably start the one
shared `LOW` on demand fails automatic-quality-control acceptance; its encoding
path must be improved or the cohort explicitly marked unsupported. `HIGH`
remains protected in either case.

A viewer's `LOW` request is advisory and must be authenticated, session-bound,
rate-limited, deduplicated, and corroborated by sender transport/encode and
viewer receive/decode stats. UA or device-model detection is not quality
evidence; the current mobile/iPad heuristic remains restricted to relay
capacity.

An ordinary non-scalable stream cannot yield a second independent quality by
packet forwarding alone. The alternatives are a second representation,
scalable layers, or relay/SFU transcoding. Screener tests standard capabilities
before custom media. SVC is the third short-circuit candidate when simulcast
and LiveKit/Dynacast fail; adoption requires an exact negotiated mode, a
positively established hardware or power-efficient path, and measured game
performance. WebRTC-SVC permits the browser to return a
different configured `scalabilityMode`; Media Capabilities reports support and
expected smoothness/power efficiency for a specified configuration; WebCodecs
defines `hardwareAcceleration` only as a hint the user agent may ignore.
Therefore none is, by itself, proof of a particular hardware encoder, and a
software SVC fallback must not be silent.

After trustworthy A+B/C, evaluate three bounded capability spikes in order and
stop at the first accepted path before custom dual-representation media work;
they do not wait for ADR-0006 native-sender product acceptance. First, negotiate
`HIGH`/`LOW` simulcast in one sender's
initial envelope with `LOW` inactive and prove applied parameters, per-RID
bytes/frames, and CPU/GPU/encoder release; separate PeerConnections have no
portable shared-encode contract. Second, test at most two independently
selecting LiveKit roots, but expect pinned server 1.13.5 to enable every layer
at or below the maximum requested quality, so a `HIGH` root also keeps `LOW`
enabled; client 2.22.0 then applies `active`, with Firefox using only a low-rate,
low-FPS, 4x-scale fallback. Reject Dynacast for the exact on-demand-`LOW`
requirement unless runtime and resource counters disprove that boundary. Third,
compare requested/applied SVC mode and Media Capabilities `powerEfficient`,
with no software fallback. None may bypass PR #28's stock-GCC/RTX stop line.

Retain a favorable, testable hypothesis: on target GPUs, adding one low-rate,
low-resolution hardware `LOW` representation may have no material game impact.
Compare `HIGH` against `HIGH+LOW` under one scene using game FPS/p1 low, CPU,
GPU video-encode/copy activity, interval encode cost, actual encoder identity,
and LOW bytes/frames. If the increment stays inside the accepted game budget,
adopt the simpler on-demand dual representation and stop; do not continue into
SVC or custom media merely for theoretical encoder-count elegance.

## Why Offline Encoding Presets Do Not Transfer

[Maruko Toolbox](https://github.com/wzxjohn/marukotoolbox) is an Apache-2.0
GUI around offline video-processing tools. Its x264-style CRF, slow presets,
lookahead, and multi-pass workflows trade encoding time and buffering for file
size and quality. Interactive WebRTC cannot buffer or revisit future frames in
that way. The transferable principle is to treat bitrate, image detail, frame
rate, and encode cost as a joint tradeoff; its concrete offline presets are not
a WebRTC configuration baseline.
The GUI repository is Apache-2.0, while x264 itself uses GPL-2.0 or commercial
licensing; no implementation or preset is copied into Screener.

Discord's published Go Live design reaches the same broad conclusion for
realtime game streaming: bandwidth estimates, frame delivery, image quality,
latency, CPU, and memory conflict and must be balanced. Its native encoder
tuning and hardware integration are not available to a browser-only sender and
must not be presented as settings this project already has.

## Current Policy

The three user-visible profiles remain ceilings rather than promised rates:

| Profile | Capture ceiling | Sender bitrate ceiling |
| --- | --- | ---: |
| 1080p60 | 1920x1080 at 60 fps | 8 Mbps |
| 1080p30 | 1920x1080 at 30 fps | 5 Mbps |
| 720p30 | 1280x720 at 30 fps | 3 Mbps |

The middle profile is an explicit manual 1080p30 ceiling: choosing it trades a
60 fps ceiling for a 1080p capture bound. LiveKit currently uses the same
1080p30 at 5 Mbps screen-share preset, but neither preset guarantees the emitted
resolution, frame rate, or bitrate.

- Initial capture supplies `ideal` and `max` bounds for resolution and frame
  rate; the actual result is read back from `MediaStreamTrack.getSettings()`.
- A live profile change uses `track.applyConstraints()` and updates every
  current sender with `RTCRtpSender.setParameters()`. It does not reopen the
  source picker or renegotiate healthy peer connections.
- The video track keeps `contentHint = "motion"`; recommended profiles default
  to `maintain-resolution`, with explicit `balanced` and
  `maintain-framerate` choices. None promises an emitted resolution or rate.
- `maxBitrate` and `maxFramerate` are ceilings. They are neither minimums nor
  target guarantees, and the project does not use SDP bitrate hacks.
- The folded advanced panel accepts only 720p/1080p/1440p, integer 15-60 fps,
  2-12 Mbps, and the three preferences. It exposes no audio quality controls.
  Display capture does not standardize channel-count or sample-rate control;
  the portable audio `maxBitrate` field is only a ceiling and cannot raise
  quality; and stereo, DTX, and FEC require negotiated fmtp/codec behavior that
  has no portable sender setter. The full boundary is recorded in
  `docs/research/browser-screen-audio-quality.md`.
- Every sender update derives from `getParameters()`, calls `setParameters()`,
  then reads requested/applied bitrate, frame rate, scale, and preference.
  Rejection or browser rewriting is visible rather than console-only.
- One strict room setting is last-wins for current/future peer relays and the
  configured SFU publisher. Ordinary P2P keeps that state local and does not add
  it to the authenticated wire.
- Pausing the picture disables the existing video track, producing black video
  without closing the room or media connection. Audio remains enabled.

The deployed implementation deliberately stops at manual bounded controls. It
adds no composite score, periodic adjustment, codec forcing, SDP bitrate
manipulation, or scene detector. Three consecutive samples of one non-`none` native
`qualityLimitationReason` produce one explanatory warning; a reason change or
recovery resets it and never triggers a media action.

A Chrome 151 loopback smoke with one host, three viewers, and synthetic 720p30
video propagated balanced then clarity settings to every participant. Every
baseline active outbound video sender displayed the matching requested/applied
preference, peer-connection fingerprints stayed unchanged, and every viewer's
decoded-frame and foreground `requestVideoFrameCallback` counters grew after
each change. Host media edges peaked at two and relay edges at one. This verifies
controls and continuity, not visual quality, full-resolution performance,
CPU/GPU cost, public networks, or sustained behavior.

## Deliberate Non-Goals

- No canvas pixel-difference detector, machine-learned rate controller, or
  periodic profile switching.
- No copied x264 CRF/preset recipe in the browser path.
- No forced codec order until target hardware measurements identify the actual
  power-efficient encoder.
- No channel-count, sample-rate, Opus bitrate, stereo, DTX, or FEC control, and
  no inference of actual stereo or sample rate from `opus/48000/2`.
- No promise that all browsers honor `applyConstraints` or degradation
  preference identically.
- No automatic composite quality score or periodic profile controller before
  the controlled production capture identifies a reproducible bottleneck.
- No room-wide minimum-of-viewers target, per-viewer encoder, UA/device quality
  ranking, or silent software SVC fallback.

## Verification Gate

Use the same static UI scene and deterministic high-motion game scene at
720p30, 1080p30, and 1080p60. Correlate A capture, B outbound, and C inbound at
the same interval. Record actual dimensions/FPS/bitrate, limitation reason,
codec, encoder implementation, interval encode/decode cost, drops/freezes,
jitter, RTT, loss/retransmission, selected direct/TURN path, and host CPU/GPU.
A live profile change must preserve peer connection IDs, avoid a second source
prompt, and visibly converge to the requested bounds.

Compute per-frame encode and decode cost from adjacent samples of cumulative
`totalEncodeTime`/`totalDecodeTime` and frame counters. The first sample, a
zero-frame interval, changed stats object, or a counter reset is unknown and
establishes a new baseline. Skip overlapping sampling ticks on the same peer so
reports cannot complete out of order. Do not use a connection-lifetime average
to judge a later overload. Use browser WebRTC diagnostics plus a small run
manifest for time series and percentiles rather than adding a server telemetry
pipeline.

Compare image readability and motion continuity instead of declaring success
from FPS alone. If reproducible evidence later shows that `balanced` still
oscillates or makes the wrong tradeoff on supported machines, revise the fixed
profiles before enabling ADR-0007. Its acceptance matrix must prove one healthy
viewer remains `HIGH` while another enters/recover from `FALLBACK`, that all weak
viewers move to exactly one shared `LOW`, that `LOW` stops after sustained
recovery, and that each supported sender cohort can start it reliably.

## Primary Sources

- [W3C MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC codec preferences](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-setcodecpreferences)
- [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [W3C WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [RFC 6184 H.264 RTP payload format](https://www.rfc-editor.org/rfc/rfc6184.html)
- [RFC 7741 VP8 RTP payload format](https://www.rfc-editor.org/rfc/rfc7741.html)
- [RFC 9628 VP9 RTP payload format](https://www.rfc-editor.org/rfc/rfc9628.html)
- [IANA AV1 media type and format parameters](https://www.iana.org/assignments/media-types/video/AV1)
- [Chromium/libwebrtc video stats origins](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/stats.md)
- [Chromium WebRTC hardware encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium WebRTC AV1 hardware feature gate](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/webrtc/webrtc_features.cc)
- [MDN `RTCRtpSender.setParameters()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [Chromium `motion` to libwebrtc `kFluid` bridge](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/media_stream_video_webrtc_sink.cc)
- [libwebrtc `motion`/`kFluid` sender classification](https://webrtc.googlesource.com/src/+/3b1eab8a69cb5078befb021c5492d3f204a7d6a2/pc/rtp_sender.cc)
- [libwebrtc encoder content-type selection](https://webrtc.googlesource.com/src/+/9caef2a8b88f389af10cee841732c42a98d3d45d/media/engine/webrtc_video_engine.cc)
- [libwebrtc conditional screen-share degradation mapping](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_stream_encoder.cc)
- [libwebrtc adaptation overview](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [libwebrtc per-send-stream encoder construction](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)
- [libwebrtc removal of the automatic animation-detection experiment, 2024-05-22](https://webrtc.googlesource.com/src/+/1d7d0e6e2c5002815853be251ce43fe88779ac85)
- [LiveKit screen-share presets](https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts)
- [LiveKit degradation defaults](https://github.com/livekit/client-sdk-js/blob/main/src/room/participant/publishUtils.ts)
- [LiveKit client 2.22.0 Dynacast layer control](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/LocalVideoTrack.ts)
- [LiveKit server 1.13.5 Dynacast quality aggregation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastqualityvideo.go)
- [LiveKit server 1.13.5 enabled-quality generation](https://github.com/livekit/livekit/blob/v1.13.5/pkg/rtc/dynacast/dynacastmanagervideo.go)
- [Jitsi desktop degradation preference](https://github.com/jitsi/lib-jitsi-meet/blob/master/modules/RTC/TraceablePeerConnection.ts)
- [Discord Go Live architecture](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord encoder-quality case study](https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus)
