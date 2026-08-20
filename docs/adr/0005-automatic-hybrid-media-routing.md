# ADR-0005: Automatic Hybrid Media Routing

- Status: Accepted Direction - Default-Off Migration Unverified
- Date: 2026-08-19

## Context

The product has always required route selection and recovery to be automatic
and invisible to the broadcaster and viewers. Earlier repository wording that
prohibited silent migration was an incorrect interpretation and is superseded
by this decision. Simplicity constrains the controller and user experience; it
does not require users to choose a media topology.

The ordered preference remains:

1. a direct-selected P2P edge, with standard ICE allowed to select authenticated
   TURN/UDP inside that same peer connection only in an explicit canary;
2. peer-assisted forwarding through an alternate eligible parent;
3. an SFU virtual parent supplied by the flagship deployment; and
4. bounded waiting or failure when no route can satisfy the budgets.

STUN is required. A complete default-off Peer ICE TURN tuple lets only capable
Web sessions in exact allowlisted rooms create peer connections with STUN plus
short-lived authenticated TURN/UDP and `iceTransportPolicy: "all"`. Standard
ICE type priority prefers direct candidates and can nominate relay without an
application route transition. Non-allowlisted rooms and clients without the
capability remain STUN-only. After peer recovery and alternate-parent options
are exhausted, the controller assigns one or two SFU roots. HTTPS/WSS remains
TLS/TCP and is outside this media policy. Every non-server endpoint has at most two active
downstream media edges; its upstream receive edge does not consume that upload
budget. The current browser relay remains stricter at one child until its
re-encode and resource gates pass.

TURN and SFU occupy different layers. A selected TURN candidate continuously
relays media for that ICE edge; it is not a handshake helper or a topology
decision. LiveKit TURN cannot rescue an unavailable SFU. Independent coturn may
transport an authorized participant's ordinary peer connection around a NAT
failure without changing the assigned peer topology. An SFU is a virtual topology parent and may feed only one
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
configuration. Optional Peer ICE TURN is a separate exact-room deployment
tuple and is never a topology choice.

## Implementation Status

Merged PR #17 implements this controller on top of merged PR #13, and PR #20
adds the bounded standby prewarm below. Production enables them only for
persistent room `1`; other rooms stay ordinary P2P, and production remains
STUN-only. The current source adds a default-off Peer ICE TURN canary but does
not deploy it or modify coturn.

The current runtime removes the old all-room coturn contract. Production
requires STUN and authenticated ICE snapshots contain only STUN servers. Source
now has a capability-gated optional TURN group plus expiry in `iceConfig`, and
strict `refresh-ice`/`ice-config` messages. They have no effect unless the new
complete tuple and exact-room allowlist both match. The tracked
LiveKit sample explicitly sets `tcp_port: 0`, disables TCP fallback, supplies
the deployment-owned STUN server, and configures no TURN service. The SFU controller still
activates only after a peer edge exhausts recovery. Public participant entry has
been observed, but retained media and route admission remain unverified. The old
`769de201f7cc` release and coturn relay are isolated rollback resources, not a
permanent compatibility branch or advertised current transport.

The repository also requires a strict, non-empty `PEER_ASSISTED_ROOM_IDS`
deployment allowlist whenever `PEER_ASSISTED_MEDIA=true`. Only exact listed room
IDs enter the controller or receive optional LiveKit standby, grants, or Peer
ICE TURN configuration. All other rooms retain the current ordinary P2P
authentication shape, STUN-only ICE, and signaling/quality/lifecycle behavior. Missing, blank, malformed, or duplicate
entries fail startup; there is no configuration state that enables all rooms. The boundary is a
temporary deployment-only validation gate with no browser selector, percentage
framework, or second router.

The implementation keeps the LiveKit dependency dormant unless the complete URL, API key,
and API secret tuple is present together with `PEER_ASSISTED_MEDIA=true`. It
issues short-lived room-, role-, peer-, and publication-generation-bound grants,
and only allowlisted branch roots may subscribe. A necessary viewer with no
descendants is still a root under the same authorization and total cap. The
server currently retries a failed edge through the deterministic peer topology;
only an exhausted peer route can request an SFU branch root. The target keeps
healthy routes sticky but may select SFU directly when admission has no eligible
peer path. Optional Peer ICE TURN is not controller-selected: a capable Web
participant in the exact canary receives a short-lived participant-session
bearer and every bounded peer PC uses the same `all` configuration. Coturn
validates HMAC and expiry, not room, edge, parent, revision, or connection
generation, and the holder may reuse the bearer until expiry. LiveKit
publisher/subscriber ICE remains a separate participant-wide domain.

Every viewer starts with zero relay capacity for each authenticated session. A
peer-assisted Web client explicitly advertises either zero or one downstream
edge; conservative UA-CH/user-agent detection reports mobile and iPad clients as
leaves and desktop-class browsers as one-child relays. The controller uses this
binary capability only for future admission and recovery. Withdrawing capacity
does not proactively migrate an otherwise healthy existing edge.

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
capacity, ordered client transitions, stale asynchronous work, server-restart
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
- optional Web authentication capability `peerIceTurn: true`;
- `refresh-ice {}` from the current capable authenticated session; and
- `ice-config { iceConfig }` with the replacement short-lived config.

