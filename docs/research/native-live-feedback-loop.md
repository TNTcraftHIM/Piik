# Native Live Shared-Encoder Feedback Loop

- Research date: 2026-08-19
- Scope: two independent stock Pion GCC estimates controlling one Chrome
  WebCodecs VP8 encoder through the existing bounded live bridge
- Status: deterministic gates and the single authorized 720p30 Chrome run
  pass; product integration remains blocked

## Decision Question

Can the retained native candidates form one narrow live loop without a Pion
fork or custom congestion-control framework: two independent stock GCC
estimators select their minimum, Go emits only a bounded target, one browser
host applies it to the same `VideoEncoder`, and one primary-SSRC NACK replay
recovers a deterministic one-leg loss without contaminating the clean leg?

The experiment remains isolated from Screener's product controller. It does
not add audio, TURN, capture, PLI/FIR wiring, a custom pacer, or a general
adaptation framework.

## Official API Boundaries

WebCodecs permits `VideoEncoder.configure()` while the encoder is already in
the `configured` state; only a closed encoder is rejected. Configure returns
`undefined`, so it cannot itself be awaited. Codec operations are serialized
through the specification's FIFO control-message queue. `flush()` completes
earlier control messages and emits their outputs before its promise resolves,
but it neither resets the encoder nor forces the next frame to be a key frame.
The experiment therefore has one JavaScript owner pause input, await `flush()`,
call `configure()` on the same object, and explicitly request a key frame on
the next input. The first post-config key output is the application
acknowledgment; decoder metadata cannot identify an encoder bitrate change.

Chromium's current implementation has a same-codec reconfiguration path for
compatible option changes, including bitrate. That is implementation evidence,
not a cross-browser guarantee. A dynamic support check is still made before
each bounded target, and any configure/encode error fails the run rather than
constructing a replacement encoder.

Pion Interceptor v0.1.47 exposes one `BandwidthEstimator` for each congestion-
control interceptor. Its `WriteRTCP` processes Transport-CC before
`RTPSender.ReadRTCP` returns; `GetTargetBitrate()` is locked and returns the
current stock estimate. The gate records a leg as ready only after that leg's
real Transport-CC packet returns from the interceptor chain. It then chooses
the minimum of both ready estimates, clamped to 150-600 kbps. This is the
retained one-representation policy, not a new estimator.

## Bounded Composition

The source profile is synthetic VP8 at 1280x720, 30 fps, and 390 scheduled
frames (13 seconds). It starts at 1.2 Mbps so the 600 kbps stock-GCC ceiling
produces an observable target change. Existing limits remain in force:

- one `VideoEncoder` object and an encoder input queue limit of four;
- a 512 KiB browser WebSocket buffer and 1 MiB per IPC chunk;
- an eight-frame native application queue;
- a 512-packet NACK cache per independent leg;
- stock `gcc.NewNoOpPacer`, which owns no packet queue;
- one target in flight, latest-target coalescing, at least two seconds between
  applications, and at most six target publications;
- ten seconds of feedback observation followed by a frozen three-second tail,
  so late callbacks cannot race the final assertion;
- one loss outstanding at a time. The lossy boundary is disarmed until the
  browser acknowledges its first new-config key output, then discards exactly
  the 30th subsequent primary RTP attempt on leg 1.

The browser polls an authenticated loopback endpoint for the current target.
Go publishes no codec object, pacing command, or transport mutation. A target
acknowledgment is accepted only when it matches the outstanding generation,
reports one encoder instance and the expected configure-call count, and names
a nonzero post-config key-frame timestamp. Both viewers use the successful
replay as a shared recovery marker so the gate can require decoded frames and
presentation callbacks after recovery on both the lossy and clean legs.

## Deterministic Gate

Run from `spikes/pion-rtp-fanout`:

```sh
go test . -run '^Test(Live|Primary)' -count=1
```

The Windows amd64 preflight used Go 1.26.6 and passed. Unit coverage proves no
target appears before both Transport-CC legs, minimum selection and clamping,
one outstanding generation, the two-second cadence, the publication cap,
rejection of a non-key first output, and the fixed post-arm loss offset. The
existing live-bridge and primary-retransmission tests also pass. The embedded
host and viewer JavaScript parse under Node.js 24.19.0.

## Single Real Browser Gate

An independent read-only preflight found no P1/P2 blocker. The browser gate was
then invoked exactly once and was not repeated:

```sh
go run ./cmd/live-feedback-loop
```

The Windows amd64 run used Go 1.26.6 and Headless Chrome 151.0.7922.138. It
passed all validation in 12.972 seconds. The host reported:

```text
format / scheduled frames:             1280x720@30 / 390
encoder instances:                     1
encoder inputs / outputs:              390 / 390
initial / applied target:              1200000 / 600000 bps
configure calls / target applications: 2 / 1
inputs / outputs after target:          382 / 382
encoded / IPC bytes:                   445292 / 445292
encoder queue peak / limit:            1 / 4
WebSocket peak / limit:                12467 / 524288 bytes
encoder / socket drops:                0 / 0
native queue peak / limit:             1 / 8
source samples / transport writes:     390 / 780
```

