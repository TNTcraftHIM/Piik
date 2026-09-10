# ADR-0013: Embedded Node-Local Media

- Status: Accepted; physical evidence and release boundaries are owned by status
- Date: 2026-09-07

## Context

The owner accepts one self-contained Piik process for the current STUN and
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
   within Host ceilings, not a new Piik quality score or arbitrary ladder.
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

The Native integration uses one complete stock WebRTC encoding/adaptation
pipeline per shared local output. Its source adapter, rate correction, resource
feedback and input dropping share that output's lifetime; they are not cloned
per consumer behind an encoder cache. The existing Pion/LiveKit transport owns
the input bitrate budget and forwarding. Ordinary encoder adaptation preserves
the unadapted capture/received original, source timeline and route identity.
This refines the implementation boundary, not the direct-child demand model or
an acceptance claim. The [encoder-pool evidence](../research/webrtc-encoder-pool.md)
shows why sharing the codec alone loses reuse or churns under independent drops.

Incompatible direct-child budgets own separate adaptive outputs. Equal effective
requests within the same source generation, codec, preference and ceiling may
share; dimensions alone are not a compatibility key. Rates update an owned
pipeline in place, not by recreating it for every bitrate sample. Membership
changes wait for independent recovery, retain existing transport identity and
stop the last unused codec slot. The original input is not lowered by a derived
group. Physical codec slots are bounded by endpoint admission, not by LiveKit's
three spatial-layer labels; each connection sees original plus its assigned
adaptive output. SFU publication retains its aggregate allocation separately.
No ancestor lookup, extra upstream layer subscription or new congestion policy
is introduced.

- One media model can serve Native edges and embedded server forwarding without
  duplicating room authority. The adapter is not a second room policy.
- Extra low encodes, decoder work, frame copies and publication upload remain
  real costs. A fixed set of layers does not solve bandwidth below its lowest
  layer or CPU overload; those cases need framework adaptation and verification.
- An available lowest output owned by a live local rate-controlled codec uses
  the framework's non-pausing allocation policy at positive budgets; raw relay
  input and forwarding SFU outputs retain pausing. Cold codec preparation and
  existing estimation windows still impose transition cost, so eventual recovery
  does not establish low-bandwidth latency parity.
- Replacing the external SFU changes Browser signaling/media integration and
  deployment. Cut over one coordinated current contract, delete replaced paths
  in that boundary, and preserve active-share/rollback rules from CONTRIBUTING.
- The candidate implements this model through shared Pion/LiveKit media
  components; ADR-0007 retains the earlier
  production/runtime context and its unchanged Browser source/codec decisions.
  Implementation is not acceptance of hardware, mixed peers, loss/recovery or
  production cutover. Current product modules describe the candidate, while
  status and deployment records keep production evidence separate.
- [TODO](../todo.md) owns remaining implementation and acceptance. Research owns
  measurements and library-selection evidence; no production switch is added
  merely because a probe passes.

## References

- [RTP simulcast design and tradeoffs, RFC 8853](https://www.rfc-editor.org/rfc/rfc8853)
- [RTP switching and source projection, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667)
- [LiveKit demand envelope](https://github.com/livekit/livekit/blob/v1.13.6/pkg/rtc/dynacast/dynacastmanagervideo.go)
- [Implementation proposal and reuse map](../research/node-local-media-design.md)
- [Embedded media evaluation](../research/embedded-media.md)
