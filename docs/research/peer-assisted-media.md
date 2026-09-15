# Browser Peer Relay Evidence

- Research date: 2026-08-22
- Status: retained Browser relay capability and measurement evidence

Current product behavior is owned by
[Routing and transport](../standards/routing-transport.md). Controller and
capacity decisions are owned by
[ADR-0005](../adr/0005-automatic-hybrid-media-routing.md). This document does
not define route selection, wire messages, UI, or current deployment state.

## Conclusion

A normal Browser can receive a remote WebRTC video track and add it to another
`RTCPeerConnection`. This is the compatibility-first peer relay path and can
distribute Host upload across participating Viewers.

It is not encoded forwarding. The remote track exposes decoded frames, and
each downstream `RTCRtpSender` owns another WebRTC send stream and encoder.
The safe resource model is therefore:

- every relay hop decodes and re-encodes video;
- every child is another outbound media copy and network flow;
- repeated encoding can add CPU/GPU work, latency, and generational loss; and
- peer assistance distributes aggregate traffic but does not eliminate it.

Local Chrome controls proved that bounded Browser relays can forward media to
multiple descendants. They did not prove shared encoding, game readability,
public-network quality, mobile relay survival, or endurance.

## Standard Browser Relay

WebRTC permits one `MediaStreamTrack` to be sent by multiple
`RTCRtpSender` objects, but it does not promise a shared encoder. Current
libwebrtc constructs a `VideoSendStream` and `VideoStreamEncoder` for each send
stream. A product must assume one encoder pipeline per sender even if a Browser,
driver, or GPU happens to optimize a particular run.

A remote video track enters the receiver as decoded `VideoFrame` data. Adding
that track to a downstream connection feeds raw frames into a new sender and
encoder. A relay with two children therefore has two independent outbound
senders in addition to its upstream receiver.

Cloning the track or using `VideoTrackGenerator` may share capture or raw-frame
processing. Neither API shares the encoded bitstream or the downstream RTP,
congestion-control, keyframe, retransmission, and encryption state.

## Why Browser APIs Do Not Provide Shared Encode

### Encoded Transform

WebRTC Encoded Transform sits after a sender encoder or after a receiver
depacketizer. Its frame ownership rules do not permit moving an encoded frame
from one transform source into another sender's RTP pipeline. Replacing bytes
in dummy frames would still run the second encoder and would couple unrelated
codec metadata, cadence, dependency, and keyframe state. That is not a
supported encoded-frame tee.

### WebCodecs And DataChannel

WebCodecs can produce `EncodedVideoChunk` values but supplies neither a media
transport nor a bridge into `RTCRtpSender`. Sending chunks over DataChannel
would require an application media protocol for at least:

- stream and source generations;
- frame identity, timestamp, duration, type, and codec configuration;
- fragmentation, bounded reassembly, and queue limits;
- keyframe requests and decoder reset; and
- loss, late-frame, unsupported-codec, and reconnect behavior.

DataChannel retains ICE, DTLS, SCTP, and association congestion control, but it
does not provide WebRTC video RTP/RTCP behavior. RFC 8831 also warns that large
messages can monopolize an association when message interleaving is absent and
recommends limiting messages to 16 KB in that case. This is a custom media
plane, not a smaller form of standard Browser relay.

### Native Shared Encode

A native sender may provide an application `VideoEncoderFactory` and coordinate
multiple RTP senders around one hardware encoder. That possibility is outside
Browser JavaScript and is not a ready-made libwebrtc feature. It must reconcile
independent bitrate and keyframe requests, timestamps, codec/profile settings,
and downstream congestion state. It can reduce encode work, but it cannot
remove the network copy required for each child.

## Retained Measurements

All measurements below used synthetic local media and Chrome 151. They are
control and cost evidence, not current product policy or public-network
acceptance.

### Bounded Forwarding

- A 2026-08-21 capacity-two run used one Host and five Viewers at synthetic
  720p30. Host and relay fanout peaked at two. One Viewer served two children;
  each child advanced by 80 decoded frames and about 1.1 MB. All five Viewers
  decoded and cleanup reported no fatal error.
- Exact Browser v10 source
  `fdd5a4a529ff297f41c05ea3388bf484d76afe8f` reached twenty Viewers in a local
  direct-loopback control. That run proves the bounded control and decoded-media
  path only; it does not close resource or quality acceptance.
