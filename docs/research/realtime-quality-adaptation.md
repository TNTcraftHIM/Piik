# Realtime Screen-Share Quality Adaptation

- Research date: 2026-08-25
- Scope: Browser game-screen capture, encoding, P2P forwarding, and LiveKit SFU
- Status: current Browser policy accepted; real-game, weak-device, and
  heterogeneous-network quality remain open

## Current Conclusion

Browser video is fixed VP8. Display video uses `contentHint = "motion"`, and
display audio uses `contentHint = "music"`. The three recommended profiles and
advanced settings are ceilings, not delivery guarantees. WebRTC owns direct and
peer congestion control; LiveKit owns SFU representations, Dynacast, subscriber
bandwidth estimation, and layer forwarding.

Screener does not define a resolution/FPS/bitrate ladder, custom SFU lower
representation, scene detector, quality score, parent probe, periodic
rebalancing loop, or manual layer selector. It supplies standard content intent,
the selected sender ceiling, and readback of what the browser accepted.

The active topology remains availability-driven. A hard connection failure,
non-paused 15-second decoded-frame stall, parent departure, or capacity
invalidation may trigger the ADR-0005 recovery operation. Loss, RTT, jitter,
bitrate, resolution, FPS, freeze counters, codec, and limitation reason are
diagnostic and cannot prove that another parent would be better.

## Browser VP8 Evidence

Chrome 151 exact-production tests with real `getDisplayMedia()` showed that
direct and Browser-relay VP8 can sustain about 60 fps after the stock bandwidth
estimator warms up. The observed ramp took roughly 25 to 30 seconds; a configured
60 fps or bitrate remains a ceiling rather than a startup promise.

One controlled no-hint/motion comparison showed that Chromium may preserve
motion by spatially downscaling when `motion` is set. That is the standard
content-hint tradeoff for games, not a minimum-resolution contract. Leaving the
hint unset can preserve screen-classified resolution while shifting pressure to
quantization or frame delivery, so the earlier no-hint improvement was not free
adaptation. Current policy follows the standard game-motion intent and leaves
the resulting tradeoff to the browser.

### Chrome 151 Startup Matrix

On 2026-08-25, Chrome `151.0.7922.174` on Windows reproduced the production
symptom in a controlled local loopback with no external network. Every run used
the same fake `getDisplayMedia` monitor at 1920x1080@30, one P2P sender and
receiver, VP8 `libvpx` with `powerEfficientEncoder = false`, and sender ceilings
of 5 Mbps and 30 fps. Only the named startup input changed.

| Startup input | About 1 second | About 4 seconds | About 8 seconds | Limitation |
| --- | --- | --- | --- | --- |
| `motion + balanced` | 480x270, 13 fps | 480x270, 15 fps | 480x270, 14 fps | `bandwidth` |
| `motion + balanced + x-google-start-bitrate=4500` | 480x270, 14 fps | 480x270, 15 fps | 480x270, 14 fps | `bandwidth` |
| no hint + balanced | 1920x1080, 18 fps | 1920x1080, 19 fps | 1920x1080, 20 fps | `none` |
| `detail + balanced` | 1920x1080, 18 fps | 1920x1080, 19 fps | 1920x1080, 20 fps | `none` |
| `motion + maintain-resolution` | 1920x1080, 17 fps | 1920x1080, 20 fps | 1920x1080, 20 fps | `none` |

The transition matrix then started with `motion + maintain-resolution` and
changed only the sender degradation preference to balanced:

| Balanced transition | Observed result |
| --- | --- |
| At connection, about 11 ms | Fell to 480x270 and remained bandwidth-limited |
| After the first encoded frame, about 80 ms | Retained 1280x720 but remained bandwidth-limited |
| After five encoded frames, about 442 ms | Retained 1920x1080 with no limitation through 8 seconds |
| After one or two seconds | Retained 1920x1080 with no limitation through 8 seconds |

This isolates the failure from network, codec selection, hardware encoding,
capture constraints, sender readback, and the startup-bitrate SDP hint.
Chromium maps `motion` to non-screencast realtime video, where balanced permits
startup resolution restrictions; entering or leaving balanced clears those
restrictions. Five encoded frames is the first measured safe media fact and is
beyond libwebrtc's four-frame startup-drop bound, rather than an arbitrary wall
clock delay.

Screener keeps `motion` because its later multilevel resolution adaptation is
required. Each new peer sender and SFU publication therefore starts with the
selected ceilings but an effective `maintain-resolution` preference. After the
current sender has encoded at least five frames, the existing stats path applies
the user's desired preference once. Connected was too early, and one encoded
frame retained only 720p in the controlled matrix; five frames retained 1080p.
There is no added timer, periodic rewrite, or application quality controller.

## LiveKit SFU Evidence

Pinned LiveKit client `2.22.0`, server `1.13.5`, and Chrome 151 established that
the SDK's default VP8 screen-share simulcast can expose original and lower
representations, and that server send-side BWE can select a lower representation
for a constrained subscriber while an unconstrained subscriber receives the
highest available representation.

Pinned LiveKit retains its own codec and startup-bitrate behavior. Screener does
not add an SDP startup hint to raw peers; the controlled matrix showed that it
does not address this `motion + balanced` restriction.

An earlier exact-production A/B also showed that forcing an always-active lower
encoding can consume the same Host-to-SFU congestion budget and reduce the
highest encoding. That evidence rejects Screener mutation of active layers; it
does not justify single HIGH, which abandons constrained subscribers.

Current source therefore:

- creates one Host publication for all SFU subscribers;
- sets VP8, no backup codec, the selected HIGH ceiling, and degradation
  preference;