Native v2 does not advertise the optional capability and therefore retains its
strict STUN-only authenticated shape; the server never sends it `ice-config`.
Pinned LiveKit embedded TURN remains participant-wide ICE configuration for a
LiveKit publisher or subscriber and is not the ordinary Peer ICE bearer.

The ordinary authenticated `iceConfig` contains `iceServers` populated from
`STUN_URLS`. Only an opted-in exact-room Web session receives one additional
TURN group and `turnCredentialsExpiresAt`. Its signaling client is the sole
refresh-timer owner, requests two minutes early, and updates existing PCs with
`setConfiguration()` without proactively restarting them. The server reuses
the current in-memory session grant until that window, then rotates it. A
signaling reconnect obtains a new participant-session bearer. No credential is
placed in URL, log, browser persistence, room data, or SQLite.

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
   but remains subject to mobile-network measurement. In an enabled exact-room
   canary, the peer connection has already gathered
   direct and relay candidates and standard ICE may select relay during these
   attempts. When admission has no eligible peer path, or recovery is exhausted,
   select the SFU root plan. Stock LiveKit participant ICE remains a distinct
   domain.
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

## Built-In Peer ICE TURN And SFU Migration

The accepted product direction supersedes the earlier dual-TURN shadow
candidate as the preferred central comparison. Healthy direct/peer UDP stays
distributed. When no such path can satisfy admission or recovery, one SFU
publication feeds one or two roots, which keep their bounded peer descendants.
Production still ends in bounded failure and has no TURN config. Current source
adds the default-off exact-room built-in Peer ICE tuple and wire described
above. It is participant-session bearer issuance, not assignment-level coturn
enforcement. LiveKit participant-wide embedded/external TURN is likewise not
configured by current production and remains a separate ICE domain.

The bounded cost model, privacy-safe ICE fields, and exact-room A/B sequence
live in [Low-Server-Cost Media Routes](../research/low-server-media-routes.md).
For the normal-root baseline with no exceptional server-fed viewer, one equal
representation of bitrate `B` and `R` roots gives TURN seed host upload `R*B`
and central ingress plus egress `2R*B`; one SFU publisher gives host upload `B`
and central ingress plus egress `(R+1)*B`. Mixed representations use measured
`B_pub` and `sum(B_i)`. If `E` separately admitted exceptional viewers receive
bitrate `B_exc,j`, SFU egress adds `sum(B_exc,j)`; every TURN leg additionally
adds its own ingress and egress. Every host NIC, TURN ingress/egress, SFU
ingress/egress, root NIC, and exception NIC hop remains real traffic.

Migration is gated, not optional design debate. Production has entered a
shared-IP exact-room smoke while the old release remains a separate rollback
instance. Room `1` must still verify direct-selected peer, relay-selected peer,
SFU/UDP, and bounded failure with all UDP blocked; the current process never
restores the old all-room TURN wire. The matrix covers CGNAT, double NAT, mobile hotspot,
ordinary home networks, root departure, reconnect, SFU unavailable, and rollback. It records
CPU seconds/GiB, NIC bytes/pps, RSS, host upload, p95/p99 forwarding latency,
loss/recovery, final quality, host edges at most two, SFU roots at most two, and
unchanged healthy subtrees. Non-allowlisted and capability-absent sessions stay
STUN-only; only after that gate may the controller broaden beyond room `1`.

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
not implemented the required key distribution. The exact-room comparison must
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
6. Extend the tracked `1/3/5/8` benchmark with automatic fallback, peer/SFU UDP,
   bounded UDP-blocked failure, source/profile/pause/stop, and server-egress
   measurements; separately measure idle TURN allocation/RSS/ports and selected
   relay bandwidth. Only after those pass, add the 20-viewer gate before changing
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
- In one process, non-allowlisted rooms preserve ordinary P2P route fields,
  directed signaling, quality rejection, stop/reconnect/delete semantics, and
  remain isolated from allowlisted peer/SFU state and receive STUN-only ICE.
  Capability-absent clients, including Native v2, also remain STUN-only. Only a
  capable session in an allowlisted room may receive TURN credentials and expiry.
- LiveKit/SFU UDP must pass CGNAT, double-NAT, hotspot, home-network, loss,
  rollback, and SFU-unavailable gates. Blocked UDP fails clearly within a
  bounded window even when TURN/UDP is enabled. Media TCP remains a separate
  decision and TURN availability never becomes a quality claim.

## Consequences

Positive:

- Users do not select or understand a topology.
- Host fanout remains bounded while server media egress is paid only for
  fallback roots and separately admitted exceptional viewers.
- The ordinary peer path remains direct-first under standard ICE; current
  production has no TURN media cost, and source confines the optional relay
  candidate to an exact-room capability gate.
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
- Enabling built-in Peer ICE TURN creates unselected allocations for configured
  peer connections; relay ports, coturn memory, refresh traffic, quotas, and any
  selected media bandwidth must be measured on the 1-GiB host.

## Relationship To Existing ADRs

- This decision corrects the automatic-migration interpretation in ADR-0001;
  production now runs its exact-room smoke while broad rollout remains gated.
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
- [LiveKit JavaScript client usage](https://github.com/livekit/client-sdk-js#usage)
- [LiveKit end-to-end encryption](https://docs.livekit.io/transport/encryption/)
- [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [WebRTC transports, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit 1.13.5 configuration](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml)
- [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC](https://w3c.github.io/webrtc-pc/)
