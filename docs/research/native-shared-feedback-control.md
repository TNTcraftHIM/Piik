# Native Shared-Encode Feedback Control

- Research date: 2026-08-19
- Scope: two independent Pion sender legs sharing one encoded VP8 source
- Status: deterministic policy traces pass; the stock Pion GCC plus negotiated
  RTX composition remains a no-go on the pinned releases. A separate accepted
  no-RTX experiment is recorded in `native-primary-ssrc-retransmission.md`.

## Decision Question

Can Pion WebRTC v4.2.18 and Interceptor v0.1.47 provide the next bounded
feedback-control layer for the live shared-encode bridge without a Pion fork,
a custom congestion-control framework, or unbounded queues?

The gate covers three narrow requirements:

1. merge PLI and FIR requests from two legs into one encoder key-frame demand;
2. keep NACK cache and RFC 4588 RTX state independent per leg; and
3. choose one encoder target from two independent downstream estimates.

It remains disconnected from Screener's product signaling and media router.

## Verified Source Boundaries

Pion builds one interceptor chain for each `PeerConnection`. Its NACK responder
stores a packet ring per local SSRC, defaults to 1024 packets, accepts a public
power-of-two size option, and rewrites retransmissions onto the negotiated RTX
SSRC and payload type. The spike selects 512 packets per leg rather than relying
on the default.

