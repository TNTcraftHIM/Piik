# Native Pre-encoded Browser Fanout

- Research date: 2026-08-19
- Scope: one native Pion sender, one pre-encoded VP8 sample sequence, and two
  independent unmodified Chromium receivers
- Status: bounded browser interoperability gate passed; product integration is
  stopped on BWE, keyframe, loss-recovery, and lifecycle gates

## Decision Question

Can released Pion public APIs deliver one compatible pre-encoded access-unit
sequence to two independent standard WebRTC browser sessions, with both
browsers actually decoding and presenting changing video frames?

This is the follow-up gate to the
[native RTP fanout oracle](./native-rtp-fanout-oracle.md). It is not a product
topology decision and does not claim one hardware encode. A source sample is
read once by the fanout coordinator, but each transport must retain its own
packetizer, RTP sequence space, SSRC, RTCP feedback, ICE credentials, DTLS
association, and SRTP context.

## Minimal Experiment

- Generate a small synthetic 320x180 VP8 sequence locally with one WebCodecs
  `VideoEncoder` instance. No downloaded or third-party media fixture is used.
- Copy each immutable `EncodedVideoChunk` into the native process as one VP8
  frame. The VP8 WebCodecs registration defines this chunk data as one raw VP8
  frame, which matches Pion's `TrackLocalStaticSample` input boundary.
- Create exactly two Pion `PeerConnection` instances and two independent
  `TrackLocalStaticSample` tracks. Give them different fixed initial RTP
  sequence numbers, then observe actual outgoing headers with Pion's public
  interceptor API.
- Pace one source sample sequence at 30 fps and write the same encoded frame to
  both tracks. Two transport writes per sample are expected; that is transport
  fanout, not duplicate encoding.
- Run two separate headless Chromium receiver processes. Each must report a
  connected peer, decoded frames, `requestVideoFrameCallback` callbacks,
  non-zero dimensions, and at least two distinct rendered pixel hashes.
- Record source samples, fixture encoder input/output counts, per-edge RTP
  packets/bytes/SSRC/sequence bounds, inbound browser frames/bytes, RTCP packet
  counts, ICE credentials, and DTLS fingerprints.

## Acceptance And Stop Lines

Passing proves browser-compatible access-unit fanout over two real independent
WebRTC transports. It does not prove capture, native or hardware encoding,
zero-copy behavior, performance under load, or product readiness.

The spike stops after interoperability evidence. It must not connect to the
product routing controller until separate work proves all of these:

- send-side bandwidth estimation and a bounded policy for combining two
  downstream targets;
- PLI/FIR coalescing and keyframe delivery to both viewers;
- NACK/RTX behavior, retransmission-cache bounds, pacing, and asymmetric-loss
  isolation; and
- direct plus TURN coexistence, reconnect isolation, sustained CPU/memory,
  latency, and bitrate measurements.

If browser decoding requires a Pion fork, libwebrtc internals, a custom media
protocol, or a large external codec toolchain, this route is a no-go for the
current spike.

## Reproducible Result

The first real run passed on Windows amd64 with Go 1.26.6, Pion WebRTC v4.2.18,
and Headless Chrome 151.0.0.0:

```text
fixture encoder inputs/chunks/keyframes: 120 / 120 / 4
fixture encoded bytes:                   120941
native source samples / track writes:    120 / 240
leg 1 RTP: SSRC 217493737, seq 1000..1133, 134 packets, 121341 payload bytes
leg 2 RTP: SSRC 3359125474, seq 30000..30133, 134 packets, 121341 payload bytes
leg 1 / leg 2 RTCP receiver reports:      4 / 3
each browser:                             30 decoded frames, 30 render callbacks,
                                          10 changing pixel hashes, 320x180,
                                          2 decoded keyframes
```

Both browser inbound SSRC values exactly matched the corresponding native RTP
observation. Each offer and answer had a different ICE ufrag and DTLS
fingerprint. Together with two distinct Pion and browser PeerConnections, this
is evidence of separate ICE and DTLS-SRTP associations; the experiment does not
inspect or expose SRTP key material. Chrome reported `framesRendered` as zero in
this run, so the render gate deliberately uses the standard
`requestVideoFrameCallback` signal plus changing pixels rather than treating an
unavailable stats member as negative evidence.

The fixture's 120 WebCodecs `encode()` calls and 120 output chunks prove one
fixture encoder instance accepted the inputs. They do not identify a hardware
encoder or prove one physical game-capture encode. Native fanout performed two
sample writes per source frame as required by the independent packetizers; it
did not re-encode the VP8 data.

Run from `spikes/pion-rtp-fanout`:

```sh
go test ./...
go vet ./...
go run ./cmd/browser-oracle
```

The real run leaves no browser process, profile, or media fixture behind.

## Conclusion

**Go only for the next isolated transport-control experiment.** Released Pion
public APIs can fan one compatible pre-encoded VP8 sample sequence into two
independent browser-decodable WebRTC transports without a Pion fork or external
codec toolchain. This is not yet a product route: BWE aggregation, PLI/FIR
coordination, asymmetric-loss NACK/RTX, bounded pacing/queues, TURN coexistence,
and reconnect isolation remain mandatory gates.

## Primary Sources And License Boundary

Sources accessed 2026-08-19:

- [Pion WebRTC v4.2.18 release](https://github.com/pion/webrtc/releases/tag/v4.2.18)
- [Pion static track implementation](https://github.com/pion/webrtc/blob/v4.2.18/track_local_static.go)
- [Pion play-from-disk example](https://github.com/pion/webrtc/blob/v4.2.18/examples/play-from-disk/main.go)
- [Pion interceptor API](https://github.com/pion/interceptor/blob/v0.1.47/interceptor.go)
- [Pion WebRTC MIT license](https://github.com/pion/webrtc/blob/v4.2.18/LICENSE)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [VP8 WebCodecs registration](https://www.w3.org/TR/webcodecs-vp8-codec-registration/)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [`requestVideoFrameCallback`](https://html.spec.whatwg.org/multipage/media.html#dom-htmlvideoelement-requestvideoframecallback)

Pion is MIT-licensed. The experiment uses its published module and public API;
it copies no Pion implementation. The video fixture is generated from
repository-owned canvas drawing code and contains no downloaded media or
GPL/AGPL source.
