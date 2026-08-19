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

## Scope Boundaries

This is an API and in-process transport oracle. It proves that Pion's public
API can bind one static RTP track to two separate `PeerConnection` transports
and preserve one pre-encoded semantic payload while assigning transport-local
RTP headers.

It does **not** include or prove:

- screen capture, physical video encoding, decoder compatibility, or A/V sync;
- browser-to-browser or browser-to-native end-to-end operation;
- congestion-control fairness, RTCP feedback arbitration, retransmission,
  pacing, loss recovery, latency, or sustained throughput;
- zero-copy transport, constant memory use, or production readiness; or
- that this should replace the current P2P-first browser path.

## Decision Gate

- **Go:** the public, released Pion API fans one `WriteRTP` call out to both
  bindings while preserving payload semantics and using independent SSRCs.
  Proceed only to a browser interop and RTCP/congestion-control spike.
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

Primary sources accessed 2026-08-19:

- <https://github.com/pion/webrtc/releases/tag/v4.2.18>
- <https://github.com/pion/webrtc/blob/v4.2.18/go.mod>
- <https://github.com/pion/webrtc/blob/v4.2.18/track_local_static.go>
- <https://github.com/pion/webrtc/blob/v4.2.18/LICENSE>
