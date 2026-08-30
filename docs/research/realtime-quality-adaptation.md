# Realtime Screen-Share Quality Evidence

- Reviewed: 2026-08-30
- Scope: Browser game capture, codecs, startup adaptation, relay, and LiveKit
- Status: current evidence; product behavior is owned by
  [media quality](../product/media-quality.md) and
  [ADR-0007](../adr/0007-path-isolated-representation-quality.md)

## Findings

- Browser settings are ceilings and content intent, not delivered floors.
  WebRTC owns each direct/relay edge's congestion adaptation; LiveKit owns SFU
  representations and subscriber forwarding.
- Windows Chromium WebRTC VP8 is a software `libvpx` path. Web content cannot
  select NVENC, AMF, QSV, a GPU, or a particular Media Foundation transform.
- H.264 can be substantially cheaper when Chromium selects a good hardware MFT,
  but capability or `powerEfficientEncoder` does not prove sender cadence. An
  actual bounded sender probe is required.
- `contentHint = "motion"` is the correct game-motion intent. Removing it may
  retain spatial resolution by changing another quality tradeoff; the observed
  improvement was not free.
- Chromium's `motion + balanced` startup can retain an early low-resolution
  restriction. Starting at `maintain-resolution` and applying the desired
  preference after five encoded frames clears that native restriction without a
  timer or periodic quality controller.
- LiveKit's default screen-share representations, Dynacast, and server send-side
  BWE support weak and strong subscribers. Forcing a permanent lower encoding or
  single HIGH both regress a valid cohort.
- Current route quality evidence is diagnostic. Receiver-only freeze/loss data
  cannot prove an unconnected parent is better or authorize parent-wide/SFU
  routing changes.

## VP8 Cost And Hardware Boundary

Chromium 151's Windows Media Foundation and D3D12 WebRTC encoder factories did
not enumerate VP8. Libwebrtc reports its VP8 implementation as software. Ten
valid GPU Engine samples in isolated Chrome and Edge runs showed zero
`VideoEncode`/`VideoDecode`; 3D activity reflected rendering/texture work and is
not encoder attribution.

Headful isolated loopbacks used a deterministic 1080p source, accepted profiles,
five seconds of settling, and 30 seconds of measurement. Browser CPU includes
source rendering, local decode, and Browser services; 100% is one logical core.

| Browser/profile | Senders | Delivered result | Encode cost | Browser CPU |
| --- | ---: | --- | ---: | ---: |
| Chrome 151, 1080p30 | 1 | 30 fps, 1920x1080, no limitation | 4.06 ms/frame | 96.6% |
| Chrome 151, 1080p60 | 1 | 55-56 fps, 1080p/720p, bandwidth-limited | 3.9-4.9 ms/frame | 123-136% |
| Chrome 151, 1080p60 | 2 | 56.8 fps, 1080p/720p, bandwidth-limited | 5.03 ms/frame | 233.4% |
| Edge 151, 1080p60 | 1 | 44-49 fps, 1080p/720p/540p | 3.2-4.5 ms/frame | 104-138% |

The 60 fps arms remained below the ceiling while encode time stayed well below
the 16.7 ms frame budget. In these short runs, stock bandwidth adaptation and
startup ramp, not a slow per-frame encoder call, coincided with the reduced
cadence/resolution. Web VP8 still competes materially with a game for CPU.

Reproduction uses `npx tsx scripts/peer-assisted-benchmark.ts`; retained commit
and environment details remain in Git history rather than this current evidence
summary.

### Concurrent Sender Cost

A Chrome 151 Windows loopback compared one and three simultaneous high-motion
VP8 senders at 1080p30. One sender sustained 29.7 fps at 4.9 Mbps with median
encode time near 5.0 ms/frame. With three senders, one measured path fell to a
28.7 fps median and 18-22 fps short-window lows while median encode time rose to
14.9 ms/frame; renderer CPU rose from about 88% to 423%. Stopping the other two
senders restored 29.8 fps and closed every retired PeerConnection and sender.
RTT stayed below 4 ms, resolution stayed 1080p, loss/NACK/PLI stayed zero, and
`qualityLimitationReason` remained `none` throughout.

