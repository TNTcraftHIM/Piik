# ADR-0005: Automatic Hybrid Media Routing

- Status: Proposed - Default-Off Implementation, Experiment Only
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

TURN and SFU occupy different layers. TURN replaces transport for only the ICE
edge that selected a relay pair. An SFU is a virtual topology parent and may
feed only one or two necessary roots; after media reaches a reliable root, the
existing bounded peer subtree remains the preferred distribution path. A
zero-descendant SFU root is allowed only when no relay root satisfies
capability, depth, path, and recovery gates; it still counts against the same
one-or-two-root room budget.

ADR-0004 implements automatic peer assignment but not cross-mode fallback.
Closed PR #12 proposed a mutually exclusive process-wide `p2p|sfu` mode; this
ADR and merged PR #17 supersede that model because it cannot satisfy the route
priority or minimize server egress.

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

Only one or two fallback roots subscribe directly to the SFU, and each can
continue to feed its bounded peer descendants. If no reliable relay root
exists, a necessary viewer may be an SFU root with no descendants under that
same total; this is the last central-fanout boundary, not a default whole-room
topology. The cost model is owned by the linked low-server research.

Deployment decides whether SFU capacity exists by configuring the complete
LiveKit endpoint/key/secret tuple. There is no user-facing topology selector and
no process-wide `MEDIA_MODE` union. Without the tuple, the same controller ends
at peer assistance and bounded waiting/failure.

## Implementation Status

Merged PR #17 implements this controller on top of merged PR #13. Merged PR #20
adds only the bounded standby prewarm described below. Their code ships in
production release `769de201f7cc`, but the deployment has neither
`PEER_ASSISTED_MEDIA` nor a LiveKit tuple, so its active path remains ordinary
one-host-peer-per-viewer P2P/TURN.

The repository also supports an optional strict `PEER_ASSISTED_ROOM_IDS`
deployment allowlist. When non-empty, only exact listed room IDs enter the
controller or receive optional LiveKit standby and grants. All other rooms
retain the legacy P2P authentication shape and signaling/quality/lifecycle
behavior. Missing or empty preserves the previous all-room behavior when
`PEER_ASSISTED_MEDIA=true`; malformed or duplicate entries fail startup. The
boundary is deployment-only and intentionally has no browser selector,
percentage framework, or second router.

The implementation keeps the LiveKit dependency dormant unless the complete URL, API key,
and API secret tuple is present together with `PEER_ASSISTED_MEDIA=true`. It
issues short-lived room-, role-, peer-, and publication-generation-bound grants,
and only allowlisted branch roots may subscribe. A necessary viewer with no
descendants is still a root under the same authorization and total cap. The
server first retries a failed edge through the deterministic peer topology;
only an exhausted peer route can request an SFU branch root. A
healthy route does not migrate merely because one or both selected edge
transports use TURN.

Every viewer starts with zero relay capacity for each authenticated session. A
peer-assisted Web client explicitly advertises either zero or one downstream
edge; conservative UA-CH/user-agent detection reports mobile and iPad clients as
leaves and desktop-class browsers as one-child relays. The controller uses this
binary capability only for future admission and recovery. Withdrawing capacity
does not proactively migrate an otherwise healthy existing edge.

Targeted tests cover the revision controller, protocol authorization, relay
capacity, ordered client transitions, stale asynchronous work, server-restart
resynchronization, one-shot credential recovery, peer failback, and optional
standby warming. The corrected cold Chrome 151/LiveKit 1.13.5 localhost run took
1.481 seconds from failure report to active and 2.257 seconds to a new rendered
frame. With authenticated standby warming, the same physical-leaf/two-root
scenario took 200 ms to active and 319.7 ms to render while the host edge peak
remained two. Public transport/audio/load/browser checks remain pending, so this
ADR stays Proposed.

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

- optional `sfuStandbyUrl` in a peer-assisted authenticated snapshot, only when
  the server has complete LiveKit fallback configuration;
- `relay-capacity { downstreamEdges: 0 | 1 }` from an authenticated
  peer-assisted viewer;
- `route-update { revision, phase: "prepare" | "active", assignment }`;
- `sfu-config { revision, url, token }`;
- `route-ready { revision, phase: "prepare" | "active" }`;
- `route-failed { revision, phase, connectionId }`; and
- `refresh-sfu { revision }`.

