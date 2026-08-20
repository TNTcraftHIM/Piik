# ADR-0005: Automatic Hybrid Media Routing

- Status: Accepted Direction - All-Room Controller, Media Evidence Unverified
- Date: 2026-08-19

## Context

The product has always required route selection and recovery to be automatic
and invisible to the broadcaster and viewers. Earlier repository wording that
prohibited silent migration was an incorrect interpretation and is superseded
by this decision. Simplicity constrains the controller and user experience; it
does not require users to choose a media topology.

The ordered preference is:

1. a direct-selected P2P/peer UDP edge using STUN-only ICE;
2. peer-assisted forwarding through an alternate eligible parent;
3. an SFU virtual parent supplied by the flagship deployment; and
4. optional authenticated TURN for one controller-selected exceptional edge; and
5. bounded waiting or failure when no route can satisfy the budgets.

STUN is required and ordinary peer connections remain STUN-only. After peer
recovery and alternate-parent options are exhausted, the controller assigns one
or two SFU roots. Only after the SFU/UDP path also fails may the same controller
authorize one short-lived TURN attempt for the current exceptional edge. TURN
credentials are not participant-wide ICE configuration and are never added to
ordinary peer connections by default. HTTPS/WSS remains TLS/TCP and is outside
this media policy. Every non-server endpoint has at most two active
downstream media edges; its upstream receive edge does not consume that upload
budget. The current browser relay remains stricter at one child until its
re-encode and resource gates pass.

TURN and SFU occupy different layers. A selected TURN candidate continuously
relays media for its authorized ICE edge; it is not a handshake helper or a
topology decision. LiveKit TURN cannot rescue an unavailable SFU. Independent
coturn may transport only the controller-selected peer edge after the SFU/UDP
attempt has failed. An SFU is a virtual topology parent and may feed only one
or two necessary roots; after media reaches a reliable root, the existing
bounded peer subtree remains the preferred distribution path. A
zero-descendant SFU root is allowed only when no relay root satisfies
capability, depth, path, and recovery gates; it still counts against the same
one-or-two-root room budget.

ADR-0004 implements automatic peer assignment but not cross-mode fallback.
Closed PR #12 proposed a mutually exclusive process-wide `p2p|sfu` mode; this
ADR and merged PR #17 supersede that model because it cannot satisfy the route
priority or minimize server egress.

## Accepted Target And Bounded Migration

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

The flagship deployment target supplies SFU capacity with a complete LiveKit
endpoint/key/secret tuple. There is no user-facing topology selector and no
process-wide `MEDIA_MODE` union. A deployment without that tuple ends at peer
assistance and bounded waiting/failure and is not the final flagship route
configuration. Optional selected-edge TURN is a separate deployment tuple and
remains a controller-owned transport attempt, never a topology choice.

## Implementation Status

Merged PR #17 implements this controller on top of merged PR #13, and PR #20
adds the bounded standby prewarm below. The process flag enables the controller
for every normal room; room `1` is retained only as a historical smoke fixture,
and production ordinary peer connections remain STUN-only. The current source
no longer contains the rejected participant-wide
TURN config, issuer, capability, refresh wire, or client propagation. Stale
`PEER_ICE_TURN_*` keys fail startup even when blank. The source candidate now
implements a complete selected-edge tuple and one relay-only rebuild for either
the initial pending Host publication or an active Host/SFU route; production
configures the tuple, but real TURN/media evidence remains open.
The wire has two explicit edge kinds: `peer-selected` for the last-mile failed
peer edge and `host-sfu-ingress` for a restricted Host-to-SFU retry. Ordinary
Peer ICE remains STUN-only.

The current runtime removes the old all-room coturn contract. Production
requires STUN and authenticated ICE snapshots contain only STUN servers in
production. The tracked LiveKit sample explicitly sets `tcp_port: 0`, disables
TCP fallback, supplies
the deployment-owned STUN server, and configures no TURN service. The SFU controller still
activates only after a peer edge exhausts recovery. Public participant entry has
been observed, but retained media and route admission remain unverified. The old
`769de201f7cc` release and coturn relay are isolated rollback resources, not a
permanent compatibility branch or advertised current transport.