- A three-Viewer rerun at source `b77f4eb58944` moved a descendant after its
  first-level relay closed and resumed decoded-frame progress in 5,380 ms. The
  Host remained within two outbound media edges.

### Quality And Resource Limits

- The three-Viewer rerun requested 1280x720 at 30 fps, but final samples were
  320x180 at roughly 9-11 fps. Successful forwarding did not imply the requested
  quality.
- Two-second, sixteen-Viewer loopbacks completed without a fatal check for both
  historical cap-two and cap-three arms. Cap two reached depth four with a
  1,167 ms maximum first-decode diagnostic; cap three reached depth three with
  977 ms. Final samples were only 320x180 at 9-10 fps.
- Ten-second, sixteen-Viewer follow-ups observed 320x180 or 480x270. Cap two
  measured Host/relay bitrate 1,716/1,748 kbps, 11.17/11.20 fps, and
  2.086/2.048 ms encode time per frame. Cap three measured 1,589/1,638 kbps,
  10.83/10.87 fps, and 2.071/2.126 ms per frame. Every Host limitation sample
  was `bandwidth`; relay samples were `none`.
- Aggregate Chromium CPU was 221.4% for cap two and 209.8% for cap three, with
  peaks of 250.7% and 246.9%. The arms had different valid interval coverage,
  the runs were short, and CDP could not attribute the totals to an individual
  Host or relay page. These values cannot rank the two capacity settings or
  establish a resource ceiling.

The retained negative evidence is as important as successful decode: local
fanout worked, while requested resolution and frame rate were not sustained and
resource attribution remained incomplete. Real games, weaker devices,
heterogeneous networks, long runs, A/V behavior, and mobile lifecycle remain
unproved.

## Resource Consequences

For observed encoded bitrate `B`, `N` Viewers, and `C` ordinary children on one
parent:

- that parent sends approximately `C * B` plus transport overhead;
- aggregate delivery remains approximately `N * B` across all parents and any
  server-assisted paths; and
- every Browser relay also pays receive/decode plus per-child encode cost.

This is traffic conservation, not a capacity recommendation. Current endpoint
and server admission are defined only by the product contract and ADR-0005.

## Compatibility Boundary

The standard relay uses broadly implemented WebRTC track and sender APIs. It
does not require Encoded Transform, WebCodecs, or
`MediaStreamTrackProcessor`.

The 2026-08-22 browser-compatibility snapshot showed why the custom encoded
alternative has a narrower surface: `RTCRtpScriptTransform` and `VideoDecoder`
availability varied by Browser/version, and `MediaStreamTrackProcessor` was
still missing or partial in important targets. API presence also does not prove
support for the exact codec, profile, resolution, or hardware path; runtime
configuration checks and media evidence would still be required.

## License Boundary

This research uses W3C/IETF specifications, BSD-licensed libwebrtc source,
public browser-compatibility data, and an official TeamSpeak technical
statement. No GPL/AGPL implementation code was copied. GPL/AGPL projects remain
study-only unless a separate distribution decision accepts their obligations;
the repository's own [MIT license](../../LICENSE) does not replace theirs.

## Primary Sources

- [WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [Media Capture and Streams](https://w3c.github.io/mediacapture-main/)
- [Media Capture Transform](https://w3c.github.io/mediacapture-transform/)
- [WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [WebRTC Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)
- [libwebrtc video engine](https://webrtc.googlesource.com/src/+/refs/heads/main/media/engine/webrtc_video_engine.cc)
- [libwebrtc video send stream](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)
- [libwebrtc video RTP receiver](https://webrtc.googlesource.com/src/+/refs/heads/main/pc/video_rtp_receiver.cc)
- [libwebrtc `VideoEncoderFactory`](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_factory.h)
- [libwebrtc `VideoEncoder`](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder.h)
- [libwebrtc license](https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE)
- [TeamSpeak single-encoding explanation](https://community.teamspeak.com/t/ts6-beta-community-update-insights/58116/208)
- [Encoded Transform compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/RTCRtpScriptTransform.json)
- [WebCodecs `VideoDecoder` compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/VideoDecoder.json)
- [`MediaStreamTrackProcessor` compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaStreamTrackProcessor.json)
- [CDP `SystemInfo.getProcessInfo`](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/)