- leaves `screenShareSimulcastLayers` unset so pinned LiveKit owns construction
  and republish behavior;
- enables Dynacast and server send-side BWE;
- leaves AdaptiveStream disabled because a Viewer may relay the received track
  to children; and
- requests no application-selected subscriber layer.

LiveKit documents automatic bandwidth-based layer selection. It does not expose
an automatic policy that observes delivered FPS and spatially downshifts solely
to satisfy Screener's `maintain-framerate` preference. Adding such a controller
or fork remains outside the current product.

## Codec Decision

VP8 is the only Browser media codec because it has the broadest current Browser
interoperability and produced stable software-encoding behavior in the measured
Chrome path. The page does not select a particular VP8 hardware or software
encoder.

Controlled Windows Chrome evidence localized the poor H.264 result to Chromium's
rate-control path around some Media Foundation encoders rather than a portable
page setting. The same AMD MFT reached the requested cadence only under a
diagnostic browser field trial that a Web application cannot enable. OpenH264
software was not a superior fallback. H.264 remains research evidence for a
later native sender, not a Browser option.

HEVC, AV1, custom WebCodecs pipelines, and application packetization do not
replace the browser WebRTC sender without a new capture, RTP/RTCP, feedback,
hardware, interoperability, and licensing design. No such path is accepted.

## Host Cost Boundary

One Chrome 151 VP8 sample on a Ryzen 7 9700X used about 0.79 logical core for one
1904x928@30 sender and about 1.34 logical cores for two independent senders. The
process totals included capture, WebRTC, source rendering, and local decode, so
they are not a weak-device or real-game capacity claim. Browser peers retain one
independent sender and congestion controller per `RTCPeerConnection`; shared
encoding is not guaranteed.

The accepted way to handle a constrained Host is the existing explicit share
profile. Screener does not silently remove a representation needed by a weak
Viewer or invent a hidden host-performance tier.

## Page Lifecycle Boundary

Host document visibility, captured-source visibility, capture production,
encoder throughput, transport, Viewer decode, and local presentation are
different variables. Current code pauses only the Host's muted local preview
when its page is hidden or unfocused; it does not stop capture or senders.

Browser timers and frame callbacks may be delayed while hidden. A resumed Viewer
must rebaseline the existing decoded-stall wall clock before another no-progress
sample can invalidate the route, and a new current-generation composited frame
is authoritative evidence that stale `connecting` or `reconnecting`
presentation has ended. These rules make recovery lifecycle-safe; they are not
a keepalive mechanism.

The Screen Capture specification permits a user agent to mute a captured surface
that becomes inaccessible, including a minimized captured window. A page cannot
override that platform boundary. Mobile background audio, video recovery, page
reclamation, and relay survival remain physical-device acceptance work.

## Route Quality Authority

Current parent selection hard-filters authorization, source reachability,
acyclicity, capacity, and resource admission, then orders eligible P2P parents
by resulting depth, remaining sender capacity, stable join order, and peer
identity before SFU. It has no network-quality score.

A manual media reconnect stays on the current exact route: P2P rebuilds the
same parent connection, and SFU reconstructs the same subscription. Browser
page refresh also rebinds the same stable participant and committed graph.
Only actual recovery exhaustion enters the normal route-failure operation and
tries other eligible P2P parents before SFU.

Quality-driven relay abdication or active parent switching would require
counterfactual alternative-path evidence, bounded probing, and a separate
ADR-0005 decision. It is not implemented or authorized by current diagnostics.

## Current Verification Gaps

- Real games under competing CPU/GPU load at 720p30, 1080p30, and 1080p60.
- Weaker Windows/macOS/Linux Hosts and actual VP8 encoder implementation data.
- Mixed P2P/SFU sessions on heterogeneous public networks, including recovery.
- Mobile foreground/background playback, page reclamation, and relay survival.
- Long-running encode/decode cost, thermals, A/V synchronization, and resource
  admission at the 20-Viewer bound.

Measurements must correlate capture, outbound, and inbound stats over the same
interval. Missing counters and identity changes remain unknown, not zero.

## Primary Sources

- [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/)
- [Screen Capture](https://www.w3.org/TR/screen-capture/)
- [WebRTC](https://www.w3.org/TR/webrtc/)
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)
- [libwebrtc adaptation overview](https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md)
- [Chromium content-hint capture mapping](https://chromium.googlesource.com/chromium/src/+/3468eea378284a9cc42d05532cf3e1ee1f716fa9/content/renderer/media/webrtc/webrtc_video_capturer_adapter.cc)
- [libwebrtc content-hint sender mapping](https://webrtc.googlesource.com/src/+/98c256dadcab7c69e45de78091da9932d244f2e3/pc/rtp_sender.cc)
- [libwebrtc balanced restriction reset](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/call/adaptation/video_stream_adapter.cc)
- [libwebrtc startup frame dropper](https://webrtc.googlesource.com/src/+/f20ebb8adbf4fa781830e4384c61f732bd28a217/video/adaptation/video_stream_encoder_resource_manager.cc)
- [LiveKit initial-quality fix](https://github.com/livekit/client-sdk-js/pull/1987)
- [LiveKit initial-quality implementation](https://github.com/livekit/client-sdk-js/commit/5db17af)
- [LiveKit screen-share encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/participant/publishUtils.ts)
- [LiveKit video simulcast and Dynacast](https://docs.livekit.io/transport/media/advanced/)
- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/)
- [LiveKit server forwarding](https://github.com/livekit/livekit/blob/v1.13.5/pkg/sfu/forwarder.go)
- [Chromium WebRTC encoder factory](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc)