`PEER_ASSISTED_MEDIA=true` is now the only rollout switch. It enables the
controller, LiveKit standby, grants, and selected-edge attempts for every normal
room, while each room keeps independent route state and the existing root/fanout
limits. `PEER_ASSISTED_ROOM_IDS` is retired and fails startup if supplied during
migration; room `1` is a historical smoke fixture, not a feature gate. A process
with the flag disabled remains ordinary P2P.

The implementation keeps the LiveKit dependency dormant unless the complete URL, API key,
and API secret tuple is present together with `PEER_ASSISTED_MEDIA=true`. It
issues short-lived room-, role-, peer-, and publication-generation-bound grants,
and only selected branch roots may subscribe. A necessary viewer with no
descendants is still a root under the same authorization and total cap. The
server currently retries a failed edge through the deterministic peer topology;
only an exhausted peer route can request an SFU branch root. The target keeps
healthy routes sticky but may select SFU directly when admission has no eligible
peer path. Optional TURN is controller-selected only after that SFU/UDP attempt
fails. The authorization must bind the current room/share generation, viewer and
parent sessions, route revision, and replaced/new connection identities; stale,
replayed, participant-wide, or unselected attempts fail closed. Coturn still
validates only HMAC and expiry, so application generation checks, short TTL,
one-use state, fanout, and quotas bound the bearer. LiveKit publisher/subscriber
ICE remains a separate participant-wide domain.

Every viewer starts with zero relay capacity for each authenticated session. A
peer-assisted Web client explicitly advertises either zero or one downstream
edge; conservative UA-CH/user-agent detection reports mobile and iPad clients as
leaves and desktop-class browsers as one-child relays. The controller uses this
binary capability only for future admission and recovery. Withdrawing capacity
does not proactively migrate an otherwise healthy existing edge.

The source now implements one narrow admission exception to sticky assignment.
On an active peer-only route with no SFU publication or pending prepare, a
connected, childless Viewer that has no upstream or failed-parent history and
advertises one relay slot may replace the oldest connected, childless,
zero-capacity Host child when both Host slots are full. That leaf becomes the
new relay's only child. The synchronous change preserves Host fanout two,
browser fanout one and the depth bound, advances one route revision, and clears
both changed upstream connection generations. Host-side reconciliation closes
the stale child edge before starting the replacement. No healthy routed
candidate, quality score, timer, global parent penalty, or periodic rebalance is
part of this admission rescue.

The repository quality-reparent candidate adds one bounded parent-to-server
evidence message and no second route owner. Signaling authenticates and
forwards Viewer C under its existing session, connection, revision, parent,
sequence, two-second rate and 2 KiB guards. The current parent then answers only
from its current outbound `HostPeer` sample: a positive `packetsSent` delta is
required. Its existing proof union carries `sending` for current liveness,
`sender-limited` only for an exact `qualityLimitationReason` of `cpu` or
`bandwidth`, or `remote-loss` only when the same interval has at least 100 sent
packets and RTCP-reported remote loss divided by sent packets is at least 30%.
`sending` is diagnostic and cannot advance a bad streak. The 2 KiB answer
echoes the exact C sequence; signaling
accepts it once, within five seconds, from the current parent session and same
child generation. A parent consumes a stats sample only once per child and
current connection, using the existing finite monotonic stats timestamp; its
DOMHighResTimeStamp-derived window is rounded before the one-to-five-second
bound is checked. Viewer C may wait pending, but the router advances the streak
only when that C has a hard receive predicate and B independently reports one
of the two hard sender predicates. Both inputs are WebRTC stats gathered by
stock browsers at separate endpoints; parent remote loss originates in RTCP.
This is cross-endpoint corroboration, not cryptographic independence or defense
against colluding authenticated participants. Raw stats, addresses, candidates,
SDP, URLs and a composite score remain out of wire.
The router may create the existing Viewer route intent;
`PeerRelayTopology.reassignViewer` and `MediaRouteController` continue to own
the subtree change, revision, generation, prepare, commit and rollback.