Both legs produced real feedback before the ten-second freeze. Leg 1 recorded
158 Transport-CC packets and three stock target callbacks; leg 2 recorded 159
Transport-CC packets and no target callback. Both final stock estimates were
600000 bps. Go published `[600000]`, the host applied `[600000]`, and the
candidate/final target stayed 600000 with zero suppressed or outstanding
updates. A callback was not required for readiness; each estimate was sampled
after stock Pion processed that leg's Transport-CC.

The first target acknowledgment armed leg 1 after 12 primary attempts. The
30th later primary attempt, RTP sequence 1041 on SSRC 2037672995, was discarded.
Chrome sent one NACK and stock Pion made one same-identity replay. Its TWCC
sequence changed from 41 to 44. The outstanding-loss peak/final values were
1/0, and another 435 packets passed after recovery. Leg 2 produced zero drops,
NACKs, or replays. Both transports ultimately delivered 479 packets and 447037
payload bytes, with independent SSRCs, RTP sequence spaces, ICE credentials,
DTLS fingerprints, and SRTP paths.

The lossy and clean viewers decoded 382 and 383 frames. After the shared
recovery marker, both decoded another 359 frames and fired another 360/359
presentation callbacks. Each reported 30 changing sampled pixel hashes at
1280x720. Neither exposed RTX-only inbound stats, as required when RTX is not
negotiated.

The measured gate therefore met all of its required conditions:

- exactly one encoder instance at 1280x720@30 for at least 12 seconds;
- at least one Transport-CC packet and a bounded stock estimate on each leg;
- identical published and acknowledged min-of-two target histories, with no
  suppressed or outstanding target;
- target support accepted, configure count equal to one plus target
  applications, a key first output for each target, and at least 120 encoder
  inputs/outputs after the first target;
- exactly one configured leg-1 drop after target acknowledgment, bounded NACK
  replay with fresh TWCC, and no leg-2 NACK/replay;
- at least 120 decoded frames and 120 presentation callbacks after the shared
  recovery marker on each viewer;
- no encoder/socket drops, application queue depth at most eight, NACK caches
  fixed at 512, one outstanding loss maximum, and no pacer queue.

**Go only for this bounded live target candidate.** The run proves that the
two released stock estimators can select and apply one shared target to the
same WebCodecs object while the retained one-packet primary-SSRC recovery path
stays isolated. It does not establish a production adaptation policy.

## Stop Line

Even a passing run authorizes only this bounded candidate. Primary-SSRC replay
still sacrifices retransmission-specific inbound statistics and can distort
RTP/RTCP loss accounting. The negotiated RFC 4588 route remains the separate
`no-go-stock-pion-gcc-rtx` result. PLI/FIR-to-WebCodecs wiring, continuous
hysteresis under sustained/burst loss, wider browsers and networks, audio,
mixed direct/TURN paths, reconnect isolation, load, and lifecycle remain hard
gates. No result here changes the P2P-first topology or permits product wiring.

## Sources And License

Sources accessed 2026-08-19:

- [W3C WebCodecs control messages](https://www.w3.org/TR/webcodecs/#control-messages)
- [W3C `VideoEncoder.configure()`](https://www.w3.org/TR/webcodecs/#dom-videoencoder-configure)
- [W3C `VideoEncoder.flush()`](https://www.w3.org/TR/webcodecs/#dom-videoencoder-flush)
- [W3C forced-key-frame option](https://www.w3.org/TR/webcodecs/#dom-videoencoderencodeoptions-keyframe)
- [W3C encoded-video output algorithm](https://www.w3.org/TR/webcodecs/#output-encodedvideochunks)
- [Chromium `VideoEncoder` reconfiguration implementation](https://chromium.googlesource.com/chromium/src/+/e6e93d8cedefcae0a6efd07067279eef76d3ff71/third_party/blink/renderer/modules/webcodecs/video_encoder.cc)
- [Pion Interceptor v0.1.47 congestion-control API](https://github.com/pion/interceptor/blob/v0.1.47/pkg/cc/interceptor.go)
- [Pion Interceptor v0.1.47 stock send-side BWE](https://github.com/pion/interceptor/blob/v0.1.47/pkg/gcc/send_side_bwe.go)
- [Pion WebRTC v4.2.18 bandwidth-estimation example](https://github.com/pion/webrtc/blob/v4.2.18/examples/bandwidth-estimation-from-disk/main.go)

Pion WebRTC and Interceptor are MIT-licensed; Coder WebSocket is ISC-licensed.
The spike calls their released public APIs and copies no dependency
implementation. The generated canvas fixture and control code are repository-
owned. Chromium source was inspected only; no Chromium code was copied.
