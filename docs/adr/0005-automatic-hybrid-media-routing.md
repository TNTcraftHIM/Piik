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
this media policy. The current release policy gives the Host at most two active
downstream physical media edges and an ordinary Browser Viewer at most one; an
upstream receive edge does not consume that upload budget. Active and
provisional peer children, selected-edge overlays, and the Host SFU publication
all count. The server derives the effective limit from the authenticated role,
so an old or malicious Viewer advertising two or three cannot bypass one. A
deployment may tighten Host/Viewer below `2/1`, but cannot raise either limit.
There is no UA or visibility policy.

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

Eligible parent relationships form a mesh-like candidate graph, but active
media remains a loop-free graph with one upstream per Viewer. Join, capacity,
disconnect, and current-edge failure are bounded reselection triggers. A
transition may overlap old and prepared edges only within the existing edge
budgets and must commit from current-generation media proof; steady multi-source
striping is not part of the media path.

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
configures the tuple. A bounded exact-Web-source canary against the production
LiveKit/coturn tuple proves the active Host/SFU relay route; initial Host ingress
and `peer-selected` relay media remain open.
The wire has two explicit edge kinds: `peer-selected` for the last-mile failed
peer edge and `host-sfu-ingress` for a restricted Host-to-SFU retry. Ordinary
Peer ICE remains STUN-only. Each room admits at most one `peer-selected` lease
across its negotiating and answered states; `host-sfu-ingress` is an independent
source transport attempt and does not consume that last-mile admission slot. A
negotiating lease is a selected-edge migration attempt. After answer it becomes
the exact edge's long-lived active transport authority, not a room-wide
migration lock.

The current runtime removes the old all-room coturn contract. Production
requires STUN and authenticated ICE snapshots contain only STUN servers in
production. The tracked LiveKit sample explicitly sets `tcp_port: 0`, disables
TCP fallback, supplies
the deployment-owned STUN server, and configures no TURN service. The SFU controller still
activates only after a peer edge exhausts recovery. Public participant entry has
been observed, but public-room retained media and route admission remain unverified. The old
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
fails. The authorization binds the room/share generation, viewer and parent
sessions, grant revision, and replaced/new connection identities. After answer,
the signed grant revision stays immutable while the controller tracks the current
route revision separately. An unrelated route revision may carry the exact edge
only while its sessions, topology, share generation, and parent downstream
budget remain current; carry authority must precede the active route update.
Stale, replayed, participant-wide, over-budget, or unselected attempts fail closed. Coturn still
validates only HMAC and expiry, so application generation checks, short TTL,
one-use state, fanout, and quotas bound the bearer. LiveKit publisher/subscriber
ICE remains a separate participant-wide domain.

Every viewer starts with zero relay capacity for each authenticated session.
The current Browser client advertises one downstream edge. The unchanged wire
continues to parse `0 | 1 | 2 | 3` only as a future capability envelope; it is
not current route authority. The controller clamps all Browser Viewer
advertisements to one before topology assignment, including old-client values
two and three. `MAX_PEER_RELAY_DOWNSTREAM_EDGES` defaults to two and accepts one
or two as a deployment tightening input: effective Host capacity is
`min(config, 2)` and effective Browser Viewer capacity is `min(config, 1)`.
Withdrawing capacity does not proactively migrate an otherwise healthy existing
edge. There is no UA-, device-, or visibility-based branch.