This proves independent Browser encode/render contention that native limitation
classification may not expose. It does not prove a stale sender leak or justify
deriving endpoint capacity from one RTCStats field. A low-motion control also
sustained 29.8 fps while using only about 0.24 Mbps, so payload bitrate alone is
not a quality measure.

An initial same-track versus `MediaStreamTrack.clone()` A/B left a sender on the
original track in both arms. A constrained sender fell near 320x180 at 9-10 fps
while the healthier sender stayed near 960x540 at 28-30 fps; both returned to
720p30 after the constrained sender closed. That experiment established partial
coupling and correctly rejected a bare clone added alongside an original-track
sender. It did not test sender-owned clone generations with a preview-only
original track.

A later Chrome 151 display-capture experiment tested that missing ownership
boundary. The original track fed only local preview; two PeerConnections each
owned a separate clone. Constraining one sender to 120 kbps still caused some
transient cross-clone frame-rate and resolution disturbance, so clones do not
provide complete simultaneous isolation. The constrained sender then remained
limited after its budget returned to 5 Mbps. Closing that sender and stopping
its clone, followed by a new sender with a fresh clone, restored both paths to
1768x938 at about 30 fps for the full 24-second observation. Reusing the original
track instead had repeatedly created a low-resolution replacement sender.

This establishes a Chrome 151 generation-ratchet and a standards-based escape:
an outbound video sender can own one independently constrained clone and retire
the adapted track with the sender. It does not establish complete source
isolation, cross-Browser behavior, or a new congestion controller. Any product
implementation must also preserve live capture-profile changes, `contentHint`,
Host pause/resume, source replacement rollback, and explicit clone disposal.

Production room evidence showed the same partial coupling and ratchet shape at
larger scale. One Host sender remained bandwidth-limited while both same-track
Host outputs fell
near 320x180 at 7-10 fps, even when its sibling reported no native limitation
and materially higher outgoing BWE. After the constrained edge departed, the
surviving path recovered through high-resolution, full-cadence windows. Together
with the controlled experiments, this supports partial shared-source coupling
and track-generation retention; it does not establish a universal all-senders
minimum or quantify its share relative to uplink contention.

## H.264 Root Cause And Gate

Chromium's `has_trusted_rate_controller` is encoder coordination, not a Windows
security classification. Some Media Foundation H.264 paths let both the MFT and
libwebrtc drop frames. A controlled Chrome 151 AMD loopback at roughly
1904x928@30 showed:

- ordinary hardware MFT: 14.18 fps at 14.24 ms encoded-frame cost;
- forced Chromium desktop software BRC on the same MFT: 29.93 fps at 8.17 ms;
- OpenH264 software fallback: 10.47 fps.

This isolates the observed AMD failure to outer bitrate-control/frame-drop
interaction, not a fixed MFT throughput ceiling. The page cannot enable the
process feature, override Chromium's AMD workaround, or select a different MFT.

Later exact Browser cohorts demonstrated why runtime evidence is useful:

| Path | Actual encoder | Source / encoded / decoded | Result |
| --- | --- | --- | --- |
| Chrome 151 direct H.264 | AMD Media Foundation | 30.0 / 12.5 / 12.4 fps | failed cadence despite efficient flag |
| Chrome 153 direct VP8 | `libvpx` software | 29.9 / 29.9 / 29.9 fps | full-cadence control |
| Chrome 153 direct H.264 | NVIDIA Media Foundation | 29.9 / 29.9 / 30.0 fps | full-cadence hardware path |
| Chrome 153 LiveKit H.264 | two NVIDIA MFT encoders | 29.5 / 29.1 / 29.1 fps | HIGH+LOW publication delivered HIGH |

Chrome 153 also sustained two direct H.264 senders and one Host-to-relay-to-child
chain near 30 fps with NVIDIA MFT encode and D3D11 decode at both stages. These
short runs prove cadence and negotiation, not steady game quality or whole-
Browser CPU cost.

The current Auto gate therefore uses a local H.264-only PeerConnection with a
deterministic moving Canvas track at the share target. It verifies negotiated
codec, source progress, and encoded progress rather than trusting capability,
GPU name, or `powerEfficientEncoder`. Unsupported, failed, slow, or inconclusive
evidence selects VP8. Manual VP8/H264 bypasses Auto and strictly applies the
choice.

