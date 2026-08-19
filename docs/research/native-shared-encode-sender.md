# Native Pre-encoded Browser Fanout

- Research date: 2026-08-19
- Scope: one Chrome WebCodecs producer, one loopback native Pion helper, and two
  independent unmodified Chromium receivers
- Status: bounded offline and 12-second live interoperability gates passed;
  product integration remains stopped on BWE, feedback, loss, TURN, and lifecycle

## Decision Question

Can one real Chrome page continuously encode VP8 once, pass each chunk to a
loopback native helper, and have released Pion public APIs deliver the same
samples to two independent standard WebRTC browser sessions for at least ten
seconds of changing decoded and presented video?

This is the follow-up gate to the
[native RTP fanout oracle](./native-rtp-fanout-oracle.md). It is not a product
topology decision and does not claim one hardware encode. A source sample is
read once by the fanout coordinator, but each transport must retain its own
packetizer, RTP sequence space, SSRC, RTCP feedback, ICE credentials, DTLS
association, and SRTP context.

## Minimal Experiments

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
- For the live gate, keep one Chrome host page producing `VideoFrame`s from an
  animated canvas at 320x180@30 for 12 seconds. A single `VideoEncoder` sends
  config, immutable VP8 chunks, timestamps, duration, and final counters over a
  WebSocket bound to `127.0.0.1`.
- Generate a fresh 256-bit startup token, require it on every local page/API,
  and require the exact loopback `Origin` on the WebSocket and API calls. The
  IPC listener never binds a non-loopback interface.
- Bound the host encoder queue at four inputs, the browser WebSocket buffer at
  512 KiB, each IPC chunk at 1 MiB, the session at 750 chunks/32 MiB/25 seconds,
  and the helper sample queue at eight frames. On helper overload, clear stale
  queued deltas, reject deltas until a key frame, and request that key frame over
  the same WebSocket.

## Acceptance And Stop Lines

Passing proves continuous browser-compatible access-unit fanout over two real
independent WebRTC transports and a bounded local application queue. It does
not prove real screen capture, native or physical hardware encoding, zero-copy
behavior, performance under loss/load, or product readiness.

The spike stops after interoperability evidence. It must not connect to the
product routing controller until separate work proves all of these:

- send-side bandwidth estimation and a bounded policy for combining two
  downstream targets;
- viewer PLI/FIR coalescing and downstream-driven keyframe delivery;
- NACK/RTX behavior, retransmission-cache bounds, pacing, and asymmetric-loss
  isolation; and
- direct plus TURN coexistence, reconnect isolation, sustained CPU/memory,
  latency, and bitrate measurements.

If browser decoding requires a Pion fork, libwebrtc internals, a custom media
protocol, or a large external codec toolchain, this route is a no-go for the
current spike.

## Offline Fixture Result

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

## Continuous Live Bridge Result

The final live run passed on Windows amd64 with Go 1.26.6, Pion WebRTC v4.2.18,
Coder WebSocket v1.8.15, and Headless Chrome 151.0.0.0:

```text
host encoder instances / inputs / outputs / sent: 1 / 360 / 360 / 360
host encoded and IPC source bytes:                 368314 / 368314
host elapsed / media duration:                     11.970 s / 11.99988 s
host encoder queue / socket buffer maxima:         1 of 4 / 2047 of 524288 B
helper queue maximum / capacity / drops:           1 / 8 / 0
native source samples / track writes:              360 / 720
each leg RTP packets / payload bytes:               397 / 369756
leg 1 / leg 2 sequence start:                       1000 / 30000
leg 1 / leg 2 RTCP receiver reports:                41 / 42
each browser decoded / render callbacks:            331 / 331
each browser changing hashes / decoded keyframes:   27 / 12
```

The helper observed all 360 chunks and source bytes sent by the host. Each
transport used a different SSRC, RTP sequence space, offer/answer ICE ufrag,
and offer/answer DTLS fingerprint; browser inbound SSRCs matched the native
observations. Both viewers remained connected at 320x180 and independently
reported sustained decode and `requestVideoFrameCallback` progress.

The helper bound `127.0.0.1` on an ephemeral port, validated the exact Origin,
and used a fresh 32-byte startup token. Unit tests force the capacity-eight
queue to overload and verify that it drops queued/dependent deltas, requests a
key frame, and resumes only at the next key frame. The clean real run did not
overload, so its observed queue peak was one.

Chrome rejected the first `prefer-hardware` VP8 configuration hint before
encoding. The single allowed compatibility correction uses and records
`hardwareAcceleration: "no-preference"`; WebCodecs defines this setting as a
hint, and neither the value nor the one encoder object proves a physical or
hardware encode.

Run from `spikes/pion-rtp-fanout`:

```sh
go test ./...
go vet ./...
go run ./cmd/native-live-bridge
```

## Conclusion

**Go only for the next isolated transport-control experiment.** A standard
Chrome WebCodecs producer can continuously feed the released Pion sample API
over authenticated loopback IPC, and the helper can fan the same samples into
two browser-decodable transports with bounded application memory. This is not
yet a product route: BWE aggregation, viewer PLI/FIR coordination,
asymmetric-loss NACK/RTX and pacing, audio, TURN coexistence, and reconnect
isolation remain mandatory gates.

The follow-up [shared feedback-control oracle](./native-shared-feedback-control.md)
retains deterministic PLI/FIR merge and minimum-of-two bitrate policies and
proves two isolated 512-packet NACK/RTX responders. It stops the combined route
as a no-go because Interceptor v0.1.47 stock GCC pacers do not register the
negotiated RTX SSRC. No two-browser loss gate or product integration followed.

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
- [Coder WebSocket v1.8.15 API](https://pkg.go.dev/github.com/coder/websocket@v1.8.15)
- [Coder WebSocket source and ISC license](https://github.com/coder/websocket/tree/v1.8.15)
- [RFC 6455 WebSocket Origin security model](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2)

Pion is MIT-licensed and Coder WebSocket is ISC-licensed. The experiment uses
their published modules and public APIs; it copies no dependency implementation.
The video fixture is generated from repository-owned canvas drawing code and
contains no downloaded media or GPL/AGPL source.