Targeted tests cover the revision controller, protocol authorization, relay
capacity and deterministic admission rescue, ordered break-before-make client
transitions, stale asynchronous work, server-restart
resynchronization, one-shot credential recovery, peer failback, and optional
standby warming. The corrected cold Chrome 151/LiveKit 1.13.5 localhost run took
1.481 seconds from failure report to active and 2.257 seconds to a new rendered
frame. With authenticated standby warming, the same physical-leaf/two-root
scenario took 200 ms to active and 319.7 ms to render while the host edge peak
remained two. Public transport/audio/load/browser checks remain pending. The
direction is accepted, while implementation migration and deployment
acceptance remain unverified.

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
- `refresh-sfu { revision }`;
- a controller-selected TURN grant for exactly one current edge; and
- a matching parent/child rebuild bound to the old and new connection identity.

Native v2 retains its strict STUN-only authenticated shape. Pinned LiveKit
embedded TURN remains participant-wide ICE configuration for a LiveKit
publisher or subscriber and is not the selected peer-edge grant.

The ordinary authenticated `iceConfig` contains only `iceServers` populated
from `STUN_URLS`. The rejected participant-wide tuple, issuer, capability,
refresh messages, and client propagation are removed, and stale
`PEER_ICE_TURN_*` keys fail startup. The selected-edge source slice atomically
adds its controller consumer and one-use rebuild; only that selected rebuild
may receive a short-lived relay-only configuration. No credential may enter a
URL, log, browser persistence, room data, or SQLite.

Authentication carries the current participant assignment and room revision,
plus the non-secret standby URL when fallback is configured. It never carries a
standby JWT. An authenticated snapshot is the sole authority allowed to replace
a higher client revision after the signaling server restarts; the client first
retires media owned by the old revision. Existing peer signaling keeps its
connection generation and assigned-edge authorization. The server
derives the failed edge from the authenticated session, active revision, and
connection ID instead of accepting a client-supplied parent or arbitrary reason.
Late, duplicate, or stale revision messages have no effect.
When the process flag is enabled, every normal room receives the hybrid snapshot
and its own controller state. A process with the flag disabled receives the
ordinary P2P snapshot. The distinction is process configuration, never a room
ID allowlist.

## Transition

1. Keep direct/peer UDP roots while those routes work.
2. A failed edge performs one ICE restart, one same-parent connection rebuild,
   and then one alternate eligible peer-parent attempt; it does not repeat an
   identical action three times. A short `disconnected` state first uses
   generation-bound bytes/stats evidence. After the Viewer successfully sends
   its answer, an initial `new` or `connecting` connection now has a separate,
   conservative 15-second hard deadline. `connected`, disposal, or replacement
   by a newer connection generation cancels it; expiry enters the existing
   staged recovery at one ICE restart. It does not reuse or change the existing
   three-second recovery deadline. The 15-second boundary is unit-tested
   but remains subject to mobile-network measurement. The peer connection is
   STUN-only throughout these attempts. When admission has no eligible peer path,
   or recovery is exhausted, select the SFU root plan. Stock LiveKit participant
   ICE remains a distinct domain.
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

6. Selected fallback roots explicitly subscribe. On their first new video
   track, they atomically replace their upstream stream, acknowledge active,
   and feed the existing downstream relay without rebuilding descendants.
7. A prepare timeout increments the revision and restores the unchanged active
   route. A failure after commit creates a new rollback/failure revision; stale
   acknowledgements cannot revive the abandoned plan.

8. An active Viewer SFU root may request one fresh short-lived grant. If its next
   failure, or the initial SFU prepare, is exhausted, the router grants at most
   one relay-only rebuild of that Viewer's original failed peer edge. A
   Host-to-SFU route may instead receive one `host-sfu-ingress` relay-only grant
   for an initial pending publication or an active route. The pending retry is
   bound to the exact revision, publication/share generations, expected Host
   session and a server-generated new connection ID. Prepare-ready consumes the
   attempt; retry failure reports that new ID and restores the unchanged peer
   baseline. Stop, session replacement, topology revision or a new sharing
   generation also clears it.