The probe is share-generation scoped. Source switch, pause, profile changes, and
reparent do not rerun or change active edges. Viewer relays decide once before
their first child. The Host's one SFU publication uses the same resolved codec
and disables backup codec. A static real capture cannot make the decision
inconclusive because probe motion is independent.

VP9, AV1, and H.265 remain unsupported product candidates: Browser codec support
does not prove the desired hardware profile, cross-Browser relay compatibility,
or better real-time cadence. Screego's VP9 default was reverted after a frame-
rate regression and supplies no hidden encoder-selection workaround.

## Startup Quality Restriction

Chrome 151 reproduced the poor initial `motion + balanced` picture in a local
loopback with no external network, VP8 `libvpx`, 1920x1080@30 capture, and 5 Mbps
sender ceiling:

| Startup input | About 1 s | About 8 s | Limitation |
| --- | --- | --- | --- |
| `motion + balanced` | 480x270, 13 fps | 480x270, 14 fps | bandwidth |
| same plus SDP start-bitrate hint | 480x270, 14 fps | 480x270, 14 fps | bandwidth |
| no hint + balanced | 1920x1080, 18 fps | 1920x1080, 20 fps | none |
| `detail + balanced` | 1920x1080, 18 fps | 1920x1080, 20 fps | none |
| `motion + maintain-resolution` | 1920x1080, 17 fps | 1920x1080, 20 fps | none |

Changing only degradation preference at connection or after one encoded frame
retained 270p or 720p. Changing after five encoded frames retained 1080p and
cleared the limitation through the measured window. Five frames is the first
measured safe media fact and follows libwebrtc's four-frame startup-drop bound;
one/two-second timers are unnecessary.

Current senders therefore start with the requested ceiling and temporary
`maintain-resolution`, then the existing stats path applies the user's desired
preference once the exact sender has encoded five frames. The application does
not add an SDP bitrate hint, periodic rewrite, or custom adaptation ladder.

## LiveKit Representation Evidence

Pinned LiveKit client 2.22.0, server 1.13.5, and Chrome 151/153 showed that
default screen-share publication can expose original and lower representations,
and server BWE can forward a lower representation to a constrained subscriber
while another receives the highest available representation.

Forcing a lower encoding permanently consumed the same Host-to-SFU congestion
budget and reduced HIGH performance. Publishing only HIGH abandoned constrained
subscribers. Current ownership is therefore:

- one Host publication for all SFU subscribers;
- no custom `screenShareSimulcastLayers` and no backup codec;
- pinned LiveKit representation construction and republish behavior;
- Dynacast plus server send-side BWE; and
- AdaptiveStream disabled because every Viewer may relay its received track.

A LiveKit H.264 publication may use more than one hardware encoder for its
representations. Reducing Host network copies to one publication does not by
itself prove lower Host encode cost.

## Host And Page Cost Boundaries

Each ordinary Browser child is an independent PeerConnection and normally an
independent encode/network copy. A Browser relay decodes its upstream track and
re-encodes each child. Hardware codec success can reduce per-copy CPU but does
not change endpoint capacity or prove shared encode.

Host page visibility, captured-surface visibility, capture production, encode,
transport, Viewer decode, and local presentation are separate variables. Current
code pauses only the hidden/unfocused local preview. Browser/OS capture muting,
mobile suspension, page reclamation, and relay survival remain platform evidence
in [background capture research](./browser-background-capture.md), not Web
keepalive features.

Web content has no supported API for raising capture, encoder, renderer-process,
GPU, or operating-system scheduling priority. WebRTC sender `priority` allocates
bandwidth relative to other RTP senders and `networkPriority` requests DSCP;
neither reserves encoder CPU. `scheduler.postTask()` orders JavaScript work,
Screen Wake Lock prevents display sleep while visible, and Picture-in-Picture
does not change page visibility. Silent audio, animation loops, or command-line
throttling flags are therefore not product keepalive mechanisms.