The source now implements one narrow admission exception to sticky assignment.
On an active peer-only route with no SFU publication or pending prepare, a
connected, childless Viewer that has no upstream or failed-parent history and
advertises relay capacity may replace the oldest connected, childless,
zero-capacity Host child when both Host slots are full. That leaf becomes one
child of the new relay. The synchronous change preserves Host fanout at two and
Browser Viewer fanout at one, advances one route revision, and clears
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
only when B independently reports one of the two hard sender predicates and C
is either severe or relatively degraded. Severe remains freeze, zero decode,
or high loss. Relative degradation applies only below a Viewer relay parent:
the parent's own most recent C must already be correlated, current for its
session, route and connection, no older than five seconds, and the child's FPS
must be below two-thirds of that actual inbound FPS. It never compares C with
the room's configured FPS ceiling. Both inputs are WebRTC stats gathered by
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
standby warming. The 2026-08-22 `gate:sfu-root-invariants` preflight hard-checks
that controller state and token allowlists accept no more than two central
roots, one active Host SFU publication consumes one of the Host's two outbound
media edges, and a committed zero-descendant root remains selected across
reauthentication. A separate client transition check keeps its active subscriber
when a newer same-kind assignment still has no children. The benchmark evaluator
also rejects a third root or third Host media edge. This in-process evidence
starts neither LiveKit nor a browser and therefore proves no packet flow,
bandwidth adaptation, or resource cost. Chrome 151/LiveKit 1.13.5 localhost runs
established route
transition, resumed decoding, and the two-edge bound. Their elapsed times are
diagnostics only and do not satisfy the regional recovery target. Public
transport/audio/load/browser checks remain pending. The direction is accepted,
while implementation migration and deployment acceptance remain unverified.

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
The Web execution layer independently truncates each received assignment to
the current Host-two or Viewer-one physical-child limit before creating peer
connections. This is defense in depth for a regressed or mismatched server;
the wire's future capacity envelope is not client execution permission.

Minimal protocol additions:

- optional `sfuStandbyUrl` in a peer-assisted authenticated snapshot, only when
  the server has complete LiveKit fallback configuration;
- `relay-capacity { downstreamEdges: 0 | 1 | 2 | 3 }` from an authenticated
  peer-assisted viewer; the range is a future wire envelope while current
  server policy clamps an ordinary Browser Viewer to one;
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
   The Viewer recovery control follows the authoritative active route: a peer
   edge requests the existing peer recovery, while an SFU assignment restarts
   Screener signaling so reauthentication reasserts the same route and the
   existing authoritative resync rebuilds the subscriber from fresh config. It
   neither reports a connection as healthy nor directly requests SFU-to-peer
   migration.
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
windows. One confirmed child remains edge-local. Two distinct confirmed
children under the same Viewer parent session and share generation within five
seconds temporarily make that parent relay-ineligible (effective capacity zero)
for 30 seconds; its advertised capacity is unchanged. The triggering edge still
follows its own intent through one peer-to-peer make-before-break attempt.
Severe and relative-FPS quality evidence do not enter SFU or TURN; a real
`route-failed` remains the separate owner of the ordinary failure ladder.

The authenticated standby is not a transport: it has no grant and never joins a
room. During route prepare the current implementation warms only an unpublishing/unsubscribed
transport. Its media transition remains break-before-make: the host releases the
replaced peer or SFU media edge before activating the new one. The accepted
one-root healthy SFU probe and the peer-quality slice below are explicit bounded
exceptions: they retain old media until current-generation receive/decode proof.

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
  which B reports `cpu`/`bandwidth` sender limitation or at least 100 sent
  packets with RTCP-reported remote loss divided by sent packets at least 30%,
  and C either has the existing severe freeze/zero-decode/high-loss predicate
  or, below a Viewer relay parent, receives less than two-thirds of that
  parent's fresh correlated inbound FPS.

