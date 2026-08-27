# Realtime Screen-Share Quality Evidence

- Reviewed: 2026-08-27
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
counterfactual parent quality. Quality-driven routing is parked in TODO.

## Open Evidence

- Real games and sustained CPU/GPU contention across weaker Hosts and operating
  systems.
- Exact Chrome 153+ Intel and AMD default H.264 behavior without diagnostic
  feature overrides.
- Codec cost and quality after stock BWE reaches steady state.
- Mixed P2P/SFU public-network quality, long-running thermals, A/V sync, mobile
  lifecycle, and 20-Viewer resource admission.

## Primary Sources

- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [libwebrtc adaptation](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [libwebrtc VP8 encoder](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/codecs/vp8/libvpx_vp8_encoder.cc)
- [libwebrtc startup frame dropper](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/video/adaptation/video_stream_encoder_resource_manager.cc)
- [Chromium WebRTC encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
- [Chromium Media Foundation encoder](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc)
- [Chromium H.264 software BRC](https://chromium.googlesource.com/chromium/src/media/+/24e0453977d38aada35c5e78fcec3d11d6cdea6e)
- [Chromium AMD H.264 workaround](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/config/gpu_driver_bug_list.json)
- [LiveKit publish options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/track/options.ts)
- [LiveKit screen-share encodings](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit Dynacast and simulcast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit server forwarder](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
- [Screego codec ordering](https://github.com/screego/server/blob/v1.12.4/ui/src/useRoom.ts)
- [Screego VP9 regression](https://github.com/screego/server/pull/132)
- [Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [Chrome DevTools Protocol Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)

No implementation code was copied. LiveKit is Apache-2.0, libwebrtc uses its
BSD-style license, and Screego remains GPL research-only.