The mature resource choices remain bounded Browser P2P copies, one bounded SFU
publication when its accepted route condition applies, or a future native/shared
encoder. LiveKit Dynacast can stop unused SFU representations; it cannot combine
independent P2P encoders.

Production room 4521 supplied a separate network/source boundary. It used one
stable Host-to-Viewer P2P edge with no reparent or SFU activity, yet Chromium
reported `bandwidth` for 112 consecutive sender windows, estimated only
0.42-1.78 Mbps available outgoing bandwidth, and adapted through 960p, 640p and
480p. At the same time, media-source cadence periodically fell to 1-7 fps while
track settings remained 30 fps, and Viewer freeze intervals followed those
lows. The event therefore contained both native BWE degradation and source
cadence loss; topology churn and CSS presentation were not required causes.

## Quality Shadow

Strict v13 reports renderer-derived freeze/pause deltas only for exact current
foreground presentation with continuing decoded progress. Identity and
presentation changes establish a new baseline; missing fields remain unknown.
The controller retains one bounded fresh aggregate per child for the Host-only
acceptance snapshot. It does not change routes, capacity, SFU use, or media
settings.

A controlled production direct-P2P canvas run injected packet-loss pulses:

| Loss/pulse | Recovered freezes | Freeze duration | Outcome |
| --- | ---: | ---: | --- |
| 0% / 2 s | 0 | 0 ms | comparable |
| 10% / 2 s | 0 | 0 ms | comparable |
| 10% / 6 s | 1 | 282 ms | comparable |
| 30% / 2 s | 2 | 701 ms | comparable |
| 30% / 6 s | 11 | 3,585 ms | comparable |
| 100% / 2 s | 1 | 2,011 ms | comparable |
| 100% / 6 s | n/a | n/a | route identity changed |

All comparable arms had zero recovered pauses. The same loss rate produced
different presentation results, and the longest all-drop pulse crossed into
availability recovery. This proves the shadow path, not an active threshold or
counterfactual parent quality.

## Route-Selection Evidence Boundary

Current Viewer evidence cannot identify whether a poor result came from source
capture, an ancestor, the exact sender, the child decoder, or presentation. It
also cannot prove an unconnected path is better. A route decision therefore
needs exact sender evidence and real candidate media; combining current loss,
RTT, bitrate, FPS, resolution, and freezes into a score would not repair either
information gap. [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md) owns
the accepted local-convergence algorithm.

W3C `qualityLimitationReason` is only the most limiting factor at one instant.
Its cumulative `qualityLimitationDurations` can prove a same-identity interval
spent in `none`, `bandwidth`, or `cpu`; missing or reset values remain unknown.
This supplies a categorical native edge state rather than an application score.
One report is still not a future guarantee, so a candidate must carry real media
while the working route remains. A P2P candidate needs fresh healthy evidence
from its exact sender plus clean overlapping same-Viewer receive windows that do
not regress delivered dimensions or frame rate. Requiring an immediate strict
gain can deadlock while the retained and candidate senders still share source
adaptation. An expired one-shot relative proof rejects that candidate rather than
holding the operation until its deadline. Failure remains inconclusive without
cutting the old route.

Production observation on 2026-08-27 showed that one two-second degraded delta
could move an otherwise usable Host Peer edge to an already-active SFU whose
Viewer experience was worse. The SFU proof established healthy publication
ingress and decoded progress, not superiority over the old path. Active routing
therefore needs the existing persistent-limitation semantic, and SFU quality use
must be limited to multi-edge Host fanout relief rather than ordinary edge
replacement.

LiveKit exposes one participant-level `ConnectionQualityInfo` with no direction
field, while stream state only identifies an SFU-paused subscription. Neither
proves that a candidate SFU path is visually better than a retained P2P path.
The bounded canary therefore compares the same Viewer's simultaneous inbound
WebRTC windows by strict non-regression of delivered dimensions, frame rate, and
bitrate, with decoded progress and no freeze or pause. It does not combine them
into a scalar score or infer unconnected path quality. The single SFU
publication does not imply one quality node: Host ingress is generation-scoped,
and every Viewer subscription needs its own candidate proof.