Production logs on 2026-08-20 observed two root participants for about 4.6
seconds and two short Host participants (about 0.46 and 0.27 seconds), all ending
with client-requested leave. Services did not restart and no track publication
was retained. That timing is consistent with the bounded fresh-grant retry and
Peer failback state machine, but the logs do not prove those transitions or the
publisher stage. The client now retains only a local enum
(`connect`, `source`, `video-publish`, `sender-config`, `audio-publish`, or
`transport`) for the current route revision and reports the failure as an event;
it never uploads the raw error, endpoint, token, candidate, or address.

An activated SFU-root route is sticky until a discrete route event requires a
change or the current share stops. A new sharing generation starts from the
cheapest available UDP route. The controller does not continuously rebalance
healthy media. The bounded quality candidate changes only the Viewer-rooted
subtree whose current parent-to-child edge produced three consecutive hard-bad
windows; it does not withdraw that parent's global relay capacity.

The authenticated standby is not a transport: it has no grant and never joins a
room. During route prepare the current implementation warms only an unpublishing/unsubscribed
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
connection ID and active revision. The resulting plan had two selected SFU
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
- unsupported route capability;
- a hard bounded-send-queue overflow on a future encoded-object route; or
- three consecutive, current-identity correlated Viewer C/parent B windows in
  which C has a hard receive predicate (freeze duration at least 50% of the
  sample window, positive received RTP with zero decoded frames, or at least
  100 received-plus-lost packets with loss at least 30%) and B independently
  reports `cpu`/`bandwidth` sender limitation or at least 100 sent packets with
  RTCP-reported remote loss divided by sent packets at least 30%.

It does not combine RTT, bitrate, geography, or a synthetic health score; the
exact sender-limitation enum is a predicate, not an encoder score. Either side
alone is diagnostic-only. C may be stored before B arrives, but only the hard
pair advances the streak. Healthy or ambiguous correlated windows clear it. A Viewer or parent session,
connection ID, route revision or parent identity change also resets it, as does
an evidence gap over five seconds. A successful peer reassignment or started
SFU prepare creates one 30-second room migration budget. Viewer/session churn
cannot bypass that budget; removal, disconnect, authorization or generation
change clears per-edge evidence and intent state, while room stop/delete clears
the room budget. A quality-created intent retains its Viewer/parent sessions,
connection, revision and parent guard through every drain, peer change, SFU
prepare and commit boundary. Pending SFU work also retains the exact originating
intent identity: missing, replaced or changed guards abort before grants or
commit, while a genuine `route-failed` may explicitly take over that same
intent as the ordinary failure owner. Stale work and successful peer migration
release only the quality-owned temporary parent exclusion; a real
`route-failed` exclusion remains owned by the failure path. The W3C stats
definitions establish the counter meanings and their WebRTC 1.0 example uses
30% loss as a likely culprit; they do not
prescribe Screener's route policy. Therefore 50%, 100 packets, three windows,
five seconds and 30 seconds are conservative candidate constants pending
production calibration, not claimed optimums. Measurements may change them
only through a reviewed change.
ADR-0007's `HIGH`/`FALLBACK` quality state is separate and does not become a
topology trigger or a room-wide health score.

`MAX_SFU_ROOTS_PER_ROOM` currently bounds server egress at one or two roots.
The target retains two as the normal distributed limit. If several exceptional
viewers cannot attach behind any healthy root, a later reviewed config may
admit additional direct server-fed edges under a separate explicit egress cap;
it never creates a third endpoint edge or unbounded whole-room fanout.

Sub-second failure recovery is a target after failure detection. The current
30-second control heartbeat cannot meet it for silent partitions, so the media
plane needs a small 100-200 ms liveness/queue signal or an equivalent native
transport event. This signal must be measured before its interval is fixed.

## Selected-Edge TURN After SFU