Authentication carries the current participant assignment and room revision,
plus the non-secret standby URL when fallback is configured. It never carries a
standby JWT. An authenticated snapshot is the sole authority allowed to replace
a higher client revision after the signaling server restarts; the client first
retires media owned by the old revision. Existing peer signaling keeps its
connection generation and assigned-edge authorization. The server
derives the failed edge from the authenticated session, active revision, and
connection ID instead of accepting a client-supplied parent or arbitrary reason.
Late, duplicate, or stale revision messages have no effect.
Non-allowlisted rooms receive the ordinary P2P snapshot with none of the hybrid
fields above, even when the same process serves an allowlisted room and has a
complete LiveKit tuple.

## Transition

1. Keep two ordinary peer roots while those routes work.
2. A failed edge first exhausts its current ICE restart/rebuild and per-edge
   direct/TURN options.
3. The server computes revision `R+1` without mutating the active topology. It
   sends a prepare plan only to the host and required fallback roots.
4. When fallback is configured, host and viewer clients have already made one
   best-effort, token-free `prepareConnection(url)` call after their authoritative
   authenticated snapshot. This only warms the SDK/DNS/TLS path and is not a
   participant, media edge, or ready signal. Required participants then establish
   actual LiveKit connections with
   `autoSubscribe:false`, but the host does not publish and roots do not
   subscribe yet.
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

The authenticated standby is not a transport: it has no grant and never joins a
room. During route prepare the Draft warms only an unpublishing/unsubscribed
transport. Its media transition remains break-before-make: the host releases the
replaced peer or SFU media edge before activating the new one, and a viewer
retires its SFU subscriber before returning to peer media.

## Standby Prewarm Result

Pinned `livekit-client` 2.22.0 implements token-free self-hosted
`Room.prepareConnection(url)` as a best-effort HTTP `HEAD` to the corresponding
HTTP(S) origin. The SDK catches failure internally. It performs no `connect`, so
it neither creates a LiveKit participant nor publishes/subscribes media. The
client dynamically imports the SDK once, attempts each advertised URL once, and
drops work made stale before import by a newer authenticated snapshot. Failure
silently preserves the existing cold path; there is no timer or retry loop.

One bounded cold/standby A/B comparison used Chrome 151, LiveKit 1.13.5,
headless synthetic 1280x720/30 video, three viewers, and localhost. The harness
physically closed the same leaf's inbound peer edge, observed it resume under a
second peer, then physically closed that new edge and reported its real
connection ID and active revision. The resulting plan had two allowlisted SFU
roots.

| Failure report to | Cold route controller | Authenticated standby |
| --- | ---: | ---: |
| SFU prepare | not retained | 5 ms |
| SFU active | 1,481 ms | 200 ms |
| Same-leaf rendered frame | 2,257 ms | 319.7 ms |

The standby path had already downloaded and parsed the dynamically imported SDK
and had called its token-free `HEAD`, so this A/B does not isolate SDK startup
from DNS/TLS/HTTP preparation. It created no participant or media edge. The same
leaf decoded 31 SFU frames and produced 31 new frame callbacks before the
after-run completed. Both roots and the host SFU transport were connected; 25 ms
sampling observed a host media-edge peak of two. This is a local go for retaining
the optimization; the roughly 86% improvement must not be extrapolated to a
public network.

## Triggers And Budgets

The first controller reacts only to discrete events:

- no eligible peer slot or the accepted maximum depth;
- exhausted ICE/rebuild for an assigned edge;
- relay participant departure;
- unsupported route capability; or
- a hard bounded-send-queue overflow on a future encoded-object route.

It does not combine RTT, CPU, bitrate, geography, or a synthetic health score.
Measurements may add a new explicit trigger only through a reviewed change.
ADR-0007's `HIGH`/`FALLBACK` quality state is separate and does not become a
topology trigger or a room-wide health score.

`MAX_SFU_ROOTS_PER_ROOM` bounds server egress. Exhausting that budget waits or
fails explicitly; it never creates a third host edge or silently fans the SFU
out to the whole room.

Sub-second failure recovery is a target after failure detection. The current
30-second control heartbeat cannot meet it for silent partitions, so the media
plane needs a small 100-200 ms liveness/queue signal or an equivalent native
transport event. This signal must be measured before its interval is fixed.

