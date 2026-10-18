# Scoped Go Dependency Repairs

The root `go.mod` replaces these two modules with local source. They retain
their original module paths and Apache-2.0 licenses. The checked-in source,
upstream tests and focused regressions are built and tested by
`npm run check:go`.

| Module | Source baseline | Local changes |
| --- | --- | --- |
| `go-nat` | [netbirdio/go-nat at 6b2c8c5c74e8](https://github.com/netbirdio/go-nat/tree/6b2c8c5c74e8331ed41811cfd2fdc4c3dd8c3ff0) | NAT-PMP honors contexts, assigned ports and deletion; optional PCPv6 finishes inside Piik's mapping budget so it cannot withhold successful IPv4; regressions retain both gateway paths |
| `go-nat-pmp` | [jackpal/go-nat-pmp v1.0.2](https://github.com/jackpal/go-nat-pmp/tree/v1.0.2) | Context-aware request methods, deadline/cancellation through UDP I/O, adapted recorder/test caller, and a module manifest |

Upstream source and tests are retained, excluding examples and CI configuration.
Modified upstream files carry a notice; formatting follows the project Go
toolchain. The package notice collector reads the replacement modules' license
files directly, so App archives retain their attribution.

These repairs preserve the existing gateway selector and PCPv6 composition.
The [NAT research owner](../../docs/research/nat-traversal.md#gateway-and-survey-limits)
describes the runtime limits. Do not add a second gateway client in Piik.

When maintained upstream revisions cover these fixes and the same regressions
pass, replace both local module directives with version pins, remove their source
directories and the extra dependency test patterns in `scripts/check-go.mjs`.
Until then, review updates against the named baselines; do not edit Go's shared
module cache or apply build-time patches.

## LiveKit Send-Side Bandwidth Estimation

`livekit/sendsidebwe` retains only the eight source files from
[LiveKit v1.13.6's package](https://github.com/livekit/livekit/tree/v1.13.6/pkg/sfu/bwe/sendsidebwe),
with its original `LICENSE` and `NOTICE`. It uses the existing pinned LiveKit
interfaces; the rest of LiveKit comes from the pinned Go dependency, including
the temporary allocator input described below. No build-time patch is applied.

Measurement corrections are marked in the modified files: probe finalization
returns the current acknowledged capacity and rejects invalid/empty feedback;
probe timing begins with its first acknowledged packet, excluding pre-probe idle
time; congestion statistics retain the packet that starts each new CTR group,
including its received/lost accounting; overlapping TWCC feedback changes each
packet's state once, retaining late ACKs without duplicating counts or moving
the receive-time baseline. Piik's shared forwarding package uses this copy for
both individual transports and publications. Its regression checks use real
TWCC feedback and retain the no-feedback and idle-before-probe controls. The
[media research owner](../../docs/research/node-local-media-design.md#send-queue-recovery)
records the runtime evidence and remaining limits.

The package notice collector still includes LiveKit's upstream license and
notice through the other compiled LiveKit packages. When a maintained upstream
version covers these corrections and the same regressions pass, remove this
directory and restore the upstream imports. Review dependency bumps against the
named baseline; do not evolve a separate congestion-control algorithm here.

The LiveKit dependency includes
[upstream #5013](https://github.com/livekit/livekit/pull/5013), which restores
probe delivery after cached RTX packets expire. Its earlier
[padding correction](https://github.com/livekit/livekit/pull/4993) also replaces
Piik's former padding writer. Those repairs use the upstream dependency; no
additional LiveKit package is copied here. The local send-side measurement
corrections above remain necessary.

The dependency also includes [upstream #5018](https://github.com/livekit/livekit/pull/5018)
and [#5019](https://github.com/livekit/livekit/pull/5019): dummy-start timestamp
offsets stay within the RTP clock's wrap domain and are cleared on receiver
restart. These correct layer/source-switch continuity in the existing DownTrack;
Piik adds no timestamp repair alongside it.

The retained detector also includes [upstream #4935](https://github.com/livekit/livekit/pull/4935)
and its regression from v1.13.9, adapted to standard Go assertions. Reserved
TWCC symbols carry no receive delta: skip their measurement rather than consuming
the next packet's delta or indexing past the feedback array.

### Local Encoder Probe Demand

Until [upstream #5016](https://github.com/livekit/livekit/pull/5016) is available,
the root module replaces LiveKit with the immutable
[c7f56b38 revision](https://github.com/TNTcraftHIM/livekit/commit/c7f56b38971398d077a0aa5004443eaf3c31016c),
based on upstream `cde3991916cf`. Its only changes are an optional local encoder
demand input to `StreamAllocator` and regression tests. Native publication uses
that input; ordinary forwarding leaves it unset. The existing allocator still
owns probe timing, congestion response and allocation; encoder demand does not
change track-deficiency state. No allocator source is copied into Piik and no
build-time patch is applied.

The explicit `TestPublicationConstrainedRecovery` gate and the upstream tests
cover recovery and withdrawal without replacing measured source rates or
capacity. Once an upstream revision supports this input and passes those
checks, remove the replacement directive and its replacement checksums. The
separate local send-side estimator corrections retain their own removal gate.

## Pion Repaired-Packet Identity

The shared [RTP receive adapter](../media/forwarding/codecs.go) uses the negotiated
primary codec for packets Pion identifies as repaired. In Pion v4.2.23,
[`receiveForRid`](https://github.com/pion/webrtc/blob/v4.2.23/rtpreceiver.go)
initializes the codec before the first primary read initializes `PayloadType`;
an earlier RTX packet can therefore be queued with payload type zero.
Ordinary packet validation remains unchanged. A real simulcast/NACK regression
fences that ordering without sleeps and fails when the correction is removed.
Remove the adapter when a maintained upstream version passes that same control
without it; no Pion source fork or second retransmission handler is retained.
