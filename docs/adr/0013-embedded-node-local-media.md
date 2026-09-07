# ADR-0013: Embedded Node-Local Media

- Status: Accepted architecture; implementation and release acceptance pending
- Date: 2026-09-07

## Context

The owner accepts one self-contained Screener process for the current STUN and
SFU services, and one shared encoded-media model for capable Native P2P nodes
and the SFU. Bundling or supervising coturn/LiveKit executables does not meet
this requirement. The existing product uses coturn only as STUN, not TURN.

The [encoding comparison](../research/node-local-encoding-probe.md) and
[decode comparison](../research/node-local-browser-probe.md) establish real
unused-layer cost and codec lifecycle costs, but not complete network/hardware
acceptance. Mature simulcast implementations provide the starting model.

## Decision

1. Every parent, including Host and the SFU, owns only its direct children's
   media demands. Keep the existing single room authority, committed route graph
   and serial route operation. Media layer changes are not topology operations.
2. Forward a suitable existing encoding. Derive a missing lower output at its
   direct parent and share that encoded output among compatible children. Do
   not create an encoder per child. A forwarding-only healthy relay creates no
   decoder/encoder group just to manufacture unused fallback layers.
3. An already-needed encoding group uses a finite highest-demand envelope:
   produce the highest required output and its lower fallbacks, and stop upper
   outputs no child needs. This is not a promise of a single Host encode under
   all conditions. Representation settings come from the chosen media component
   within Host ceilings, not a new Screener quality score or arbitrary ladder.
4. Each child receives only its selected output. Multiple active encodings do
   not imply sending every output to every child. Preserve the original input,
   source clock and unaffected siblings. Playback quality, cadence and recovery
   take priority over reducing the number of encoders.
5. Mature media components own bandwidth estimation, rate allocation, pacing,
   loss recovery and safe switching. The shared group owns representation
   lifetime and reuse. Do not add a second congestion controller, fine-grained
   warm cache, whole-tree demand scanner or periodic topology rebalancer.
6. The SFU remains one Host publication with one-to-many distribution. For a
   forwarding SFU, its upstream demand is the maximum required by its direct
   subscribers; Host combines that demand with its direct P2P children's demand.
   This requests the highest needed representation, not a sum of encoding counts
   or a room-wide minimum. The aggregate publication must fit its own upstream
   congestion budget; requested quality is not a delivery guarantee.
7. Shared group code must be reusable by the SFU and Native paths. A future
   transcoding SFU reports its actual input requirements instead of blindly
   forwarding every downstream request. Do not require server transcoding or
   recursive subtree demand to ship a forwarding SFU.
8. Embed library-level STUN, preserving Binding and the three NAT-survey
   destinations without enabling TURN allocations. Evaluate an embedded SFU
   library through a narrow adapter. `inlivedev/sfu` is a candidate, not an
   irrevocable selection or authorization for a deep fork.
9. Pure Browser peers retain normal WebRTC capture/senders and can consume the
   same H264/VP8 output. No Browser encoded-passthrough promise, new codec family
   or application transport is introduced by this architecture.

For an SFU that forwards existing layers:

```text
SFU upstream demand = max(SFU direct-subscriber demands)
Host output demand  = max(Host direct-P2P demands, SFU upstream demand)
```

Indirect P2P descendants are not included in either aggregate. Native parents
handle their own derivation. Framework estimates must distinguish desired,
available and actually delivered output so missing high input cannot be
mistaken for a healthy high-quality path.

## Consequences And Release Boundary

- One media model can serve Native edges and embedded server forwarding without
  duplicating room authority. The adapter is not a second room policy.
- Extra low encodes, decoder work, frame copies and publication upload remain
  real costs. A fixed set of layers does not solve bandwidth below its lowest
  layer or CPU overload; those cases need framework adaptation and verification.
- Replacing the external SFU changes Browser signaling/media integration and
  deployment. Cut over one coordinated current contract, delete replaced paths
  in that boundary, and preserve active-share/rollback rules from CONTRIBUTING.
- ADR-0007 remains the current runtime contract until the replacement passes.
  This decision accepts the new model and its implementation work, not claims
  that hardware, mixed peers, loss/recovery or shutdown already pass.
- [TODO](../todo.md) owns remaining implementation and acceptance. Research owns
  measurements and library-selection evidence; no production switch is added
  merely because a probe passes.

## References

- [RTP simulcast design and tradeoffs, RFC 8853](https://www.rfc-editor.org/rfc/rfc8853)
- [RTP switching and source projection, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667)
- [LiveKit demand envelope](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/dynacast/dynacastmanagervideo.go)
- [Implementation proposal and reuse map](../research/node-local-media-design.md)