The 2026-08-27 room-6020 canary observed 21 successful Peer candidates, all
within two seconds, and 19 failed candidates with a 15-second median. Reusing the
existing five-second no-progress window for each background Peer candidate
therefore removes measured queue tail without adding a new threshold; candidates
with transport progress still retain the total deadline. The same run showed
that native sender health can recover while a Viewer still reports low delivered
FPS, so receiver-quality routing remains an evidence problem rather than grounds
for an uncalibrated FPS threshold.

Canary logs use stable room-scoped anonymous ordinals. They may record native
limitation reason and bounded sender/receiver FPS and bitrate already collected
by the application, but never display names, raw Peer IDs, SDP, ICE candidates,
tokens or media credentials.

SFU has asymmetric evidence. The Browser publication proves shared Host-to-SFU
ingress, while exact SFU-to-Viewer sending and layer selection live inside
LiveKit. The accepted model therefore keeps SFU as a bounded suffix: LiveKit
owns its stream state and adaptation, and the exact Viewer proves continuing
decoded progress. The application does not manufacture a per-Viewer SFU sender
score or layer choice.

This structure follows libwebrtc's native limitation classification instead of
reimplementing congestion control. QUIC path validation supports retaining a
working path until a new one is proved, but its timers and congestion state are
not copied. Overcast and End System Multicast demonstrate gradual measured
overlay parent changes; their periodic probes, scalar metrics, published
percentages, and tuning loops are not adopted for this Browser product.

## Open Evidence

- Real games and sustained CPU/GPU contention across weaker Hosts and operating
  systems.
- Public-network and game-content resource behavior with two Host P2P copies,
  one LiveKit publication, and bounded candidate overlap. Current evidence does
  not calibrate a safe dynamic endpoint-capacity rule.
- Background SFU-to-P2P convergence currently proves availability before
  replacement; comparative non-regression remains a route decision to validate,
  not an accepted weighted quality policy.
- Exact Chrome 153+ Intel and AMD default H.264 behavior without diagnostic
  feature overrides.
- Codec cost and quality after stock BWE reaches steady state.
- Mixed P2P/SFU public-network quality, long-running thermals, A/V sync, mobile
  lifecycle, and 20-Viewer resource admission.

## Primary Sources

- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC Priority](https://www.w3.org/TR/webrtc-priority/)
- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [libwebrtc adaptation](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [libwebrtc source-wants aggregation](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video/video_broadcaster.cc)
- [libwebrtc VP8 encoder](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/codecs/vp8/libvpx_vp8_encoder.cc)
- [libwebrtc startup frame dropper](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/video/adaptation/video_stream_encoder_resource_manager.cc)
- [Chromium WebRTC encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium Media Foundation encoder](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
- [Chromium H.264 software BRC](https://chromium.googlesource.com/chromium/src/media/+/24e0453977d38aada35c5e78fcec3d11d6cdea6e)
- [Chromium AMD H.264 workaround](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/config/gpu_driver_bug_list.json)
- [LiveKit publish options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit screen-share encodings](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit Dynacast and simulcast](https://docs.livekit.io/transport/media/advanced/)
- [Scheduling APIs](https://wicg.github.io/scheduling-apis/)
- [Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/)
- [Picture-in-Picture](https://www.w3.org/TR/picture-in-picture/)
- [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [LiveKit server forwarder](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
- [LiveKit connection-quality protocol](https://github.com/livekit/protocol/blob/main/protobufs/livekit_rtc.proto)
- [Screego codec ordering](https://github.com/screego/server/blob/v1.12.4/ui/src/useRoom.ts)
- [Screego VP9 regression](https://github.com/screego/server/pull/132)
- [Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [Chrome DevTools Protocol Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [QUIC path validation and migration](https://www.rfc-editor.org/rfc/rfc9000.html#name-path-validation)
- [Overcast overlay parent selection](https://cs.brown.edu/~jj/papers/overcast-osdi00.pdf)
- [End System Multicast adaptation](https://static.usenix.org/events/usenix04/tech/general/full_papers/chu/chu_html/index.html)

No implementation code was copied. LiveKit is Apache-2.0, libwebrtc uses its
BSD-style license, and Screego remains GPL research-only.