Healthy direct/peer UDP stays distributed. When no such path can satisfy
admission or recovery, one SFU publication feeds one or two roots, which keep
their bounded peer descendants. Only an edge that also cannot use SFU/UDP may
receive a controller-selected authenticated TURN attempt. Production currently
configures that selected-edge attempt but still ends in bounded failure if it
cannot connect. Source has no
participant-wide TURN path: the rejected candidate is removed and its stale
environment keys fail startup. The selected-edge implementation uses
a short coturn REST bearer and one server-generated connection identity per explicit
edge kind. `peer-selected` binds the failed parent/Viewer pair;
`host-sfu-ingress` binds the room, host session, SFU publication generation, and
the old/new connection identities. The Host client applies that grant only to a
relay-only LiveKit publisher `RTCConfiguration`, including during the initial
pending prepare. Pinned LiveKit client 2.22.0 accepts `rtcConfig` on
`Room.connect`; its engine clones that override before creating the publisher
PeerConnection and does not replace explicitly supplied ICE servers. This path
is configured in production but has no real relay-media evidence.
LiveKit participant-wide embedded/external TURN remains a separate ICE domain.

### Deferred Optimization

These items are not current runtime behavior:

- A room in which the Host and every possible root are restricted may require
  several server-fed exceptional edges. Any such extension requires a per-room
  selected-relay and central-egress admission cap; it must wait or fail at that
  cap rather than become unbounded server fanout. TURN/TCP and TURN/TLS remain
  separate transport decisions.
- ICE restart and connection rebuild already recover failed edges after Wi-Fi,
  cellular, or similar network changes. A healthy fallback path remains sticky:
  the current controller does not proactively move it back when a new Viewer
  offers a better peer route or the old network recovers. Any later preference
  migration must be triggered by a discrete event, observe cooldown, and move
  only the affected Viewer-rooted subtree.

The bounded cost model and privacy-safe ICE fields
live in [Low-Server-Cost Media Routes](../research/low-server-media-routes.md).
For one SFU publisher at bitrate `B_pub` and `R` roots at measured bitrates
`B_i`, host upload is `B_pub` and central ingress plus egress is
`B_pub + sum(B_i)`. If `E` separately admitted exceptional viewers receive
bitrate `B_exc,j`, SFU egress adds `sum(B_exc,j)`. Each selected TURN edge adds
its own measured ingress and egress; it is never multiplied across ordinary
peer PCs. Every host NIC, TURN ingress/egress, SFU ingress/egress, root NIC, and
exception NIC hop remains real traffic.

Migration is gated, not optional design debate. Production has entered a
historical shared-IP room-`1` smoke while the old release remains a separate
rollback instance. The same direct/peer UDP, SFU/UDP, selected relay edge, and
bounded failure gates apply to every room in the flagship process; the current
process never restores the old all-room TURN wire. The matrix covers CGNAT, double NAT, mobile hotspot,
ordinary home networks, root departure, reconnect, SFU unavailable, and rollback. It records
CPU seconds/GiB, NIC bytes/pps, RSS, host upload, p95/p99 forwarding latency,
loss/recovery, final quality, host edges at most two, SFU roots at most two, and
unchanged healthy subtrees. Every ordinary connection stays STUN-only; room
scope does not change that rule.

A peer root re-publishing its received stream to the SFU while also feeding
peer descendants remains a separate bounded candidate. The current browser
path would decode and re-encode, and it adds publication ownership and load;
it is not silently added to this migration. No composite score, continuous
optimizer, or geographic/UA inference is introduced.

## Security And Privacy

The standby URL is an origin, not a credential. LiveKit credentials remain
short-lived, room-bound, role-bound, and memory-only.
Only the host may publish screen tracks. Subscription permissions allow only
the current fallback-root identities, including any zero-descendant roots.
Ordinary SFU WebRTC transport encryption terminates at the SFU, so its operator
can access media. LiveKit supports application E2EE in which its server cannot
access media content, but signaling/API data remains visible and Screener has
not implemented the required key distribution. The comparison must record which
boundary is actually configured and the UI must not claim E2EE.

## Implementation Order

1. Reuse only the LiveKit dependencies, token issuance, deployment templates,
   and thin publisher/subscriber boundary developed in closed PR #12. Do not
   restore its mutually exclusive protocol or page branches.
2. Split publisher lifecycle into connect, activate, deactivate, and profile
   update; make subscriber connections selective and inactive until assigned.