It does not combine RTT, bitrate, geography, or a synthetic health score; the
exact sender-limitation enum is a predicate, not an encoder score. Either side
alone is diagnostic-only. C may be stored before B arrives, but only one
unchanged severe or relative pair advances its own streak. Healthy or ambiguous
correlated windows clear it. A Viewer or parent session,
connection ID, route revision or parent identity change also resets it, as does
an evidence gap over five seconds. Severe and relative-FPS evidence each open at
most one peer-to-peer make-before-break attempt. The candidate is a Viewer whose
active upstream is peer or SFU, whose session/share/revision are current, and
whose effective relay capacity has one strict spare slot; Host remains excluded.
The candidate parent holds one provisional child `HostPeer` outside its active
child IDs/map. The old active edge and its connection ID remain authoritative
while the candidate uses a separate exact identity. The Viewer sends prepare-ready only after positive current-candidate
RTP and decoded-frame progress plus a live video track; only then does the server
commit the planned topology and promote the same provisional PC plus candidate
connection ID. A failure after prepare-ready retains that exact identity across
repeated matching active updates, where the candidate parent stays fail-closed
without originating `route-failed`; the target Viewer's probe owns recovery.
Rollback clears the identity. An unrelated authoritative route failure first
aborts the soft probe and then immediately resumes its ordinary ladder. Failure,
timeout, stale identity, or no eligible peer keeps the old active edge and does
not start SFU, TURN, an error, or another migration. A started attempt creates
one 30-second room migration budget. Viewer/session churn
cannot bypass that budget; removal, disconnect, authorization or generation
change clears per-edge evidence and intent state, while room stop/delete clears
the room budget. A quality-created intent retains its Viewer/parent sessions,
connection, revision and parent guard through prepare and commit. A successful
relative-FPS move holds its
old parent for 30 seconds, or until that parent session changes, to avoid a soft
bounce. A real `route-failed` is stronger evidence: it releases that soft hold,
hard-excludes the current failed parent and may immediately reuse the old
playable parent. Other successful quality moves release their temporary
exclusion. This slice migrates only the triggering child; make-before-break for
other children of a quarantined relay remains separate. The W3C stats
definitions establish the counter meanings and their WebRTC 1.0 example uses
30% loss as a likely culprit; they do not
prescribe Screener's route policy. Therefore 50%, two-thirds FPS, 100 packets,
three windows, five seconds and 30 seconds are conservative candidate constants pending
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
is configured in production, and its active Host-ingress relay function is now
proven; the initial-ingress and `peer-selected` variants remain open.
LiveKit participant-wide embedded/external TURN remains a separate ICE domain.

On 2026-08-21 the standalone `gate:turn-udp-allocation` check issued a credential
through the production parser/issuer and received one UDP relay candidate. That
check proves UDP allocation only, not media, recovery, quality, or performance.
One subsequent bounded Chrome 151 canary ran the exact deployed Web source in a local
Screener room against the production LiveKit/coturn tuple. A temporary DEV-only
hook forced the active SFU publisher to fail once and was removed afterward. The
application then issued `host-sfu-ingress`, connected a relay-policy publisher
whose only ICE server was TURN, selected a succeeded/nominated pair with
`relayProtocol=udp`, sent video bytes and frames, and kept Viewer decode/render
counters advancing. Ordinary peer PCs remained STUN-only, Host outbound media
edges peaked at one, and explicit stop returned them to zero. This proves the
active functional transition only; it is not latency, quality, capacity, expiry,
mobile, or resource evidence. Chrome reported `candidateType=prflx` for the same
local candidate; the standards-bounded interpretation and raw-counter summary
are retained in the linked research rather than normalized away.

### Deferred Optimization And Deployment Boundary

Current deployment status is explicit:

- A room in which the Host and every possible root are restricted may require
  several server-fed exceptional edges. Any such extension requires a per-room
  selected-relay and central-egress admission cap; it must wait or fail at that
  cap rather than become unbounded server fanout.
- Bounded healthy SFU-to-peer reselection is accepted below. The one-root slice
  and its existing baseline parent are deployed in exact `6ccb516a`; browser,
  media, and production-route evidence remain unverified. Relay-capacity
  transition `0 -> 1` and multi-root healthy reselection are not implemented.

#### Bounded Healthy SFU Reselection

Production release `6634cb9` was observed on 2026-08-21 to retain an SFU route
after network recovery or a short page refresh. A same-tab refresh retains the
room-scoped `clientId`, while the five-second disconnect grace retains peer and
route identity, so reauthentication legitimately receives the sticky SFU
assignment. Grace expiry removes that root and lets a later join start from the
peer baseline.

Healthy reselection is event-driven and room-bounded. It must not poll
`navigator.connection`, run a periodic route score, or globally rebalance a
healthy room. Only these discrete events open one opportunity:

1. An active SFU root receives an authoritative SFU assignment on a new
   signaling session or reports LiveKit recovery, followed by two bounded stats
   windows with positive current-generation RTP and decoded-frame progress.
2. A connected Viewer advertises relay capacity transitioning from zero to one.

