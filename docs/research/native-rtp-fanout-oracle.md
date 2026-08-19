# Native RTP Fanout Oracle

Last verified: 2026-08-19

## Question

Can a native relay use a released Pion public API to write one already-encoded
RTP payload once and fan it out over two independent WebRTC transports, without
forking Pion or re-encoding per downstream?

This is an isolated feasibility question. It does not change ADR-0001 or make a
native sender/relay part of the current Web MVP.

## Primary-Source Findings

- Pion WebRTC v4.2.18 is the current stable release as of the access date.
- Its official `go.mod` requires Go 1.24.0.
- `TrackLocalStaticRTP` stores one binding for each successful `Bind` call.
  Its public `WriteRTP` path iterates those bindings, assigning the binding's
  SSRC and payload type before writing the same RTP payload through each
  `TrackLocalWriter`.
- Pion WebRTC is MIT-licensed. The spike uses the published module and public
  API only; it does not copy implementation code, fork Pion, or add media
  assets.

Sources accessed 2026-08-19:

- <https://github.com/pion/webrtc/releases/tag/v4.2.18>
- <https://github.com/pion/webrtc/blob/v4.2.18/go.mod>
- <https://github.com/pion/webrtc/blob/v4.2.18/track_local_static.go>
- <https://github.com/pion/webrtc/blob/v4.2.18/LICENSE>

## Reproducible Oracle

The code is in [`spikes/pion-rtp-fanout`](../../spikes/pion-rtp-fanout/README.md).
It creates one shared static RTP track, two sender PeerConnections, and two
independent receiver PeerConnections. All transports run through actual local
ICE/DTLS/SRTP negotiation. Once both paths are connected, the program invokes
the shared track's `WriteRTP` exactly once.

Initial environment:

- Windows amd64
- Go 1.26.6, using the dependency's Go 1.24.0 minimum
- Pion WebRTC v4.2.18

Verification:

```text
go fmt ./...                         pass
go test -count=3 ./...               pass (three consecutive oracle runs)
go vet ./...                         pass
go run ./cmd/oracle                  pass
```

The program output reported `sourceWrites: 1`, identical payload, sequence
number `4242`, and timestamp `90000` at both receivers. The two receiver SSRCs
were distinct from each other and from the unchanged source SSRC. SSRC values
are randomly assigned per transport, so their literal values are not durable
test expectations.

## Conclusion And Gate

**Go for the next bounded spike.** The released public API satisfies the narrow
fanout oracle: one application RTP write reaches two independent transports
without application-level duplicate writes or payload re-encoding, and Pion
assigns transport-local SSRCs.

This does not establish production suitability. Before any architecture
decision, a follow-up must demonstrate all of the following without a Pion
fork:

1. Chrome/Edge browser interoperability for a real encoded video stream.
2. Per-downstream RTCP feedback, congestion control, pacing, retransmission,
   keyframe requests, and failure isolation under asymmetric loss/bandwidth.
3. Sustained latency, CPU, allocations, and output bitrate with one and two
   downstreams, including disconnect/reconnect behavior.
4. A separate capture/encoder measurement proving one physical encode is
   actually produced and accepted by the shared RTP path.

The present oracle cannot support claims about capture, physical encoding,
decoding, browser end-to-end behavior, A/V sync, congestion fairness, loss
recovery, zero-copy operation, latency, or production readiness.