3. Add versioned route state and pure invariant/property tests.
4. Implement server prepare/commit/abort and strict authorization.
5. Integrate host/viewer first-frame switching while retaining relay children.
6. Land the bounded selected-edge function before treating performance evidence
   as a prerequisite. Retain the tracked `1/3/5/8` benchmark and then extend it
   with peer/SFU UDP, one selected relay edge, bounded UDP-blocked failure,
   allocation/RSS/ports, relay bandwidth and server-egress measurements. Only after those pass,
   add the 20-viewer gate before changing
   the room default.

## Acceptance Gates

- Every non-server endpoint stays at or below two active downstream media edges
  across prepare, commit, rollback, reconnect, and stale-message sequences;
  current browser relays stay at one child until separately accepted.
- Only necessary roots or explicitly admitted exceptional viewers receive SFU
  media and the configured central egress budget is never exceeded.
- A reliable SFU root continues to serve bounded peer descendants. Normal
  central fanout stays at one or two roots; only multiple exceptional viewers
  that cannot attach to a healthy root may consume separately capped direct
  server edges.
- Prepare failure leaves the old active route unchanged.
- First new decodable picture arrives within one second after a route failure is
  detected in the reference regional network.
- Existing descendants, source selection, quality profile, pause, audio, and
  persistent-room stop/restart semantics survive the transition.
- No LiveKit configuration preserves the existing P2P/peer behavior and wire,
  but is not the final flagship deployment target.
- In a process with the controller flag disabled, ordinary rooms preserve the
  ordinary P2P route fields, directed signaling, quality rejection,
  stop/reconnect/delete semantics, and STUN-only ICE. With the flag enabled,
  every room gets isolated per-room peer/SFU state under the same limits. Native
  v2 and every ordinary peer PC remain STUN-only; only a current
  controller-selected exceptional edge may receive a short-lived TURN grant.
- LiveKit/SFU UDP must pass CGNAT, double-NAT, hotspot, home-network, loss,
  rollback, and SFU-unavailable gates. Blocked UDP fails clearly within a
  bounded window even when TURN/UDP is enabled. Media TCP remains a separate
  decision and TURN availability never becomes a quality claim.

## Consequences

Positive:

- Users do not select or understand a topology.
- Host fanout remains bounded while server media egress is paid only for
  fallback roots and separately admitted exceptional viewers.
- The ordinary peer path remains direct-first and STUN-only; current production
  has no TURN media cost, and a configured relay attempt is confined to one
  controller-selected exceptional edge after SFU/UDP.
- Revisioned prepare/commit isolates stale asynchronous results without a
  continuous optimizer.

Negative:

- Strict two-edge migration can include a bounded interruption.
- LiveKit becomes an operational dependency for the flagship target and can
  inspect ordinary SFU media.
- A configured peer-assisted client downloads/parses the current build's roughly
  137.5 kB gzip (531 kB minified) LiveKit chunk and sends one `HEAD` even if it
  never needs SFU, shifting that small one-time client/static-egress cost earlier.
  An unconfigured client pays neither cost.
- A media liveness signal and versioned cross-client transition expand the
  state space and require real failure-injection tests.
- A selected TURN edge adds relay ports, coturn memory, refresh traffic, and
  two media NIC legs; quotas and the 1-GiB host budget must be measured.

## Relationship To Existing ADRs

- This decision corrects the automatic-migration interpretation in ADR-0001;
  room `1` is historical smoke evidence, while the source controller is
  process-enabled for all normal rooms.
- ADR-0004 remains the bounded full-stream browser-relay experiment.
- This decision and merged PR #17 supersede ADR-0003/closed PR #12's
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
- [LiveKit client 2.22.0 connection options](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/options.ts)
- [LiveKit client 2.22.0 RTC configuration construction](https://github.com/livekit/client-sdk-js/blob/v2.22.0/src/room/RTCEngine.ts)
- [LiveKit JavaScript client usage](https://github.com/livekit/client-sdk-js#usage)
- [LiveKit end-to-end encryption](https://docs.livekit.io/transport/encryption/)
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit 1.13.5 configuration](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC](https://w3c.github.io/webrtc-pc/)
