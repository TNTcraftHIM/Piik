# ADR-0016: Shared Rust Core For 3.0

- Status: proposed
- Date: 2026-11-25

## Context

Published 2.x runs a Go backend ([ADR-0012](./0012-shared-go-backend-core.md))
with one Host per room, memory-resident rooms
([ADR-0002](./0002-memory-resident-protected-rooms.md)) and an embedded SFU as
the fallback route. Its room, signaling and routing rules live in that server.

3.0 changes what a room is. Several people share at once, and a room carries
conversation with history, files, room voice and synchronized viewing. A room
can be operated by a Browser page, the desktop App or a Server, so the same
admission, ordering and routing rules must run in all three. Writing them once
per runtime would let the three diverge, which is the cost ADR-0010 and
ADR-0012 each accepted a larger runtime to avoid.

The isolated 3.0 line already implements the decision below. No record states
it, and ADR-0012 still reads as the accepted backend.

## Decision

1. One Rust crate, [`channel-core`](../../prototype/channel-core/src), owns
   domain admission, room authority, signed conversation and history rules,
   activity and publication plans, and transport leases. It owns no sockets,
   clocks, locks, timers or queues: callers pass connection identities and the
   time, complete its storage effects and deliver its events.
2. Three adapters execute that crate and own their local resources:
   [Browser](../../prototype/channel-browser) through WASM with IndexedDB,
   [Native](../../prototype/channel-native) with SQLite and the RTC SDK, and
   [Server](../../prototype/channel-server) for domain HTTP and WebSocket I/O,
   which also composes the App. An adapter does not make an authority decision.
3. The hierarchy is Channel, Room, Activity. A channel owns identities, the room
   directory and signaling. Each available room has exactly one writer, which
   commits history before it confirms. Each activity selects its own delivery
   paths over one channel pool of confirmed endpoint pairs.
4. The channel's hosting mode places the room writer: on the creator's Browser
   or App in a lightweight channel, on the Server in a hosted one. Access is a
   separate room setting.
5. Media stays automatic and peer-to-peer first. ICE, DTLS, SRTP, SCTP and
   congestion control belong to Browser WebRTC and the Native RTC SDK. Native
   forwards encoded media; a Browser that relays decodes and encodes again.
6. For 3.0 this supersedes ADR-0012 and the Go, LiveKit and Pion runtime.
   Published 2.x keeps its own records on `main` until the cutover that
   [versioning](../standards/versioning.md) defines.

## Authority Of Documents

This record and the [engineering maps](../standards/engineering.md#module-map)
state the architecture. The [network](../research/channel-network-design.md),
[room-data](../research/channel-storage-and-identity.md),
[forwarding](../research/channel-forwarding-plan.md) and
[hosting](../research/server-hosting-plan.md) documents describe the running
prototype and its target designs, with their measurements and dates. Source
schemas own exact wire and storage shapes. When these disagree, the code and
this record win and the research document is corrected.

## Consequences

- One implementation of the rules runs in three runtimes, and a Browser can
  operate a room with no server holding its history.
- The Web build depends on the Rust toolchain and a WASM binding.
- Two storage adapters exist. Their decisions belong in the core; a shared
  scenario replayed by both adapters keeps the remaining code equivalent.
- A Browser relay costs a decode and an encode per hop, which a route through
  Native does not.
- This runtime does not serve the 2.x wire, storage or deployment contracts.
  [Major-upgrade guidance](../standards/versioning.md#major-upgrade-guidance)
  owns what an existing site and its users are told at the cutover.
- Route calibration, relay preference and field measurement stay open in
  [TODO](../todo.md); this record does not decide them.

On acceptance, ADR-0012's status becomes "accepted for published 2.x;
superseded for 3.0 by ADR-0016", and the 3.0 rows of the
[documentation owner map](../standards/documentation.md#owners) name this
record as the architecture owner.

## References

- [Project memory](../project-memory.md) and [status](../status.md)
- [Sans-I/O protocol design](https://sans-io.readthedocs.io/how-to-sans-io.html):
  protocol logic that performs no I/O can be driven by any runtime.
- [str0m](https://github.com/algesten/str0m), the Native RTC SDK, follows the
  same separation.