One room owns at most one soft peer migration attempt. A healthy or quality
probe and a negotiating `peer-selected` lease are serialized. An answered exact
edge lease is active transport and may coexist with an unrelated soft migration;
each route change first revalidates its share, endpoint sessions, topology and
parent downstream budget, then sends the carry grant before active route
authority. A soft probe may overlap active media only when `Host peer children +
active SFU publication + probe <= 2` and `browser relay children + probe <= 1`.
Without a free slot the opportunity is consumed and the active route is left
unchanged. The probe is bound to the current share/publication, active and
pending revisions, root, parent and Host sessions, and one pinned connection
ID. Signaling from any other pair or generation fails closed.

During prepare the Viewer keeps rendering SFU while the existing peer parent
creates one provisional edge. ICE `connected` is insufficient. The Viewer
requires a live video track, positive inbound RTP and positive decoded frames,
then revalidates all of that immediately before promotion. The controller
commits that root/subtree atomically and retires SFU only after proof. A probe
failure sent before commit aborts without adding failed-parent state; if the
proven edge fails after server commit, the existing active-edge recovery path
runs rather than leaving server and Viewer on different routes.

Timeout, stale generation, participant/session replacement, room stop or
deletion aborts the provisional route. Abort keeps the active SFU assignment
and descendants, deletes the provisional connection identity, and does not
consume an ordinary route-failure intent. The Viewer disposes the provisional
peer connection and buffered signals before accepting rollback. Active-SFU loss
first aborts the probe instead of being swallowed. If the active Viewer
subscriber or Host publisher reports a real pending-revision `prepare`
failure, only the exact current SFU owner may abort. Ordinary transport uses a
null connection; selected Host ingress must match its activated connection
identity. The rollback active revision then drives the existing one-refresh
recovery. Success and abort share the room's 30-second migration cooldown.
If one otherwise-current healthy event arrives during that cooldown, the room
retains only the latest root/session/revision/share/publication tuple. At the
cooldown boundary it reasserts the same authoritative SFU assignment only when
that tuple and the one-root topology are still current. The Viewer must then
produce two new positive RTP/decoded-frame windows before sending another
ready event; the pre-cooldown proof never authorizes a delayed peer probe.

The implemented source slice deliberately handles exactly one active SFU root
and only its parent retained in the deterministic peer baseline. The accepted
capacity `0 -> 1` trigger and deterministic selection among multiple SFU roots
remain follow-ups. No periodic polling trigger, global score, new dependency,
ordinary-peer TURN grant, or second route controller was added. The single
cooldown-bound timer above is an event continuation and is cleared on session,
room-stop, or room-delete changes; a changed route or generation discards it at
the boundary.

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
   as a prerequisite. Retain `gate:peer-topology-loopback` for decoded-media,
   route-consistency, and two-edge correctness only. Collect peer/SFU UDP,
   selected-edge, bounded UDP-blocked failure, resource, bandwidth, egress, and
   recovery performance on representative target devices or production-like
   networks. Only after those pass, add the 20-viewer gate before changing the
   room default.

## Acceptance Gates

- Across prepare, commit, rollback, reconnect, reauthentication, reconciliation,
  and stale-message sequences, Host physical media edges stay at or below
  `min(config, 2)` and ordinary Browser Viewer edges stay at or below
  `min(config, 1)`. Host SFU publication and provisional/selected overlays count;
  upstream receive does not. Config and client advertisements cannot raise the
  release limits.
- Only necessary roots or explicitly admitted exceptional viewers receive SFU
  media and the configured central egress budget is never exceeded.
- A reliable SFU root continues to serve bounded peer descendants. Normal
  central fanout stays at one or two roots; only multiple exceptional viewers
  that cannot attach to a healthy root may consume separately capped direct
  server edges.
- Prepare failure leaves the old active route unchanged.
- First new decodable picture arrives within one second after a route failure is
  detected in the reference regional network. Localhost loopback timing is not
  a pass/fail substitute for this target.
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
  bounded window even when TURN/UDP is enabled; media does not fall back to TCP.
  TURN availability never becomes a quality claim.

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
