# Native Primary-SSRC NACK Retransmission

- Research date: 2026-08-19
- Scope: one controlled packet loss on one of two independent Pion sender legs
- Status: bounded deterministic and Chrome 151 gates pass; product use remains blocked

## Decision Question

Can the isolated shared-encode bridge omit RFC 4588 RTX codec negotiation,
retain Generic NACK, and retransmit the cached packet on its primary SSRC with
its original RTP sequence number, while still passing through stock Pion GCC
and recovering in Chrome?

This is a deliberately separate route from the negotiated RTX composition in
`native-shared-feedback-control.md`. It does not fix that composition, add a
custom pacer or congestion controller, or connect native media to Screener.

## Verified Source Boundaries

Pion WebRTC v4.2.18's default codec set includes VP8 payload type 96 and its RTX
payload type 97. Registering only VP8 is a supported public configuration;
Pion's own `RTPSender` test named `RTX can be disabled` verifies that the sender
encoding then has RTX SSRC zero. The experiment registers only VP8 and still
uses Pion's default NACK responder with an explicit 512-packet cache.

Interceptor v0.1.47's packet-copy factory rewrites SSRC, payload type, sequence,
and payload into RFC 4588 form only when both the retransmission SSRC and
payload type are non-zero. With both unset, it caches a copy of the original
header and payload. A Generic NACK therefore makes the stock responder write
the same primary SSRC, original RTP sequence, timestamp, marker, payload type,
and payload.

Stock `SendSideBWE` registers the primary SSRC with its pacer. The no-RTX replay
uses that registered SSRC and is accepted by `gcc.NewNoOpPacer`; no custom
pacer or congestion-control framework is present. The TWCC header-extension
interceptor runs again on the replay, so the repeated RTP packet gets a fresh
transport-wide sequence for congestion accounting.

The protocol distinction matters:

- RFC 4585 Generic NACK identifies missing original RTP sequence numbers; it
  does not require the RFC 4588 repair format.
- RFC 8834 requires WebRTC senders to understand Generic NACK and describes
  RFC 4588 retransmission as supported when negotiated.
- WebRTC Stats explicitly accounts for outbound retransmissions on the original
  SSRC when RTX is not negotiated. It also says a receiver cannot identify
  such retransmissions, so inbound retransmission counters and `rtxSsrc` must
  not be exposed.
- RFC 4588 rejected identical packets in the same RTP stream as its repair
  design because duplicate sequence numbers can corrupt RTP/RTCP statistics.
  This experiment is therefore a no-RTX WebRTC fallback, not an RFC 4588
  retransmission stream.

## Bounded Composition

Each experimental `PeerConnection` has its own public interceptor registry in
this registration order:

```text
cleartext loss/measurement boundary
stock SendSideBWE with gcc.NewNoOpPacer
Pion TWCC header-extension sender
Pion default interceptors with a 512-packet NACK responder
```

Pion's binding order makes the outbound call path NACK responder -> TWCC ->
stock GCC/NoOpPacer -> loss boundary -> SRTP. The target packet is cached and
counted by GCC before the last boundary discards its first transmission. Its
NACK replay traverses TWCC and GCC again.

The only application media queue holds eight encoded frames and drops to the
next key frame on overload. The source encoder queue is limited to four, its
WebSocket buffer to 512 KiB, and the test boundary permits exactly one
outstanding lost packet. `NewNoOpPacer` owns no queue. The run remains bounded
to 360 source frames and 25 seconds.

## Deterministic Gate

Run from `spikes/pion-rtp-fanout`:

```sh
go test -run '^TestPrimary(RetransmissionPassesStockGCCWithoutRTX|LossBoundaryDropsOnlyTargetAndRecognizesReplay|RetransmissionPeerOffersNACKWithoutRTX)$' -count=1 .
```

The public-API trace first writes one VP8-shaped RTP packet through a Pion NACK
responder, TWCC header extension, `SendSideBWE`, and stock `NewNoOpPacer`.
After a Generic NACK, both primary and replay reach the final writer. They have
the same RTP identity and payload, but different TWCC transport sequences.

The local peer gate then parses the generated SDP and verifies:

```text
VP8 offered:                         true
Generic NACK offered:                true
TWCC extension offered:              true
RTX / apt offered:                   false
RTPSender RTX SSRC:                  0
NACK responder cache:                512 packets
stock GCC initial target:            600000 bps
stock pacer queue:                    none
```

## One Real Browser Gate

