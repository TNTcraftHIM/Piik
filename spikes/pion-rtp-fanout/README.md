# Pion RTP Fanout Oracle

This isolated spike answers one narrow question: can one Pion
`TrackLocalStaticRTP` accept one pre-packetized payload write and fan it out
through two independent WebRTC transports without application-level duplicate
encoding?

## Oracle

The program creates one shared VP8 `TrackLocalStaticRTP`, two sender
`PeerConnection` instances, and two independent receiver `PeerConnection`
instances. After both local ICE/DTLS/SRTP paths connect, it calls `WriteRTP`
once. The receivers must observe:

- the same opaque semantic payload, RTP sequence number, and timestamp;
- different transport-assigned SSRC values; and
- no mutation of the caller's source RTP packet.

Run from this directory:

```sh
go test ./...
go vet ./...
go run ./cmd/oracle
```

The module requires Go 1.24 or newer because the pinned Pion release does. It
was initially verified with Go 1.26.6 and Pion WebRTC v4.2.18.

## Browser Decode And Render Oracle

The follow-up command generates a 320x180@30 VP8 sequence from a synthetic
canvas with one browser WebCodecs encoder instance. A native Pion coordinator
reads each encoded frame once and writes it to two independent
`TrackLocalStaticSample` tracks. Each track has its own packetizer, RTP sequence
space, SSRC, RTCP reader, ICE credentials, DTLS association, and SRTP context.

Two separate unmodified headless Chrome/Chromium/Edge processes receive the
tracks. The run passes only when both browsers report decoded frames and
`requestVideoFrameCallback` callbacks with changing sampled pixels. A public
Pion interceptor records the actual transport-local RTP headers.

```sh
go run ./cmd/browser-oracle
```

Use `-browser /path/to/browser` or `SCREENER_BROWSER_BIN` when automatic browser
discovery is insufficient. The same run is available as an opt-in automated
test by setting `SCREENER_RUN_BROWSER_ORACLE=1` before `go test ./...`.

Initial Windows evidence used Go 1.26.6 and Headless Chrome 151. Both receivers
decoded and presented 30 changing 320x180 frames before reporting success. The
native legs used distinct SSRCs and first sequence numbers `1000` and `30000`,
and received independent RTCP receiver reports. See
[`docs/research/native-shared-encode-sender.md`](../../docs/research/native-shared-encode-sender.md)
for the full measurements and stop lines.

## Continuous Browser-To-Native Bridge

The next bounded command launches one Chrome host page and two independent
Chrome viewers. The host creates one WebCodecs `VideoEncoder`, produces 360
animated VP8 frames over about 12 seconds, and streams config, timing, and chunk
bytes to Pion over a random-token WebSocket that listens only on `127.0.0.1` and
requires the exact loopback Origin.

The browser encoder queue is limited to four inputs, the browser WebSocket
buffer to 512 KiB, each IPC chunk to 1 MiB, the session to 750 chunks/32 MiB/25
seconds, and the helper sample queue to eight frames. On helper overload, queued
and subsequent dependent frames are dropped, the host is asked for a key frame,
and admission resumes at that key frame.

```sh
go run ./cmd/native-live-bridge
```

Set `SCREENER_RUN_LIVE_BRIDGE=1` to include the same real-browser gate in
`go test ./...`. The passing Chrome 151 run recorded one encoder instance,
360 inputs and outputs, 360 helper source samples, 720 transport writes, and
331 decoded frames plus 331 presentation callbacks at each viewer. Full
measurements are in the research note linked above.

`hardwareAcceleration: "no-preference"` is recorded only as a WebCodecs hint.
This experiment does not claim a physical or hardware encode, and remains
disconnected from the product controller.

## Shared Feedback-Control Oracle

The next isolated command uses deterministic public-API traces instead of
claiming another live-media capability:

```sh
go run ./cmd/shared-feedback-control
```

It verifies that two separately constructed Pion NACK responders keep
transport-local RTX SSRCs and 512-packet caches, that PLI/FIR demands can merge
behind one pending source key frame, and that one encoded representation must
use the minimum of two ready leg estimates within fixed encoder bounds.

The command then reproduces the blocking stock composition: Interceptor
v0.1.47 `SendSideBWE` registers only the primary SSRC with
`gcc.NewNoOpPacer`, so the negotiated RTX packet fails with
`unknown ssrc: 2001`. The oracle intentionally reports
`no-go-stock-pion-gcc-rtx`; it does not add a custom pacer, bypass GCC, disable
RTX, or connect to the product. See
[`docs/research/native-shared-feedback-control.md`](../../docs/research/native-shared-feedback-control.md)
for evidence, source links, and the stop line.

## RTP Oracle Scope Boundaries

This layered spike covers the Pion API, standard Chrome decode/render, and a
continuous browser-to-native loopback bridge. It proves that Pion can preserve
one pre-encoded semantic sample stream while assigning transport-local RTP
identity to two separate `PeerConnection` transports.

It does **not** include or prove:

- screen capture, physical video encoding, or A/V sync;
- congestion-control fairness, RTCP feedback arbitration, retransmission,
  pacing, loss recovery, latency, or sustained throughput;
- zero-copy transport, whole-process constant memory, or production readiness;
- that this should replace the current P2P-first browser path.

The browser oracles additionally do **not** prove physical or hardware shared
encoding. The deterministic follow-up retains candidate PLI/FIR and bitrate
merge policies and proves independent bounded NACK/RTX in isolation, but the
stock Pion GCC+RTX composition is a no-go. Network pacing, live feedback,
audio, and TURN/reconnect behavior remain hard stops before product use.

## Decision Gate

- **Previous gate passed:** the released Pion API and authenticated loopback
  bridge sustain one Chrome VP8 encoder across two independent browser-
  decodable transports.
- **Feedback-control gate stopped:** the stock v0.1.47 GCC pacer rejects the
  negotiated RTX SSRC. Do not proceed to a browser loss gate or product path
  until a released fix or a separately accepted bounded adapter exists.
- **No-go:** the behavior requires internal APIs, a Pion fork, duplicate
  application writes, or payload re-encoding. Stop the native relay path.

Forking Pion is explicitly out of scope.

## Versions, Sources, And License

- Pion WebRTC v4.2.18, released 2026-07-27 and pinned in `go.mod`.
- Pion v4.2.18 requires Go 1.24.0 according to its official `go.mod`.
- Pion's `TrackLocalStaticRTP` public implementation documents multiple binds
  and rewrites SSRC and payload type per binding during one `WriteRTP` call.
- Pion is MIT-licensed. This spike is also MIT-licensed and contains no copied
  Pion implementation code or binary media assets.
- Coder WebSocket v1.8.15 is ISC-licensed and used only for the isolated
  loopback bridge.

Primary sources accessed 2026-08-19:

- <https://github.com/pion/webrtc/releases/tag/v4.2.18>
- <https://github.com/pion/webrtc/blob/v4.2.18/go.mod>
- <https://github.com/pion/webrtc/blob/v4.2.18/track_local_static.go>
- <https://github.com/pion/webrtc/blob/v4.2.18/LICENSE>
- <https://github.com/coder/websocket/tree/v1.8.15>