## Shadow-Only Dual-TURN Candidate

Four cases define the decision boundary: retain direct/direct and direct/TURN
peer roots; treat stable TURN/TURN roots only as a shadow SFU-root candidate;
and use the current failure-only SFU path only after no reliable relay root
remains. A necessary zero-descendant viewer still consumes one of the same one
or two SFU-root slots. No stability threshold or new trigger is accepted.

The bounded cost model, privacy-safe ICE fields, four-case measurement matrix,
and exact-room shadow/A/B sequence live in
[Low-Server-Cost Media Routes](../research/low-server-media-routes.md). One
important accounting invariant is retained here: host-to-SFU publisher,
SFU-to-root subscriber, and peer-descendant edges are independent ICE
connections and each may use TURN. Every host NIC, TURN ingress/egress, SFU
ingress/egress, and root NIC hop is real traffic and remains in service and
billing totals, even when the same logical payload traverses consecutive hops.

Only measured benefit plus an amended ADR-0005 may authorize an automatic
exact-room canary. Until then, shadow observation changes no route, wire,
controller, or production trigger, and the implementation remains
failure-only.

## Security And Privacy

The standby URL is an origin, not a credential. LiveKit credentials remain
short-lived, room-bound, role-bound, and memory-only.
Only the host may publish screen tracks. Subscription permissions allow only
the current fallback-root identities, including any zero-descendant roots.
Ordinary SFU WebRTC transport encryption terminates at the SFU, so its operator
can access media. LiveKit supports application E2EE in which its server cannot
access media content, but signaling/API data remains visible and Screener has
not implemented the required key distribution. The shadow comparison must
record which boundary is actually configured and the UI must not claim E2EE.

## Implementation Order

1. Reuse only the LiveKit dependencies, token issuance, deployment templates,
   and thin publisher/subscriber boundary developed in closed PR #12. Do not
   restore its mutually exclusive protocol or page branches.
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
- A reliable SFU root continues to serve bounded peer descendants; only when no
  reliable relay root exists may a necessary viewer be a zero-descendant root,
  still within the same one-or-two-root cap.
- Prepare failure leaves the old active route unchanged.
- First new decodable picture arrives within one second after a route failure is
  detected in the reference regional network.
- Existing descendants, source selection, quality profile, pause, audio, and
  persistent-room stop/restart semantics survive the transition.
- No LiveKit configuration preserves the existing P2P/peer behavior and wire.
- In one process, non-allowlisted rooms preserve the legacy P2P wire, directed
  signaling, quality rejection, stop/reconnect/delete semantics, and remain
  isolated from allowlisted peer/SFU state.
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
- A configured peer-assisted client downloads/parses the current build's roughly
  137.5 kB gzip (531 kB minified) LiveKit chunk and sends one `HEAD` even if it
  never needs SFU, shifting that small one-time client/static-egress cost earlier.
  An unconfigured client pays neither cost.
- A media liveness signal and versioned cross-client transition expand the
  state space and require real failure-injection tests.

## Relationship To Existing ADRs

- This proposal corrects the automatic-migration interpretation in ADR-0001
  without changing the currently deployed MVP.
- ADR-0004 remains the bounded full-stream browser-relay experiment.
- This experiment and merged PR #17 supersede ADR-0003/closed PR #12's
  process-wide explicit media mode with default-off automatic hybrid fallback.
  ADR-0003 remains historical rejected/superseded context.
- Native shared encoding and two-tree striped distribution remain orthogonal
  data-plane experiments under separate decisions.
- ADR-0007 owns per-path quality fallback and its two-representation budget;
  this route controller does not aggregate viewer quality into a shared target.

## References

- [LiveKit selective subscription](https://docs.livekit.io/transport/media/subscribe/#selective-subscription)
- [LiveKit track subscription permissions](https://docs.livekit.io/transport/media/publish/#track-permissions)
- [LiveKit client 2.22.0 `prepareConnection` source](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/Room.ts)
- [LiveKit JavaScript client usage](https://github.com/livekit/client-sdk-js#usage)
- [LiveKit end-to-end encryption](https://docs.livekit.io/transport/encryption/)
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC](https://w3c.github.io/webrtc-pc/)
