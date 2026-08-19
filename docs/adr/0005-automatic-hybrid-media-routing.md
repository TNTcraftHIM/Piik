# ADR-0005: Automatic Hybrid Media Routing

- Status: Proposed - Draft Implementation, Experiment Only
- Date: 2026-08-19

## Context

The product has always required route selection and recovery to be automatic
and invisible to the broadcaster and viewers. Earlier repository wording that
prohibited silent migration was an incorrect interpretation and is superseded
by this proposal. Simplicity constrains the controller and user experience; it
does not require users to choose a media topology.

The ordered preference remains:

1. direct P2P edges;
2. peer-assisted forwarding;
3. an SFU supplied by the deployment; and
4. bounded waiting or failure when no route can satisfy the budgets.

Every P2P edge independently tries direct ICE and authenticated TURN fallback.
TURN is not a separate room topology. The host and every future native/encoded
relay have a downstream budget of at most two active media edges. The current
browser relay remains stricter at one child.

ADR-0004 implements automatic peer assignment but not cross-mode fallback.
Draft PR #12 implements a mutually exclusive process-wide `p2p|sfu` mode. That
model cannot satisfy the required priority or minimize server egress.

## Proposed Experiment

Treat the SFU as a virtual parent for selected fallback roots, not as an
all-room replacement. Keep the existing peer-assisted topology as the active
baseline and add one in-memory `MediaRouteController` per room.

```text
normal:   host -> root A -> ...
          host -> root B -> ...

fallback: host -> remaining peer root -> ...
          host -> SFU -> selected fallback roots -> existing descendants
```

Only fallback roots subscribe directly to the SFU. Each root can continue to
feed its existing peer child, so SFU egress is approximately `K*B`, where `K`
is the number of SFU roots, rather than necessarily `N*B` for all viewers.

Deployment decides whether SFU capacity exists by configuring the complete
LiveKit endpoint/key/secret tuple. There is no user-facing topology selector and
no process-wide `MEDIA_MODE` union. Without the tuple, the same controller ends
at peer assistance and bounded waiting/failure.

## Draft Implementation Status

The current `feat/automatic-hybrid-routing` branch implements this controller
on top of Draft PR #13. It is not merged or deployed. Production remains on the
ordinary one-host-peer-per-viewer path.

The Draft keeps the LiveKit dependency dormant unless the complete URL, API key,
and API secret tuple is present together with `PEER_ASSISTED_MEDIA=true`. It
issues short-lived room-, role-, peer-, and publication-generation-bound grants,
and only allowlisted branch roots may subscribe. The server first retries a
failed edge through the deterministic peer topology; only an exhausted peer
route can request an SFU branch root.

Every viewer starts with zero relay capacity for each authenticated session. A
peer-assisted Web client explicitly advertises either zero or one downstream
edge; conservative UA-CH/user-agent detection reports mobile and iPad clients as
leaves and desktop-class browsers as one-child relays. The controller uses this
binary capability only for future admission and recovery. Withdrawing capacity
does not proactively migrate an otherwise healthy existing edge.

Targeted tests cover the revision controller, protocol authorization, relay
capacity, ordered client transitions, stale asynchronous work, server-restart
resynchronization, one-shot credential recovery, and peer failback. A corrected
Chrome 151/LiveKit 1.13.5 localhost run physically failed the same leaf through
peer recovery/reparent and a two-root SFU route. That leaf resumed frames and
hook-assisted 25 ms sampling saw a host edge peak of two. Failure report to
active took 1.481 seconds and to new render 2.257 seconds, so the sub-second gate
failed. The final repository check passes 253 tests, type checking, and both
builds; public transport/audio/load/browser checks remain pending, so this ADR
stays Proposed.

## State And Wire

The server holds one room revision with a participant assignment for every
retained member, plus at most one pending room plan:

```ts
type Upstream =
  | { kind: "none" }
  | { kind: "peer"; peerId: string }
  | { kind: "sfu" };

interface ParticipantRoute {
  upstream: Upstream;
  childPeerIds: string[];
}

interface RoomMediaRoute {
  revision: number;
  assignments: Map<string, ParticipantRoute>;
  sfu: {
    publicationGeneration: string | null;
    rootPeerIds: string[];
  };
}
```

The server mapping is authoritative. Each participant receives only its own
assignment for that room revision; it never receives or edits the complete
mapping. The explicit SFU publication generation prevents an old and a new
publisher from being counted as one logical edge during commit or rollback.

Minimal protocol additions:

- `relay-capacity { downstreamEdges: 0 | 1 }` from an authenticated
  peer-assisted viewer;
- `route-update { revision, phase: "prepare" | "active", assignment }`;
- `sfu-config { revision, url, token }`;
- `route-ready { revision, phase: "prepare" | "active" }`;
- `route-failed { revision, phase, connectionId }`; and
- `refresh-sfu { revision }`.

Authentication carries only the current participant assignment and room
revision. An authenticated snapshot is the sole authority allowed to replace a
higher client revision after the signaling server restarts; the client first
retires media owned by the old revision. Existing peer signaling keeps its
connection generation and assigned-edge authorization. The server
derives the failed edge from the authenticated session, active revision, and
connection ID instead of accepting a client-supplied parent or arbitrary reason.
Late, duplicate, or stale revision messages have no effect.

## Transition

1. Keep two ordinary peer roots while those routes work.
2. A failed edge first exhausts its current ICE restart/rebuild and per-edge
   direct/TURN options.
3. The server computes revision `R+1` without mutating the active topology. It
   sends a prepare plan only to the host and required fallback roots.
