# ADR-0014: Browser Node-Local Encoding Pool

- Status: Accepted design; implementation/physical acceptance pending
- Date: 2026-09-09

## Context

The [Browser pool research](../research/browser-local-encoding-pool.md) proves
that an independent local WebRTC encoder can supply real video to multiple
outgoing senders by replacing each sender's own encoded-frame payload. This
preserves standard transform ownership and avoids making one downstream
connection the shared encoding authority. Small carrier encodes and local
transport/decoder work remain real costs. Measured savings and recovery vary
by codec; the prototype is not production acceptance.

This decision extends [ADR-0007](./0007-path-isolated-representation-quality.md)
and [ADR-0013](./0013-embedded-node-local-media.md) for eligible Browser outputs.
Their ordinary Browser path remains available. The existing Native composition
in [ADR-0011](./0011-browser-assisted-native-fanout.md) remains independently owned.

## Decision

1. A Browser source owner manages a bounded set of local encoding groups for
   its direct children. Compatible consumers reuse one group; a missing
   compatible output may require another group. No ancestor lookup, extra
   upstream subscription, room-wide minimum or topology operation is introduced.
2. Each group uses stock WebRTC encoding and adaptation through an independent
   local producer. Each outgoing connection retains stock ICE, DTLS-SRTP,
   bandwidth estimation, RTP packetization, pacing and loss recovery. Screener
   connects existing demand observations to group budgets and membership; it
   adds no congestion estimator, quality score or arbitrary resolution ladder.
3. Reuse `HostPeer` and its existing signaling, sender-mutation and retirement
   owners. A stable per-connection carrier binding installs its transform before
   encoding starts and selects the group's encoded output. It writes each
   carrier frame at most once, in order, by replacing its payload. It does not
   write foreign-owner frames or fabricate native frame statistics.
4. Group compatibility includes source-track identity/generation, negotiated
   codec and codec parameters, Host ceilings, content intent, degradation
   preference and effective demand. Adapted dimensions alone are insufficient.
   Update an owned group's rates in place; a new observation does not itself
   require recreating an encoder. Unproven compatibility uses ordinary encoding.
5. The original captured or received track remains intact for presentation and
   source ownership. Producers own their input clones; outgoing bindings own
   their carriers. Group queues, retained frames and references are bounded by
   admitted consumers and existing prepared operations. Last-use retirement
   closes unused producers, local connections and worker resources.
6. Live settings and source replacement follow the existing requested/applied
   boundary. Prepare the replacement while retaining healthy output, reject
   stale completion, and release the old group only after the owning operation
   commits. Failure preserves the prior applied state. Pause synchronously gates
   borrowed payload, including pending output; stop cancels pending preparation
   and releases resources. A quiet source is not evidence of failure.
7. Switching requires an accepted recovery frame and compatible key/delta,
   dependency, codec and packetization metadata. Preserve ordering and discard
   obsolete data only at a valid recovery boundary. Carrier timestamps and
   sender reports must remain consistent with real content and audio timing.
   Browser feature flags that relax ownership or metadata checks are not a
   product dependency.
8. Keep producer, carrier, actual egress and receiver observations distinct.
   Receiver details use inbound decoded dimensions/FPS and received-byte rates.
   Fresh receiver reports remain authoritative for remote delivery details.
   Carrier dimensions, encode time and limitation reason describe its tiny
   encoder; they cannot establish real-picture quality or per-child CPU cost.
   Preserve raw RTCStats and report unknown when actual-media attribution is
   unproved. Quality convergence requires evidence from the attached output
   and the same receiving connection, not substituted shared-producer counters.
9. Browser-to-Native ingress, dedicated ordinary recovery candidates and the SFU
   publisher remain distinct compositions. Do not add redundant pooling behind
   Native encoded fanout. SFU integration must preserve its existing two-RID
   representation policy, demand activation and aggregate publication budget;
   declaring carrier dimensions or silently collapsing it to one RID is invalid.
   Unsupported APIs and unproven compositions retain the ordinary Browser path.

## Acceptance And Consequences

Activation requires codec-specific evidence for late join, constrained-child
entry/recovery, unaffected siblings, dependency correctness, synchronized A/V,
pause, settings/source rollback, producer failure and bounded retirement.
Compare useful delivery and whole-node CPU/GPU cost with ordinary senders;
fewer full-size encodes alone do not justify adoption. Sampling intervals,
test budgets and fixture thresholds remain research evidence, not product rules.
Implementation and physical acceptance are tracked in [TODO](../todo.md).

## API And Primary References

- [W3C Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/#stream-processing)
  permits own-frame payload modification while enforcing owner and order.
- [Chromium M152 sender implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/third_party/blink/renderer/modules/peerconnection/rtc_rtp_sender.cc)
  supports keyframe requests through `setParameters` encoding options.
- [M152 transformer IDL](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.82/third_party/blink/renderer/modules/peerconnection/rtc_rtp_script_transformer.idl)
  does not expose `generateKeyFrame`; do not assume that API exists.
- [Pinned WebRTC transform delegate](https://webrtc.googlesource.com/src/+/6f37672d358475cd17544121a12494da454d85fb/modules/rtp_rtcp/source/rtp_sender_video_frame_transformer_delegate.cc)
  retains original frame type and pre-transform size, motivating the metadata
  and accounting requirements above.
