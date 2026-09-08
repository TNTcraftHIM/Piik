# ADR-0011: Browser-Assisted Native Encoded Fanout

- Status: accepted
- Date: 2026-09-05

## Context

The product media goal is one encoded source per capable distribution layer.
Standard Browser WebRTC does not expose a way to inject a received encoded frame
into another `RTCPeerConnection` sender. `RTCRtpScriptTransform` can observe or
modify an existing sender or receiver pipeline, but it does not provide an RTP
transport fanout API. Browser simulcast and Dynacast remain appropriate for a
single Browser-to-SFU publication; they do not make independent P2P senders
share one encoder.

The later [Chromium legacy probe](../research/advanced-peer-distribution.md#chromium-legacy-fanout-probe)
demonstrates a non-standard clean-path exception, with unresolved feedback and
statistics. It is not an accepted replacement for this Browser/Client boundary.

The repository already has the required Native boundary: a Pion receiver can
accept H.264/Opus RTP and its encoded source can feed bounded downstream Pion
edges without decoding or re-encoding. The system Browser remains the product
UI and capture owner.

## Decision

1. A Client-launched Browser Host whose current codec is H.264 and whose
   topology optimization is enabled uses one local Browser-to-Native ingress.
   The existing `HostPeer` owns its sender, clone, quality settings and pause;
   the existing Native receiver owns encoded fanout. VP8 and disabled quality
   convergence retain ordinary Browser senders.
2. The ingress is generation-fenced beneath the existing room and route
   controller. It adds no participant, route operation, quality score, or
   representation policy. Steady P2P output uses one Browser encoding; a LiveKit
   publication still owns its separate framework-managed encodings.
3. Native downstream edges reuse the existing `NativeSenderPeer` and
   `sourceConnectionId` path. A quality operation may still use the existing
   Browser sender candidate for one degraded edge; that candidate is an
   exception when sharing an encoding cannot sustain that path. Savings never
   justify worse delivery or disabling native Browser quality adaptation.
4. If the Client is absent or the local ingress fails, the Host keeps the
   Browser capture and recreates affected senders on their current assigned
   routes. Capture and room authority survive loss of the optional fanout.
   Ordinary Browser pages retain their existing media path.
5. Native capture, Browser capture through the local ingress, Native Viewer
   relay, and LiveKit SFU publication remain separate media adapters. No
   application RTP protocol, WebCodecs object protocol, SVC ladder, codec
   parser, or custom congestion controller is added.

## Consequences

- A Client-launched Browser Host can use one Browser encode plus Native encoded
  fanout while preserving the existing UI and room behavior.
- A pure Browser relay remains framework-owned and may encode per child because
  the standard Browser API has no cross-connection encoded-frame injection
  surface.
- A Browser-to-Native loopback edge adds local WebRTC overhead, but it replaces
  repeated remote Browser encoders. Pion owns downstream ICE, DTLS and RTCP;
  its existing GCC observations feed route convergence, not a new layer selector.
- A Browser source switch with unchanged media kinds reuses the local sender.
  A change in audio presence prepares a new ingress before replacing its Native
  children; failure retains Browser capture through ordinary sender recovery.
- A Windows/Chrome two-child gate proves one local encode, 1080p at about 30 fps
  on both Viewers, live quality changes, pause/resume, source audio changes, and
  Client-exit recovery. Weak-path automatic adaptation and its cost remain
  physical acceptance, not a consequence of the clean-path result.

## References

- [Advanced peer distribution research](../research/advanced-peer-distribution.md)
- [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/)
- [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [Pion encoded broadcast](https://github.com/pion/webrtc/blob/main/examples/broadcast/main.go)
- [Pion RTP forwarding and padding](https://github.com/pion/webrtc/blob/main/track_local_static.go)