The controlled loss gate was run exactly once on Windows amd64 with Go 1.26.6
and three Headless Chrome 151 processes: one WebCodecs VP8 source and two
independent receiver processes. It was not rerun after passing.

The source produced 360 inputs and outputs over 11.984 seconds. The helper
accepted all 360 chunks, made 720 track writes, and its capacity-eight queue
peaked at one. The encoder queue peaked at one of four and the WebSocket buffer
at 2047 of 524288 bytes. Both offers and answers negotiated VP8, NACK, and TWCC
with no RTX codec or `apt`; both Pion sender RTX SSRCs were zero. Both stock
GCC instances reported a 600000 bps target.

The boundary discarded only leg 1's 90th primary packet:

```text
leg 1 SSRC / dropped sequence:       1320517008 / 1089
leg 1 NACK requests / replays:       1 / 1
leg 1 original / replay TWCC:        89 / 91
leg 1 packets after replay:          306
leg 1 outstanding peak / final:      1 / 0
leg 2 drops / NACK / replays:        0 / 0 / 0
```

The replay retained SSRC, RTP sequence, timestamp, marker, payload type, and
payload. Each browser ultimately received 397 packets and 369756 payload bytes,
decoded 331 frames, and fired 331 `requestVideoFrameCallback` callbacks. Leg 1
observed the successfully forwarded replay at 53 decoded frames/callbacks,
then decoded another 278 frames and fired another 278 callbacks; leg 2 remained
clean. Both showed 27 changing pixel hashes at 320x180. Chrome exposed neither
`retransmittedPacketsReceived` nor `rtxSsrc`, as required without RTX.

## Verdict And Hard Gates

**Go only for the bounded primary-SSRC retransmission candidate.** The
deterministic and single controlled Chrome gate prove that the stock Pion
responder can replay an original-sequence primary packet through stock GCC and
that Chrome can recover one isolated loss without contaminating the other leg.

The negotiated RFC 4588 path remains `no-go-stock-pion-gcc-rtx`. This result
does not authorize product integration and does not establish a general loss
policy. The following remain hard gates:

- decide whether distorted RTP/RTCP packet-loss statistics and absent inbound
  retransmission counters are acceptable for diagnosis and adaptation;
- test burst, sustained, late, and reordered loss without creating replay
  storms, but do not invent a general congestion-control framework;
- retain the separate one-run live two-leg target result only as bounded
  evidence, and still connect/test PLI/FIR aggregation under measured feedback;
- prove audio/A-V synchronization, mixed direct/TURN paths, reconnect, browser
  diversity, memory/load, and lifecycle isolation;
- preserve the P2P-first product topology unless a measured ADR changes it.

## Sources And License

Sources accessed 2026-08-19:

- [Pion WebRTC v4.2.18 default codecs](https://github.com/pion/webrtc/blob/v4.2.18/mediaengine.go)
- [Pion WebRTC v4.2.18 RTPSender configuration](https://github.com/pion/webrtc/blob/v4.2.18/rtpsender.go)
- [Pion WebRTC v4.2.18 RTX-disabled test](https://github.com/pion/webrtc/blob/v4.2.18/rtpsender_test.go)
- [Pion WebRTC v4.2.18 interceptor configuration](https://github.com/pion/webrtc/blob/v4.2.18/interceptor.go)
- [Interceptor v0.1.47 NACK responder](https://github.com/pion/interceptor/blob/v0.1.47/pkg/nack/responder_interceptor.go)
- [Interceptor v0.1.47 packet-copy factory](https://github.com/pion/interceptor/blob/v0.1.47/internal/rtpbuffer/packet_factory.go)
- [Interceptor v0.1.47 send-side BWE](https://github.com/pion/interceptor/blob/v0.1.47/pkg/gcc/send_side_bwe.go)
- [Interceptor v0.1.47 no-op pacer](https://github.com/pion/interceptor/blob/v0.1.47/pkg/gcc/noop_pacer.go)
- [W3C WebRTC Statistics API](https://www.w3.org/TR/webrtc-stats/)
- [RFC 4585: RTP/AVPF feedback](https://www.rfc-editor.org/rfc/rfc4585.html)
- [RFC 4588: RTP retransmission](https://www.rfc-editor.org/rfc/rfc4588.html)
- [RFC 8834: media transport for WebRTC](https://www.rfc-editor.org/rfc/rfc8834.html)

Pion WebRTC, Interceptor, RTP, RTCP, and SDP are MIT-licensed. This spike uses
their released public APIs, copies no dependency implementation, and remains
under the repository spike's MIT license. No binary media or GPL/AGPL code was
added.