Pion's official bandwidth-estimation example adds a GCC interceptor, then the
TWCC header-extension sender, then the default interceptors. In Interceptor
v0.1.47, `SendSideBWE.AddStream` registers only the primary `StreamInfo.SSRC`
with its pacer. `NoOpPacer` rejects any other SSRC with `ErrUnknownStream`.
Negotiated RFC 4588 retransmissions use `StreamInfo.SSRCRetransmission`, so the
stock bounded/no-op composition rejects the RTX packet. Pion issue
[#406](https://github.com/pion/interceptor/issues/406) reports the same failure
and remained open when accessed.

Source inspection also shows that the default GCC leaky-bucket pacer looks up
the packet SSRC in the same primary-only writer map. Its queue is a
`container/list` with no configured length or byte bound. The deterministic
oracle does not claim to execute that asynchronous pacer; this is a source-code
finding and a second reason not to substitute it merely to avoid the explicit
`NoOpPacer` error.

The protocol constraints are separate:

- WebRTC senders must react to PLI, while FIR is a decoder-refresh command and
  must not be used as the ordinary loss-recovery signal.
- A repeated FIR keeps its sequence number. After a refresh, another refresh
  for that repetition is required only when it continues beyond two RTTs.
- Generic NACK is transport-local. RFC 4588 retransmission is useful only when
  it can arrive in time and must remain congestion controlled.
- For one representation delivered to heterogeneous receivers, the sender has
  to adapt to the least capable path. The retained single-encode policy is
  therefore the minimum of the two ready leg estimates, clamped to the encoder
  profile bounds. This is an inference from the RTP topology requirement, not
  a new congestion-control algorithm.

## Deterministic Oracle

Run from `spikes/pion-rtp-fanout`:

```sh
go test ./... -run 'Test(KeyFrameMerger|SharedBitrate|NACKRTXTrace|FeedbackControlOracle)' -count=1
go run ./cmd/shared-feedback-control
```

The Windows amd64 run used Go 1.26.6 and the pinned Pion modules. It recorded:

```text
PLI by leg:                         1 / 1
FIR entries by leg:                 5 / 1
FIR duplicates / retry:             2 / 1 after 2*RTT
coalesced while pending:             3
merged encoder requests:           3
request-to-key-frame trace:        40 / 20 / 20 ms
selected shared targets:           600 / 400 / 150 / 600 kbps
per-leg NACK responder ring:        512 packets
leg 1 primary / RTX SSRC:          1001 / 2001
leg 2 primary / RTX SSRC:          1002 / 2002
evicted leg 1 sequence:             10000
retransmitted leg 1 sequence:       10512
stock GCC primary delivered:        true
stock GCC RTX delivered:            false
stock GCC error:                    unknown ssrc: 2001
```

The NACK trace uses two separately constructed public Pion responder chains.
Each leg retransmits only through its own RTX SSRC. After 513 primary packets
on leg 1, a NACK covering the oldest and newest sequence produces only the
newest RTX packet, proving the selected 512-packet eviction boundary.

The key-frame trace holds one request pending until a source key frame is
observed, merges PLI/FIR across legs during that interval, keys FIR repetition
state by leg and source/target SSRC, and permits the same FIR sequence to retry
after two measured RTTs. The bitrate trace emits nothing until both legs have
an estimate, then selects their minimum within 150-600 kbps. These are retained
policy candidates, not live-media claims.

## Decision And Stop Line

**No-go for the stock Pion v4.2.18 / Interceptor v0.1.47 GCC plus RTX
composition.** The required primary packet succeeds and its negotiated RTX
packet fails at the stock pacer boundary. Launching a two-browser controlled-
loss run after that deterministic failure would not test the required combined
path, so the browser gate was deliberately not run.

This spike does not add an RTX-aware pacer, reorder interceptors to bypass GCC,
disable negotiated RTX, fall back to non-standard REMB, or fork Pion. Those
choices are different experiments with separate packet-accounting, TWCC,
pacing, memory, and browser-loss gates.

The negotiated RTX route remains blocked until a released Pion/Interceptor
version fixes the RTX SSRC registration and a fresh controlled-loss gate
passes. A subsequently accepted, separate experiment omitted RTX negotiation
and passed one bounded primary-SSRC retransmission gate; it does not repair or
supersede this negotiated-RTX no-go. See
[`native-primary-ssrc-retransmission.md`](./native-primary-ssrc-retransmission.md).

The separate [live feedback-loop gate](./native-live-feedback-loop.md) later
applied one min-of-two stock target to the same WebCodecs encoder and recovered
one post-target primary-SSRC loss. Live PLI/FIR-to-WebCodecs control, continuous
adaptation, pacing, sustained loss, TURN coexistence, reconnect isolation,
audio, and load remain hard gates before product use.

## Sources And License

Sources accessed 2026-08-19:

- [Pion WebRTC v4.2.18 release](https://github.com/pion/webrtc/releases/tag/v4.2.18)
- [Pion default interceptor configuration](https://github.com/pion/webrtc/blob/v4.2.18/interceptor.go)
- [Pion bandwidth-estimation example](https://github.com/pion/webrtc/blob/v4.2.18/examples/bandwidth-estimation-from-disk/main.go)
- [Interceptor v0.1.47 NACK responder](https://github.com/pion/interceptor/blob/v0.1.47/pkg/nack/responder_interceptor.go)
- [Interceptor v0.1.47 NACK options](https://github.com/pion/interceptor/blob/v0.1.47/pkg/nack/responder_option.go)
- [Interceptor v0.1.47 send-side BWE](https://github.com/pion/interceptor/blob/v0.1.47/pkg/gcc/send_side_bwe.go)
- [Interceptor v0.1.47 no-op pacer](https://github.com/pion/interceptor/blob/v0.1.47/pkg/gcc/noop_pacer.go)
- [Interceptor v0.1.47 leaky-bucket pacer](https://github.com/pion/interceptor/blob/v0.1.47/pkg/gcc/leaky_bucket_pacer.go)
- [Pion Interceptor issue #406](https://github.com/pion/interceptor/issues/406)
- [RFC 4585: RTP/AVPF feedback](https://www.rfc-editor.org/rfc/rfc4585.html)
- [RFC 4588: RTP retransmission](https://www.rfc-editor.org/rfc/rfc4588.html)
- [RFC 5104: codec control messages and FIR](https://www.rfc-editor.org/rfc/rfc5104.html)
- [RFC 5117: RTP topologies](https://www.rfc-editor.org/rfc/rfc5117.html)
- [RFC 8834: media transport for WebRTC](https://www.rfc-editor.org/rfc/rfc8834.html)
- [RFC 8888: RTCP congestion-control feedback](https://www.rfc-editor.org/rfc/rfc8888.html)

Pion WebRTC, Interceptor, RTCP, and RTP are MIT-licensed. The oracle imports
their released public APIs and copies no dependency implementation. The
repository-owned spike remains MIT-licensed. No media fixture or GPL/AGPL code
was added.