4. Those participants establish actual LiveKit connections with
   `autoSubscribe:false`, but the host does not publish and roots do not
   subscribe yet. `prepareConnection()` may warm DNS/TLS earlier but is not a
   ready signal.
5. After every required participant acknowledges prepare, the server commits
   the active revision. The host synchronously closes the selected direct root
   before publishing to the SFU. Thus:

   `directHostChildren + activeSfuPublicationGenerations <= 2`.

   `activeSfuPublicationGenerations` is zero or one. A new generation cannot
   publish until the replaced direct edge and any old SFU generation are
   inactive.

6. Allowlisted fallback roots explicitly subscribe. On their first new video
   track, they atomically replace their upstream stream, acknowledge active,
   and feed the existing downstream relay without rebuilding descendants.
7. A prepare timeout increments the revision and restores the unchanged active
   route. A failure after commit creates a new rollback/failure revision; stale
   acknowledgements cannot revive the abandoned plan.

8. An active SFU transport may request one fresh short-lived grant. If that
   retry fails, or token issuance itself fails, the server creates a newer peer
   baseline revision and disables SFU for the rest of the current share. Stop or
   a new sharing generation clears that one-shot circuit breaker.

SFU fallback is sticky until the current share stops. A new sharing generation
starts from the cheapest available route. The first experiment does not
continuously fail back during a live share, avoiding oscillation without adding
a score or hysteresis framework.

The Draft warms only an unpublishing/unsubscribed transport during prepare. Its
media transition is break-before-make: the host releases the replaced peer or
SFU media edge before activating the new one, and a viewer retires its SFU
subscriber before returning to peer media. This avoids depending on transient
overlap and preserves the hard two-edge host invariant, at the cost of a bounded
interruption that still needs measurement.

## Triggers And Budgets

The first controller reacts only to discrete events:

- no eligible peer slot or the accepted maximum depth;
- exhausted ICE/rebuild for an assigned edge;
- relay participant departure;
- unsupported route capability; or
- a hard bounded-send-queue overflow on a future encoded-object route.

It does not combine RTT, CPU, bitrate, geography, or a synthetic health score.
Measurements may add a new explicit trigger only through a reviewed change.

`MAX_SFU_ROOTS_PER_ROOM` bounds server egress. Exhausting that budget waits or
fails explicitly; it never creates a third host edge or silently fans the SFU
out to the whole room.

Sub-second failure recovery is a target after failure detection. The current
30-second control heartbeat cannot meet it for silent partitions, so the media
plane needs a small 100-200 ms liveness/queue signal or an equivalent native
transport event. This signal must be measured before its interval is fixed.

## Security And Privacy

LiveKit credentials remain short-lived, room-bound, role-bound, and memory-only.
Only the host may publish screen tracks. Subscription permissions allow only
the current fallback-root identities. Ordinary SFU media is not end-to-end
encrypted from the SFU operator; the deployment and UI must not claim otherwise.

## Implementation Order

1. Port only LiveKit dependencies, token issuance, deployment templates, and
   thin publisher/subscriber classes from Draft PR #12. Do not merge its
   mutually exclusive protocol or page branches.
2. Split publisher lifecycle into connect, activate, deactivate, and profile
   update; make subscriber connections selective and inactive until assigned.
3. Add versioned route state and pure invariant/property tests.
4. Implement server prepare/commit/abort and strict authorization.
5. Integrate host/viewer first-frame switching while retaining relay children.
6. Extend the tracked `1/3/5/8` benchmark with automatic fallback, direct/TURN,
   source/profile/pause/stop, and server-egress measurements.

## Acceptance Gates

- Host active media edges never exceed two across every prepare, commit,
  rollback, reconnect, and stale-message sequence.
- Current browser relays never exceed one child; future capacity two is exposed
  only by a proven native/encoded capability.
- Only necessary fallback roots receive SFU media and the configured root/egress
  budget is never exceeded.
- Prepare failure leaves the old active route unchanged.
- First new decodable picture arrives within one second after a route failure is
  detected in the reference regional network.
- Existing descendants, source selection, quality profile, pause, audio, and
  persistent-room stop/restart semantics survive the transition.
- No LiveKit configuration preserves the existing P2P/peer behavior and wire.
- LiveKit UDP, TCP, and TURN fallback are independently verified before the SFU
  can be called a reliable final route.

## Consequences

Positive:

- Users do not select or understand a topology.
- Host fanout remains bounded while server media egress is paid only for
  fallback roots.
- The ordinary peer path and its direct/TURN behavior remain reusable.
- Revisioned prepare/commit isolates stale asynchronous results without a
  continuous optimizer.

Negative:

- Strict two-edge migration can include a bounded interruption.
- LiveKit adds an optional operational dependency and can inspect ordinary SFU
  media.
- A media liveness signal and versioned cross-client transition expand the
  state space and require real failure-injection tests.

## Relationship To Existing ADRs

- This proposal corrects the automatic-migration interpretation in ADR-0001
  without changing the currently deployed MVP.
- ADR-0004 remains the bounded full-stream browser-relay experiment.
- If accepted, this ADR supersedes Draft ADR-0003's process-wide explicit media
  mode with automatic hybrid fallback using the same optional LiveKit building
  blocks.
- Native shared encoding and two-tree striped distribution remain orthogonal
  data-plane experiments under separate decisions.

## References

- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/#selective-subscription)
- [LiveKit track subscription permissions](https://docs.livekit.io/transport/media/publish/#track-permissions)
- [LiveKit connection preparation](https://docs.livekit.io/reference/client-sdk-js/functions/Room.prepareConnection.html)
- [WebRTC](https://w3c.github.io/webrtc-pc/)
