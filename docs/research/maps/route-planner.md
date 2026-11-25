# Map: delivery-tree planning and the connections it needs

Branch `refactor/claude-review`, HEAD `a0dd6ea6` (code last changed for
routing at `6c37f924`, "preserve recoverable paths and adopt proved spare
branches"). Read-only map. Labels: **code** (read in the source, path:line),
**doc** (a document claims it), **measured** (a recorded measurement),
**derived** (arithmetic or a constructed example I worked through by hand from
the code; not executed).

## Summary of the mechanism as a whole

Two owners plan, on two different graphs.

1. **The room plans trees** (`prototype/channel-core/src/routes.rs`,
   `publication.rs`, `room.rs`). On every room dispatch (twice per dispatch:
   before and after the action, `host.rs:1863` and `host.rs:1988`) each
   publication rebuilds a child→parent map over the room's view of the
   *confirmed* channel pairs (`neighbors`), the set of eligible forwarders
   (`relays`), per-node output limits (`RelayLimits`) and App display helpers.
   It first keeps every complete incumbent path, then attaches waiting
   receivers with a breadth-first search seeded at the source **and at every
   placed node with a usable path**, so it minimises the number of *new
   edges*, not hops from the source; depth only breaks ties (by seed order).
   Alternatives (unplaced relays that could take two receivers; a
   degree-ordered fill) are compared by the tuple
   (coverage, coverage in request order, −edges, −summed depth). Moves of a
   viewer already placed happen only through one bounded operation per
   publication: `Prepare` (prove one new edge), `Switch` (one-time shortcut to
   the source; App-helper insertion; and, since `6c37f924`, an alternate
   parent when the viewer reports its input disconnected) and `Reduce` (move
   one child of a parent above its limit). Each has a 20 s deadline.
2. **The room tells the channel what it is missing** in two ways: every
   subscription *requests* the direct source–receiver pair (`host.rs:451-501`),
   and a publication whose receivers cannot be reached on confirmed arcs with
   free capacity emits a **delivery frontier**: the reachable prefix, the
   unreached set, and every missing arc from prefix to unreached that the tree
   would accept (`routes.rs:493-608`).
3. **The channel admits physical attempts** (`channel/discovery.rs`,
   `connectivity.rs`, `transport.rs`). Per room it keeps the direct pairs,
   keeps a sparse standby skeleton (DFS tree, low-link back edges, ring
   neighbours across gaps), and for a waiting receiver whose direct pair failed
   (or is confirmed but capacity-blocked) chooses **one trial pair**: first the
   room frontier's best crossing, else its own connectivity search
   (`repair_candidate`), else an old failure to retry (`retry_candidate`); a
   pair that worked before the failure is restored with top priority. It also
   proposes one pair per room protecting demand against an articulation point
   (`ordinary`). Admission is capped at 4 attempts per channel, 2 per endpoint,
   64 pairs per endpoint, 20 s per attempt, 5 s cooldown after a failure.
4. **Depth never prompts a pair attempt.** A placed viewer generates no
   frontier and no trial; the only pair requested on its behalf is the direct
   pair to the source (once per socket generation), which feeds the one-time
   shortcut. Every tie between candidate pairs is broken by UUID order.

The four behaviours the Offline Placement Study measured trace to: (a)
`append_path` seeding (`routes.rs:452-460`) plus the tuple order putting −edges
before −depth (`routes.rs:353-358`); (b) the same seeding plus standby pairs
chosen by UUID ring order and the pool releasing confirmed pairs no interest
keeps (`transport.rs:268-288`); (c) `detach` dropping the whole subtree and
`extend_confirmed` re-placing each orphan individually with no later pass;
(d) `shortcut_candidates`/`direct_attempted` (`routes.rs:901-945`,
`publication.rs:499-524`). Details and line numbers below.

---

## 1. Inputs: the graph the planner sees

**code** `room.rs:1415-1649` (`reconcile_with_pairs`), per room dispatch:

- `readable` = sessions with room Read; `peers` = readable ∩ `can_use_peer_transport`.
- `routable` = peers, minus the transit service unless selected/active/reading
  (`room.rs:1496-1503`), minus the Hosted writer (`room.rs:1504-1506`), plus the
  selected service.
- `connected` = routable sessions whose `endpoint.connected` (signaling).
- `neighbors` = undirected adjacency from `HostInput.confirmed_pairs`, both ends
  in `connected` (`room.rs:1516-1522`). `confirmed_pairs` comes from
  `TransportBook::confirmed_pairs` (`transport.rs:767-778`): a pair whose two
  `confirmed_by` sockets equal both sessions' current signaling connections.
- `relays` = `new_relays ∪ active`, ∩ routable (`room.rs:1523-1528`), from
  `relay_sessions` (`room.rs:567-595`): `active` = forwarding participants
  (voice members, watchers, publishers, file demand, watch-byte pairs) +
  Lightweight writer + selected service; `candidates` = active + readers,
  minus Hosted writer, filtered to effective capacity > 0. Note `active` is
  **not** filtered by capacity ("Active participants can finish a bounded
  handoff after lowering their limit", comment `room.rs:565-566`).
  Frontiers use `new_relays` only (`room.rs:1628`); placement uses `relays`.
- `limits` = `RelayLimits { fallback: selected service, default: room
  relay_capacity, overrides: per-session relay_capacity }` (`room.rs:440-456`).
  For a screen: `source_direct_limit` = the share's direct limit, and
  `shared[sender]` = receivers of *other* screens' relay flows in this room
  from that sender, excluding the source's own outputs (`room.rs:1562-1615`,
  `room.rs:1632-1636`). Voice gets no `shared` entries.
- `helpers` = viewer → App helper for this screen (`room.rs:1572-1583`).
- `subscribers` = sessions whose `subscriptions()` contain the publication;
  voice members subscribe to every other speaker's voice (`room.rs:1371-1388`).
- `down` = `disconnected_pairs`: directed (reporter, peer) for a pair whose
  reporter currently says ICE is disconnected on its current socket
  (`transport.rs:753-766`, copied in `host.rs:1832-1834`).

## 2. Placement of a new viewer (and of every unplaced receiver)

Entry points: `Plan::activity_parents` (media, `routes.rs:186-212`) and the
free function `activity_parents` (bytes, `routes.rs:62-83`); both call
`select_activity_paths` (`routes.rs:214-273`) → `extend_confirmed`
(`routes.rs:317-440`) → `append_path` (`routes.rs:442-491`).

Inputs: source `s`; incumbent `selected` (child→parent); `order` (media:
`watch_order` = subscription order, then remaining receivers by UUID; bytes:
receivers by UUID); `neighbors N`; `relays R`; `helpers H`; `limits L`;
`failed_parents F` (child → {refused parent → physical edge}); `live_input`
(media: node has readiness; bytes: always true). Output: new child→parent map.

```
select_activity_paths:
  P := empty plan, F copied
  # (1) keep complete incumbent paths, receivers in `order`      routes.rs:223-254
  for r in order:
    c := r; branch := []
    while c != s:
      p := selected[c] or break
      break if len(branch) >= len(selected)                     # cycle guard
            or (p != s and p ∉ R)                               # parent no longer a forwarder
            or p is a display leaf (H[p] == selected[p])
            or not ( {p,c} ∈ N or (live_input(r) and live_input(c)) )
            or p ∈ F[c]
            or not admitted_output_P(p, c)                      # counted on P built so far
      branch += (c→p); c := p
    if c == s: P.parents += branch
  # (2) extend; the service (fallback) only for receivers participants cannot reach
  if L.fallback ∈ R:                                             routes.rs:259-266
      A := P; A.extend_confirmed(R \ {fallback}); A.extend_confirmed(R)
  P.extend_confirmed(R)
  return A if served(A) >= served(P) else P                      routes.rs:268-272

extend_confirmed:                                               routes.rs:317-440
  W := order filtered to: unplaced, has ≥1 entry in N, != s
  rank(T) := ( #W served,
               [served(w) for w in W]           # lexicographic, request order
               -|parents(T)|,                   # all edges incl. transit
               -Σ depth(w) over served w in W )
  best := fill(P, W)          # append_path for each w in W order
  if every w got parent s: return best          # "direct inputs" early exit
  for relay in R (UUID order), relay != s, unplaced, not a display leaf, has N entry:
      lim := L.get(relay, s); skip if 0
      free := lim − |shared[relay]|
      V := waiting neighbours of relay, not refused by relay, taking free slots
           (receivers already in shared[relay] take none)
      skip unless |V| + [relay ∈ W] >= 2
      T := P; require T.append_path(relay) and relay not display
      for v in V: T[v] := relay if unset          # no admitted_output re-check
      fill(T, W); if rank(T) > rank(best): best := T   (strict)
  if coverage(best) < |W|:
      W' := W sorted by (deg_N(w) <= 1, deg_N(w))  # interior first, leaves last
      T := fill(P, W'); if rank(T) > rank(best): best := T
  P.parents := best.parents

append_path(target):                                            routes.rs:442-491
  if placed(target): true
  queue := [s] + [u in subtree(s) level order, u != s,
                  if rooted_ready(u) or confirmed_path(u)]       # ALL seeds at distance 0
  visited := queue
  BFS: pop u; skip expanding u if (u != s and u ∉ R) or u is a display leaf
       or u was reached over its helper edge (terminal)
       for c in N[u] (UUID order):
         skip if placed(c) or not allowed_branch(u,c) or visited(c)
         prev[c] := u; if c == target: install chain; return true
         push c
  false
```

**Objective, as the code realises it** (code): coverage; then coverage in
request order; then fewest total edges; then least summed depth of the newly
served. The doc formula (`channel-forwarding-plan.md:480-494`) states the same
tuple. Inside one `append_path`, BFS distance counts *added edges*: the source
and every usable placed node start at distance 0, so a one-new-edge attachment
at depth 6 beats a two-new-edge attachment at depth 2.

**Tie-breaks, in order** (code):
1. Among one-new-edge parents: queue order = source first, then
   `subtree(s)` level order (children of one parent by child UUID, sibling
   groups in their parents' order) (`routes.rs:455-460`, `routes.rs:919-932`).
   Effectively "shallowest seed that neighbours the target and has a free
   output", ties by tree order.
2. Among multi-edge chains: BFS over `N[u]` in UUID order.
3. Among candidate trees: the earlier candidate (strict `>`): fill in order,
   then relay candidates in UUID order, then the degree-ordered fill.
4. Service: participants first; joint tree only if it serves strictly more
   (`served(first) >= served(self)` keeps the participants-first tree on a tie).

Doc vs code: ADR-0018 says "Today a viewer is placed by fewest hops"
(`adr/0018:12`) and the topology note says "Fewest hops, ties by session
identifier" (`topology-improvement-design.md:135`). The code minimises added
edges with all placed nodes as zero-cost seeds; "fewest hops from the source"
is true only among one-new-edge parents, and the tie is by tree order, not
session identifier.

**Cost** (code + derived). `append_path` is one BFS, O(V+E), but each arc test
calls `admitted_output` → `output_count`, which scans all parents (O(V)), and
seeding calls `subtree` (O(V·|parents|)) and `rooted_ready`/`confirmed_path`
(O(depth)) per node: O((V+E)·V + V²·depth) per call. Calls per pass:
m (fill) + k(m+1) (relay candidates) + m (degree fill) = 2m + k(m+1), as the
doc says (`channel-forwarding-plan.md:521-523`); with a selected service,
`select_activity_paths` runs `extend_confirmed` up to three times
(`routes.rs:263-267`), which the doc does not count. Measured planning time:
6.6–183 µs per cold plan on 20-endpoint fixtures (`network-lab.md:418-421`).

**Tests that say what it is for** (code): `confirmed_routes_on_five_nodes_match_simple_path_bounds`
(limit 1, all 1,024 five-node graphs; asserts never above the longest simple
path and no unserved neighbour of the free tail; prints the optimal count)
`routes.rs:1323-1406`; `shared_relays_are_compared_after_remaining_viewers_join`
`routes.rs:1428-1456`; `confirmed_chain_reuses_a_publishers_edge_to_the_only_leaf`
`routes.rs:1297-1321`; `the_fallback_takes_a_scarce_source_slot_when_that_serves_more_receivers`
`routes.rs:1498-1515`; `waiting_screen_reuses_confirmed_chain_without_disturbing_other_viewers`
`routes.rs:1407-1427`.

## 3. Rebuild on every reconcile, and what is kept

`Publication::reconcile_observed` (`publication.rs:229-525`), steps in order
(code):

```
 1 watch_order ∩= requested                                         :240
 2 expire(now)  (operation deadline; see §6)                         :241
 3 plan.retain_refusals(N): forget a refusal once its physical pair
   left the confirmed set ("a replacement may carry new media")      :242, routes.rs:826-833
 4 failed_receivers ∩= requested; transit_helpers kept while still a
   parent, plus current helpers; R' := R ∪ transit_helpers           :243-254
 5 detach every child c with ({p,c} ∉ N and c unproved)
   or (p != s and p ∉ R' and not a helper edge)                      :276-290
 6 if op = Switch whose root leg lost its incumbent (replaces = None):
     valid?  → placement demand := requested − leg receivers + leg senders
               (not s, not themselves legs); relays := R' − leg receivers;
               limits := L + each leg sender→receiver reserved in `shared`
     invalid → op := None                                            :291-338
 7 if capacity_children(H, L) is empty: parents := activity_parents(...)   :343-352
   (placement is SKIPPED while any parent exceeds its limit)
 8 for each helper (viewer→App): through_relay; apply directly when all
   arcs confirmed and every changed receiver is unproved              :353-372
 9 prune parents to nodes on a path of a demand receiver              :373-383
10 reconcile_leases: a receiver whose (sender, input) changed gets a new
   Flow id and loses readiness                                        :384, :661-669
11 recovery switch still current → return                            :385
12 op = Reduce → prepare_reduction → return                          :386-394
13 capacity_children non-empty → op := None; prepare_reduction; return :395-401
14 paused → return
15 op current? (Prepare: its flow still preparing; Switch: kind-specific
   validity, all legs confirmed, viewing flags match) current Switch → return;
   not current → op := None                                           :405-442
16 not a screen, or source not connected → return                    :443-445
17 op none: for root in watch_order: alternate(root) → Switch          :446-469
18 assisted helper Switch (overwrites a current Prepare)              :470-487
19 op exists → return
20 first preparing edge → Prepare                                     :491-498
21 shortcut: first eligible root → Switch{helper: None}, mark attempted :499-524
```

Kept from the previous tree: every complete incumbent path whose arcs are
still confirmed (or both ends proved), whose parents are still forwarders, not
refused, and within limits in receiver order; readiness for unchanged leases;
`failed_parents` (pruned in step 3 and by the 5 s repair wake, §5);
`direct_attempted`; `watch_order`; the single operation. Not kept: any broken
path (the whole subtree below the break is detached), and any unproved child
whose pair left the confirmed set.

## 4. Repair: a departed or failed parent's children

Triggers and their effect on the plan (code):

| Event | Code | Effect |
| --- | --- | --- |
| Media failure reported on a selected lease | `publication.rs:984-988`, `routes.rs:970-982` | `fail_delivery` (screen: whole subtree marked failed), `reject_parent(child, parent)`, `detach(child)` (subtree) |
| Physical pair failed (channel → `HostInput.failed_pairs`) | `host.rs:1846-1852`, `room.rs:1716-1723`, `publication.rs:790-850`, `routes.rs:984-996` | refusals on that edge forgotten; child detached; a Reduce whose legs used the pair keeps its deadline with empty legs; a Switch whose legs used the pair is dropped; any other Switch survives if every leg's input is the source, another leg, or a still-placed lease (legs whose receiver lost its parent get `replaces := None`), else it is dropped |
| Parent left the room / no longer routable or forwarder | `publication.rs:276-290` | detach child (no rejection) |
| Prepare expiry (20 s) | `publication.rs:743-754` | `fail_delivery`, `plan.failed(parent, child)` |
| Reduce expiry (20 s) | `publication.rs:730-736` | `fail_delivery(root)`, `plan.failed(parent, root)` |
| Temporary ICE disconnection of the viewer's own input | `publication.rs:255-275`, `:446-469` | alternate Switch (§6), not a detach |

```
detach(child):  remove child and every descendant from parents and ready   routes.rs:998-1009
next reconcile: orphans are ordinary waiting receivers; step 7 places them one
  by one in watch_order, by append_path (fewest added edges, shallowest seed).
  A descendant can land back under its old parent if that parent is re-placed
  first and the pair is still confirmed; it still gets a new lease and must
  prove again (step 10).
```

Retry of refused parents (code): `needs_repair` (`routes.rs:873-885`) holds
when the source is connected, some requested connected child is unplaced, and
some unplaced connected child has a connected refused parent. The room then
sets `repair_at = now + REQUIRED_REPAIR_MS (5 000)` once (`get_or_insert`, not
extended, `room.rs:1643-1648`); when due, `retry_required` clears those
refusals (`routes.rs:887-899`) and byte `failed_data_pairs` are cleared
(`room.rs:1535-1536`). Nothing bounds how many times this repeats.

Nothing re-optimises orphans later: after re-placement the only voluntary move
is the shortcut, which a re-placed viewer may already have spent (§6).

Tests: `relay_failure_retires_descendants_only_and_does_not_mutate_another_source`
(`routes.rs:1645-1664`), `required_repair_retains_a_healthy_relays_failed_shortcut`
(`routes.rs:1696-1740`), `exhausted_old_parents_do_not_block_a_new_ready_candidate`
(`routes.rs:1785-1805`), `view_toggles_do_not_retry_a_failed_parent`
(`routes.rs:1686-1694`). Measured (`network-lab.md:423-430`, at `b079e283`,
limit 1, 1,024 five-node graphs): after each of 2,127 relay removals routing
reached the maximum obtainable while keeping the healthy part; rebuilding the
whole path could serve one more viewer in 194 cases, each needing a change to a
healthy viewer's path.

## 5. Capacity: how it is counted and what lowering does

**Room-level count** (code `routes.rs:723-760`):

```
limit(v)        = source_direct_limit or default    if v == source   (source's own override ignored)
                = overrides[v] or default           otherwise        routes.rs:28-33
output_count(p) = |shared[p]| + #{children c of p in this tree : H[c] != p and c ∉ shared[p]}
admitted_output(p, c) = H[c] == p                       # helper edge: always admitted
                     or (limit(p) > 0 and (c ∈ shared[p] or output_count(p excluding c) < limit(p)))
capacity_children   = every child c with H[c] != p and not admitted_output(p, c)   routes.rs:843-856
```

Because the test excludes the child itself, *every* child of an over-full
parent is listed, not only the excess (derived from `:739` and `:851-852`).
`wan_outputs` (`routes.rs:693-707`) is the same count without `shared`, used
only for the source in `can_shortcut`.

Per kind (code): screens share each forwarder's capacity across the room's
screens via `shared`; a source's own outputs are per publication. Voice gets
`limits` without `shared`, so each speaker's tree may use a relay's full limit
(`room.rs:1596-1615`). Files: author's holder uses `default`, another holder
its override or default (`file_room.rs:44-50`).

**Runtime count across rooms** (code `forwarding.rs:79-251`): per kind, the set
of distinct downstream peers of third-party outputs (`input_flow_id.is_some()`
and not a presentation edge; files when not the author's own original) in one
snapshot. With a personal limit L, admitted = previously admitted first, then
new, in (kind, peer UUID) order, up to L per kind (`forwarding.rs:229-251`).
Refused media flows are reported to the room as `FlowState::Failed`
(`forwarding.rs:205-214`), which the room treats as a media failure (§4).
Auto (`None`) admits all. Capacity updates go to each room as `RelayCapacity`
(`forwarding.rs:37-76`).

**Lowering a limit** (code):
- Room default, a session's room override, or a share's direct limit:
  `capacity_children` becomes non-empty → placement is skipped (step 7) →
  `prepare_reduction` (`publication.rs:554-647`): for each excess child in
  child-UUID order (a retained root first), `candidate_parent(root)` over the
  root's confirmed neighbours that are source/relays; the first root with a
  candidate gets `Reduce{root, legs}` (deadline 20 s, kept across
  re-preparation of the same root). No candidate → `Reduce` with empty legs →
  on expiry the root and its subtree are failed and detached. One child per
  operation; repeated until no excess.
- Personal limit: the runtime refuses excess flows at once (no handoff); the
  room also receives the lower override.
- Off (0): the session leaves `new_relays` (no new outputs, no frontiers) but
  stays in `active` (`room.rs:587-593`), so existing outputs go through Reduce.
- `bound_screen_preparation` (`publication.rs:179-201`): cancels the
  operation if any sender, counting leases + legs + shared, would exceed its
  limit while a candidate is unselected.
- Bytes: no Reduce; `activity_parents` keeps incumbent branches in receiver
  UUID order until the limit and drops the rest immediately (derived from
  `routes.rs:244` with `live_input = true`).

Tests: `room_default_reduction_converges_through_the_room_host`
(`tests/base_routes.rs:3122`), `one_screen_reduces_two_decoded_outputs_while_another_stays_selected`
(`tests/base_routes/coexisting_demand.rs:69`), `reader_relay_reserves_capacity_across_publications_before_proof`
(`tests/base_routes.rs:5261`), `personal_limits_apply_only_to_relays` (`routes.rs:1457-1476`).

## 6. Operations that move a watching viewer

`Publication.operation: Option<RouteOperation>` (`publication.rs:21`): at most
one per publication, each with `deadline = now + SCREEN_PREPARE_MS (20 000)`.

| Operation | Trigger (code) | Target parent | Commit | Failure / expiry |
| --- | --- | --- | --- | --- |
| `Prepare{flow}` | no op; some unproved edge whose parent is source or proved; first in child-UUID order (`publication.rs:491-498`, `routes.rs:962-968`) | n/a (watches one edge) | flow proved → not current → cleared | expiry: subtree failed, `plan.failed` (`:743-754`) |
| `Switch{helper: None}` shortcut | no op; `shortcut_candidates` first root (nodes with children first, then level order) with `can_shortcut`, direct pair confirmed, not in `direct_attempted`, whole subtree connected and its viewers Decoded (`:499-524`, `routes.rs:901-945`) | source; `can_shortcut` requires source `wan_outputs < limit` and source not refused | every leg proved; viewing legs whose incumbent is Decoded need a presentation report < 5 s old (`:79-87`, `:852-883`) | expiry: nothing rejected; root stays in `direct_attempted` |
| `Switch{helper: Some(h)}` assisted | `helpers` has viewer→h and `through_relay` gives confirmed legs (`:470-487`) | App helper h | as above | expiry: `reject_parent(root, h)` (`:737-741`) |
| `Switch{helper: Some(p)}` alternate (new in `6c37f924`) | no op; root in `watch_order`, root has no helper, `(root, old) ∈ down` (`:255-275`, `:446-469`) | `candidate_parent_where`: proved ancestry with no down edge, p != old, source or relay, pair confirmed and not down, free output; min by (is service, depth, not current) | same, but a leg whose old path is down or lost needs only Decoded (`:860-875`) | expiry: `reject_parent(root, p)`; if the old input recovers first, `alternate` is None → not current → cleared without rejection |
| `Reduce{root}` | parent over limit (`:386-401`, `:554-647`) | `candidate_parent` among root's confirmed source/relay neighbours | all legs proved (`:906-940`) | leg failure: `reject_path`, legs cleared, deadline kept; expiry: root failed and detached |

What prevents two moves from undoing each other (code): one operation at a
time; incumbent paths are never re-chosen by placement (§2 step 1); a shortcut
is attempted once per (publication, viewer) (`direct_attempted`, cleared only
by `retain_sessions` when the session stops being routable or by
`reset_routes`/source change, `publication.rs:105-118`); a Switch with a
helper/alternate parent that expires rejects that parent; Reduce runs only over
the limit and shortcut only under it; alternate runs only while the viewer's
own input is down. I found no explicit rule against Reduce moving a child that
a later repair then re-places under the same over-full parent; the limit check
in `admitted_output` prevents re-placement above the limit.

Deadlines and expiries (all code):

| Name | Value | Where | Scope |
| --- | --- | --- | --- |
| `SCREEN_PREPARE_MS` | 20 000 ms | `publication.rs:9` | Prepare, Switch, Reduce; not extended by reconcile; Reduce keeps it across re-preparation of the same root (`:608-610`) |
| `QUALITY_EVIDENCE_MS` | 5 000 ms | `publication.rs:11` | freshness of a viewing leg's presentation report when the incumbent is Decoded and still up |
| `REQUIRED_REPAIR_MS` | 5 000 ms | `room.rs:20` | room repair wake: clears refusals of unplaced viewers, clears byte failed data pairs |
| `DISCOVERY_TIMEOUT_MS` | 20 000 ms | `transport.rs:32` | one physical pair attempt (renewed on coordinated UDP preparation, `transport.rs:782-796`) |
| `REQUIRED_RETRY_MS` | 5 000 ms | `transport.rs:33` | cooldown after a pair failure or attempt expiry |

Tests: `selected_input_disconnection_prepares_alternate_branch` (seven orderings,
`tests/base_routes.rs:5976-6171`), `prepared_branch_survives_host_turns_and_ancestor_retirement`
(`:5783`), `prepared_branch_waits_for_downstream_transport` (`:6173-6323`),
`demand_probes_one_shortcut_over_a_working_relay` (`:4324-4474`),
`source_fanout_then_ready_subscriber_relay_and_sticky_healthy_edges` (`routes.rs:1628-1643`).

## 7. When the planner asks for a pair that does not exist

### 7.1 What the room publishes (code)

1. **Requested pairs** (`host.rs:451-501`): for each authorized view and each
   subscription to an unpaused publication, the pair (source, upstream
   receiver) with `waiting = not selected`; plus (helper, viewer) never
   waiting; plus (file/watch source, receiver) waiting while it has no
   upstream. Every subscriber requests its direct pair, whatever its depth.
2. **Delivery frontiers** (`routes.rs:493-608`; media via
   `Publication::collect_frontiers`, receivers replaced by their helpers,
   `publication.rs:212-227`; bytes via `byte_frontiers` with refusals and
   failed data pairs as refused parents, `routes.rs:610-638`):

```
delivery_frontiers(receivers):
  return if N empty
  return if tree empty and no refusals and no helpers and source limit > 0
            and every relay has a free output                 # "ordinary channel gap repair serves that case"
  waiting := receivers − placed − {s};  return if empty
  allowed(a,b) := a != b, b != s, a ∈ {s} ∪ R, b unplaced or parent(b) == a, allowed_branch(a,b)
  BFS from s over allowed confirmed arcs; reached waiting removed;
      before := reached forwarders (BFS tree, helper arcs not expanded)
  return if waiting empty
  after := waiting ∪ (R − before)                             # sorted
  suffix  := bitmap of allowed confirmed arcs inside `after` (helper arcs → `terminal`)
  bridges := bitmap of allowed NOT-confirmed arcs before → after (helper arcs → `terminal_bridges`)
  emit {source, waiting, before, after, suffix, terminal, bridges, terminal_bridges} if any bridge
```

   Projection keeps only `waiting` ids whose requested pair is waiting
   (`room.rs:413-418`). Wire: UUIDs become one sorted table and u8 indices;
   more than `MAX_SESSIONS` (128) ids is a serialisation error
   (`host.rs:271-373`). `within_domain_frame` (`host.rs:624-664`) binary-searches
   the largest prefix of frontiers that fits `CHANNEL_MESSAGE_BYTES` (4 MiB) and
   drops the rest silently.

### 7.2 What the channel does with it (code, `discovery.rs:657-784`)

Per bound room with an online host, with `scope` = projected sessions ∩ online:

```
standby(online, all confirmed, Channel)        # channel skeleton
standby(scope, scope-confirmed, Room)          # room skeleton
retain_direct: confirmed requested pairs kept (Delivery if waiting else Activity)
repair(...):                                    discovery.rs:434-628
  suggestions := room_suggestions(...)          discovery.rs:370-433
  for (pair=(s,v), waiting) in requested:
    eligible := scope ∩ ({s,v} ∪ relay_session_ids); links := confirmed ∩ eligible²
    if waiting: RESTORE: among failures ∪ pending that were previously confirmed,
        retry_candidate(...) → required_retries, keep Activity, completion if it bridges
    direct not rejected and not a "confirmed gap" (confirmed direct + room frontier for it):
        if direct unconfirmed: keep direct (Activity), completion(direct, ∅) if waiting
        continue                                # confirmed direct, no frontier: nothing
    not waiting: continue                       # a placed viewer gets nothing more
    # waiting with direct rejected, or direct confirmed but the room still has a frontier
    if suggestion edge already confirmed: keep its path as Delivery; continue
    trial := suggestion if not rejected
          else repair_candidate(eligible, links, {(s,v)})
          else min-by-retry_after(retry_candidate(old failures), suggestion)
    keep trial (Activity); rejected trial → required_retries
    trial == suggestion → advised; completion(trial, prefix ∪ suffix)
    else protect the confirmed path pieces toward the trial; completion if it bridges both sides
  if anything advised: keep every scope-confirmed pair as Recovering (temporary)
ordinary(scope, graph, remaining demand): one connectivity candidate (+1 alternative if the first is rejected)
```

`room_suggestions` (code): targets = frontier waiting receivers whose
requested pair is waiting and whose direct pair is confirmed or rejected.
Crossings = bridges with both ends in scope, current sockets, not an existing
non-pending unconfirmed pair, and a `confirmed_prefix` back to the source in
the channel's confirmed set. Rank = (not confirmed, not pending, retry_after
(None first), endpoint pair). Up to 2 crossings are kept per entering node;
per target the best crossing whose entering node reaches the target over the
confirmed suffix (`tail`, from-nodes must be in `relay_session_ids`) and is not
the direct pair. One suggestion per (source, target).

`finish_admission` (code `discovery.rs:109-184`): runs inside admission after
Restoration and Completion candidates. For each advised key whose preferred
trial was not admitted, it tries every other crossing of that room's frontiers
for the same (source, target) in rank order through `try_completion` (cooldown
respected, Completion or Restoration rank, prefix protected) and stops at the
first admitted. Then `finish_completions` releases temporary Recovering pairs
that no admitted completion protects (`transport.rs:483-501`).

### 7.3 Admission: how many, in what order, what stops it (code `transport.rs:216-416`, `535-653`)

- Rank order: Restoration (required retry of a previously confirmed pair) <
  Completion (has a confirmed prefix ready) < Activity < Room < Channel; then
  `retry_after` (None first, then oldest); then endpoint-pair order
  (`transport.rs:356-373`).
- Limits: `CHANNEL_ATTEMPT_LIMIT` 4 pending per channel, `ENDPOINT_ATTEMPT_LIMIT`
  2 per endpoint, `PAIR_DEGREE_LIMIT` 64 pending+established per endpoint
  (service: `MAX_SESSIONS − 1` = 127, `discovery.rs:748-754`); only one
  standby (≤ Room) attempt pending at a time (`transport.rs:295-307`).
  Admission may reclaim unprotected, unleased, lower-interest attempts or pairs
  (`transport.rs:547-636`).
- A rejected edge is not requested again unless it is in `required_retries`
  and its 5 s cooldown passed (`transport.rs:260-267`). Failure records are
  kept only while some requested pair's allowed endpoints or an interest
  still involves them (`discovery.rs:449-456`, `:726-728`).
- Stops: confirmation (pair becomes a neighbour; the room places the receiver,
  so it stops waiting and its frontier disappears); demand ends; or capacity
  waiting (not a failure).

### 7.4 The present rule: depth alone never prompts an attempt

Code that makes it so:
- Frontiers are built only for receivers absent from `parents`
  (`routes.rs:518-525`); a placed viewer at any depth produces none.
- `room_suggestions` takes only targets whose requested pair is waiting
  (`discovery.rs:386-392`), and `waiting = !selected` (`host.rs:481`).
- `repair` does nothing more for a non-waiting pair than keep/attempt the
  direct pair (`discovery.rs:515-528`).
- The direct (source, viewer) pair is requested for every subscriber
  (`host.rs:478-482`): one attempt per socket generation; a failure is retried
  only while the viewer waits (`required_retries` are set only on the waiting
  paths, `discovery.rs:471-506`, `:584-586`). Its only use for a placed viewer
  is the one-time shortcut (§6).
- `ordinary` (`discovery.rs:630-654`) scores demand pairs by articulation
  points (`separating_cuts`), not depth; for a placed viewer it re-proposes its
  direct pair if a cut vertex separates it from the source, then one
  alternative.
- No code proposes a pair between a placed viewer and a shallower non-source
  relay with a free output.

## 8. Frontier versus the channel-side searches

| | Room frontier + `room_suggestions` | `repair_candidate` (`select`, expand) | `retry_candidate` | `ordinary` (`select`, no expand) |
| --- | --- | --- | --- | --- |
| Where | `routes.rs:493-608`, `discovery.rs:370-433`, `:109-184` | `connectivity.rs:57-64`, `98-191` | `connectivity.rs:66-96` | `discovery.rs:630-654`, `connectivity.rs:48-55` |
| Input | the room's tree, refusals, limits incl. shared reservations, helpers, room-confirmed arcs; channel confirmed set and transport state for ranking | eligible sessions, eligible confirmed links (undirected), the one demand pair, an availability predicate (not linked, not rejected, no non-pending pair) | eligible sessions, links, the demand pair, failure records with `retry_after` (and for restoration only those `previously_confirmed`) | scope sessions, scope-confirmed links, all remaining demand pairs, availability (no pair or pending) |
| Output | one missing pair per waiting target, plus ordered alternatives | one pair | one previously failed pair | one pair (+ one alternative) |
| Knows | direction, capacity, refusals, App display edges, which nodes are reachable in the tree | undirected connectivity only; components and cut vertices | components; failure age | components, cut vertices |
| Runs when | a receiver is waiting and its direct pair is rejected, or confirmed but the room still emits a frontier | waiting, direct rejected or confirmed-gap, and no fresh suggestion | (a) waiting: restore previously confirmed; (b) fallback when the above give nothing | every channel reconcile, on demand not consumed by `repair` |
| Can add | exactly one missing arc whose prefix and suffix are already confirmed | a pair across the source/receiver gap (max benefit, ties by UUID index); if none, a pair from either side to a third component (expansion) | a failed pair that is the direct or joins the source's or receiver's component to another | the demand pair itself, else a pair across a gap or around a cut vertex |

### Small graphs (derived by hand from the code; not run)

**A. The frontier finds a pair the channel search does not.** Nodes S
(source, direct limit 1), A, B (relays and viewers, limit 1), V (viewer).
Confirmed: S–A, A–B, S–V. Tree: S→A→B, proved. V subscribes; S–V is confirmed
but S is full.
- Placement: seeds S, A, B; S–V refused by capacity; no other arc to V →
  V waits.
- Frontier: before = {S, A, B}; only allowed missing arc into V is B→V (S
  and A full) → suggestion B–V.
- Channel: `repair` reaches the search only because a frontier exists
  (`confirmed_gap`, `discovery.rs:509-515`); `repair_candidate` on links
  {S–A, A–B, S–V} returns nothing: the demand pair is already linked, S and V
  are adjacent so no cut vertex separates them, and they share a component
  (`connectivity.rs:116-190`). Without the frontier no pair is attempted for V.
- Variant without S–V confirmed and S–V rejected: `repair_candidate` scores
  A–V and B–V equally (benefit 1) and returns the lower UUID pair; if A < B it
  proposes A–V, which cannot serve V because A is full. The frontier proposes
  only B–V.

**B. The channel finds a pair the frontier cannot.**
- B1, empty tree (cold start): S, R (room reader, relay), V. Confirmed: S–R.
  S–V failed. Tree empty, no refusals, free outputs → `delivery_frontiers`
  returns before building anything (`routes.rs:507-517`). `repair_candidate`:
  components {S, R}, {V}; S–V rejected; R–V has benefit 1 → R–V. Covered by
  `cold_screen_direct_failure_discovers_a_room_reader_before_media_failure`
  (`tests/pool_coldstart.rs:485-551`, zero confirmed pairs: the reader is
  connected to both sides one pair at a time).
- B2, two missing pairs: S, A (placed viewer), X (relay with no pairs), V.
  Confirmed: S–A. S–V and A–V rejected. Frontier: before {S, A}, after {V, X};
  tail(V) = {V} because X–V is not confirmed; the only non-direct crossing into
  V is A–V (rejected), so the suggestion is not fresh; crossings into X are
  unusable for target V. `repair_candidate`: no available pair between {S, A}
  and {V}; expansion returns the first available pair (UUID order) with one
  end in {S, A, V} and the other X (`connectivity.rs:170-190`). The frontier
  never proposes an arc between two unreached nodes (V–X).

**C. Transport history.** S, A, X, Y (relays), V. The path was S→A→X→Y→V,
all confirmed; an outage broke A–X and X–Y (both `was_confirmed`). Now
confirmed: S–A, Y–V; V waiting.
- Frontier: before {S, A}; after {V, X, Y}; tail(V) = {V, Y}. Crossings it can
  use: S–Y, A–Y, A–V (never-tried pairs ranked by endpoint order). X–Y lies
  inside `after` and is never a bridge; A–X enters X, which is not in tail(V).
- Restoration: `retry_candidate` over previously confirmed failures; components
  {S, A}, {X}, {Y, V}; A–X touches the source side, X–Y the receiver side; the
  older `retry_after` is chosen and ranked Restoration, ahead of every
  Completion (`discovery.rs:471-506`, `transport.rs:358-363`). The room cannot
  know `was_confirmed` (`transport.rs:153-161`).

**Verdict on the audit answer** (C10, `.agents/handoff/to-claude.md` at
`d9770d0d`): both claims hold in the code. "A room frontier can have no usable
crossing": cases B1 (no frontier by design), B2 (only rejected or suffix-less
crossings), plus a frontier dropped by the frame limit or by the projection's
waiting filter, or a prefix not yet confirmed in the channel's view
(`confirmed_prefix`, `discovery.rs:196-212`). "Re-establishing an observed pair
also uses transport history": case C. Conversely, the channel search is never
consulted when a fresh suggestion exists, and never for a capacity-blocked
viewer without a frontier (A), so the overlap is narrow: a frontier exists,
its best crossing is rejected, and a channel candidate exists.

## 9. Invariants the code relies on

| Invariant | Enforced or assumed |
| --- | --- |
| One operation per publication | Enforced by type (`Option<RouteOperation>`, `publication.rs:21`). Overwritten without expiry by the assisted Switch when a Prepare is current (`:470-487`). |
| Each receiver has one parent; trees are acyclic and rooted | Map type for one parent; acyclicity by the walk-to-source in the incumbent pass (`routes.rs:226-253`) and by BFS construction; `through_relay` checks cycles (`routes.rs:793-803`); `adopt_branch` inserts legs without a check (`routes.rs:955-960`), relying on legs computed from checked maps. |
| The source has no parent | Assumed: BFS never revisits it (`visited` seeded with s); `through_relay` test asserts it (`routes.rs:1591-1594`). |
| A relay must itself be placed | Enforced: only seeds/source/relays are expanded in BFS (`routes.rs:463-469`); relay candidates must `append_path(relay)` (`routes.rs:411-415`); `through_relay` places a helper first (`routes.rs:782-786`); frontier bridges only from `before`; pruning keeps only nodes on demand paths (`publication.rs:373-383`); leases are built from the source down (`publication.rs:671-698`). |
| A helper edge is exempt from fan-out | Enforced separately at each counting site: `admitted_output` (`routes.rs:730-732`), `output_count` (`:756`), `wan_outputs` (`:704`), `relay_flows` (`publication.rs:203-210`), the room's shared reservation loop (`room.rs:1563-1566`, `!flow.presentation`), runtime budget (`forwarding.rs:111`, `:164`), frontier terminal arcs (`routes.rs:566-571`). Six sites, one meaning. |
| A display leaf never forwards | Enforced in BFS (`routes.rs:464`), relay candidates (`:376`, `:412`), incumbent pass (`:232-234`), `candidate_parent_where` (`:668`), `through_relay` (`:806`). |
| Capacity never exceeded by a move | Placement and Reduce check `admitted_output`; recovery switch checks `capacity_children` on the proposed tree (`publication.rs:312`); `through_relay` allows max(old count, limit) (`routes.rs:805-811`); shortcut checks source room at trigger and each reconcile (`can_shortcut`), not at commit (`commit_ready_switch` has no capacity test, `:852-883`). |
| A proof belongs to its flow generation | `mark_ready` requires the current parent (`routes.rs:858-871`); `reconcile_leases` drops readiness on a new Flow id; `current_switch` compares `replaces` with current leases (`publication.rs:706-719`). |
| Placement only on confirmed arcs | Enforced for new arcs (`append_path` iterates `N`); incumbent arcs may be kept off the confirmed set when both ends are proved (media) or always (bytes, `live_input = true`, `routes.rs:82`). |

## 10. Voice and files: shared and different

| | Screen | Voice | File / watch bytes |
| --- | --- | --- | --- |
| Planner | `Plan` via `Publication` | same `Publication` code | `ByteTree` → free `activity_parents` (same `select_activity_paths`) |
| Incumbent kept off confirmed set | when both ends proved | when both ends proved | always (`live_input = true`) |
| Capacity sharing across activities in the room | `shared` from other screens | none (per speaker tree) | none |
| Source limit | share's direct limit or room default | room default | author: default; other holder: override or default (`file_room.rs:44-50`) |
| Relays | `new_relays ∪ active` | same | `new_relays` only (`room.rs:1534`) |
| Prepare / Switch / alternate / shortcut | yes | no (return at `publication.rs:443-445`) | no |
| Reduce | yes | yes (runs before the screen-only return) | no; excess dropped at once |
| Delivery failure memory | `failed_receivers` | no (`fail_delivery` is screen-only, `:156-160`) | refusals in `ByteTree.refused` |
| Frontiers | yes | yes | yes (`byte_frontiers`, failed data pairs as refusals) |
| Source choice | fixed | fixed | current holder first, then holders by UUID, first that serves anyone (`file_room.rs:180-222`) |

## 11. Known-hard problems and the heuristics in place

1. **Maximum coverage with every limit 1.** Code comment and doc:
   a feasible tree is a simple path; full coverage is Hamiltonian path
   (`routes.rs:1325`, `channel-forwarding-plan.md:525-538`). What the code
   does: greedy fill in request order, unplaced-relay-first candidates, an
   interior-first fill; no exact solver; the unit test checks only an upper
   bound and a local "free tail" condition (`routes.rs:1388-1404`). Measured:
   1,005 → 1,012 of 1,024 five-node graphs optimal (`network-lab.md:390-413`).
2. **Maximum coverage, then least summed depth, under out-degree bounds with
   non-receiving relays** = degree-constrained directed Steiner arborescence
   (doc cites directed Steiner trees, `channel-forwarding-plan.md:536-538`).
   Code: the same greedy; depth is the last tie-break.
3. **Least maximum depth under degree bounds** = degree-bounded minimum
   diameter / depth spanning tree (NP-complete, see §12). Code: not an
   objective at all.
4. **Choosing which unknown pair to test** = shortest path with expensive,
   uncertain edge evaluation (doc cites LazySP, `:446-460`). Code: one trial
   per waiting receiver, ranked by (confirmed, pending, never failed, oldest
   failure, UUID).
5. **Standby skeleton and protection** = connectivity augmentation /
   2-vertex-connectivity (doc cites Eswaran–Tarjan, `:377-388`). Code: keep
   DFS tree edges and low-link back edges, ring neighbours across gaps or cut
   vertices (`connectivity.rs:6-44`); one augmenting pair per room per
   reconcile chosen by a benefit count (`connectivity.rs:135-169`).
6. **Which child to move when a limit falls** = a degree-constrained
   re-assignment. Code: lowest-UUID child that has a feasible parent; runtime
   budget: lowest peer UUID among new peers.

## 12. Primary sources and what they would predict for 4–32 nodes, bound 2

Derived reference values (complete graph, every node may send to 2, all nodes
receivers): the shallowest tree fills levels of 2, 4, 8, ...; maximum depth
⌈log₂(N+2)⌉ − 1 = 2, 3, 4, 5 and mean depth 1.5, 2.0, 2.625, 3.375 for N = 4,
8, 16, 32. On sparser confirmed-pair graphs these are lower bounds only.
(The study's columns average snapshot maxima over varying populations, so
they are not directly comparable with these numbers.)

| Source | Establishes | Checkable prediction / recommendation for 4–32 nodes, bound 2 |
| --- | --- | --- |
| Shi, Turner, Waldvogel, NOSSDAV 2001, <https://netfuture.ch/wp-content/uploads/2001/shi01dimensioning.pdf> | Theorem 1: minimum-diameter degree-bounded spanning tree is NP-complete for 2 ≤ dmax(v) < \|V\|−1 (TSP path at dmax = 2). Heuristic: Prim-like, add the node whose longest path is smallest, parent = the spare-degree node that minimises it; warns that leaves can consume the last spare degree and recommends deferring such leaves. | No polynomial exact method is expected, but exhaustive search at ≤ 33 nodes is what the placement study already ran. The heuristic attaches each node where it is *shallowest*, not where it adds fewest edges. Their leaf-deferral matches the code's interior-first fill. |
| Könemann, Levin, Sinha, Algorithmica 41 (2005), <https://doi.org/10.1007/s00453-004-1121-2> | O(√(log_B n))-approximation for the degree-bounded minimum-diameter spanning tree on complete weighted graphs. | At n ≤ 33, √(log₂ 33) ≈ 2.3 (arithmetic): the guarantee is loose at this size; exact search is cheaper than relying on it. |
| Ravi, FOCS 1994, <https://ieeexplore.ieee.org/document/365693/> | Minimum broadcast time (each informed node sends to one neighbour per step) is NP-complete; minimum poise (max degree + diameter) is NP-hard; O(log²n/log log n) approximation. | If "time to first picture" is modelled as one new receiver per sender per step, the same hardness applies. |
| Chu, Rao, Seshan, Zhang (Narada, mesh-first), IEEE JSAC 2002, <https://www.cs.cmu.edu/~srini/papers/papers/2002-Chu-jsac/2002-Chu-jsac.pdf> | Build a mesh first (fanout range 3–6 in simulation), then per-source shortest-path trees on it; members probe at random and add links by a utility gain, drop links whose consensus cost is below a threshold; partitions detected by sequence-number timeouts and repaired by probing. | Recommends keeping a small redundant mesh of real links and deriving each source's tree from it, with continual add/drop by measured utility; predicts the tree is only as good as the mesh's links. |
| Jannotti et al. (Overcast, tree-first), OSDI 2000, <https://www.usenix.org/legacy/events/osdi2000/full_papers/jannotti/jannotti_html/> | New node placed "as far away from the root as possible without sacrificing bandwidth"; 10% tolerance; ties by fewest network hops; periodic reevaluation among siblings, parent, grandparent; on parent loss, move under the grandparent. Authors: deep trees acceptable only because Overcast "is not intended for interactive applications", and mention a fixed maximum depth for buffering. | For interactive screens the same authors' logic recommends bounding depth; predicts grandparent rejoin as the default repair. |
| Zhang, Jamin, Zhang (HMTP, tree-first), INFOCOM 2002, <https://www2.cs.arizona.edu/~bzhang/paper/02-infocom-hmcast.pdf> | Join: closest among a probed subset under a degree limit; repair: orphans start from the grandparent after a random delay; improvement: periodically re-run join from a random node on the root path, switch if the new parent is closer, with a gain threshold to avoid oscillation; loop detection via root paths; claims trees converge to similar quality regardless of join order. | Predicts that without periodic re-joins the tree depends on join order; recommends a periodic, thresholded re-join. |
| Chu et al. (ESM deployment), USENIX 2004, <https://www.usenix.org/legacy/publications/library/proceedings/usenix04/tech/general/full_papers/chu/chu.pdf> | Per-node degree bound (max children); parent selection probes 30 known members, excludes saturated and descendants, ranks by throughput then delay; graceful leave keeps forwarding 5 s while children find parents; switch below 90% of source rate only with losses; detection time adaptive from 5 s; loss diagnosis: 51% not fixable by self-organisation, 31% fixable (parent leave, congestion near parent). | Recommends make-before-break on graceful leave and damping parent changes; predicts most bad viewer-time is not fixable by moving. |
| Sripanidkulchai, Ganjam, Maggs, Zhang, SIGCOMM 2004, <https://www.cs.cmu.edu/afs/cs.cmu.edu/project/phrensy/pub/papers/SripanidkulchaiGMZ04.pdf> | Of oracle, minimum depth, random and longest-first parent selection under real churn traces, minimum depth was second only to the oracle ("balanced shallow trees minimize the number of affected descendants"); over 90% of incarnations saw no change or ≥ 5 min between changes in the largest event; 45 of 50 streams had ≤ 20% poor incarnations; raising the degree cap from 4 to 6 or 10 helped only slightly. | Predicts a min-depth join rule (random tie-break) improves both delay and disruption per departure; extrapolation from thousands of peers to ≤ 32 is untested. |
| Magharei, Rejaie, Guo, INFOCOM 2007, <http://mirage.cs.uoregon.edu/pub/infocom07-treemesh.pdf> | Mesh swarming beat multiple-tree push in static and churn scenarios; their tree baseline keeps trees short by placing a new internal node under the shallowest node (BFS order) with a free slot or a leaf child, displacing that leaf. | Their tree baseline recommends shallowest-slot placement with leaf displacement; their mesh conclusion assumes chunked pull with multiple descriptions, which a single WebRTC media stream does not have. |

## Constants

| Name | Value | Where | Role |
| --- | --- | --- | --- |
| `RelayLimits::default().default` | 2 | `routes.rs:22` | planner default when unset |
| `default_relay_capacity` | 2 | `access.rs:70-72` | room default fanout |
| `MAX_RELAY_CAPACITY` | 20 | `access.rs:68`, range check `:104` | room default range 1..=20; overrides 0..=20 (`room.rs:433`) |
| relay candidate threshold | ≥ 2 receivers incl. itself | `routes.rs:407` | which unplaced relays get a candidate tree |
| `SCREEN_PREPARE_MS` | 20 000 ms | `publication.rs:9` | operation deadline |
| `QUALITY_EVIDENCE_MS` | 5 000 ms | `publication.rs:11` | presentation freshness at switch |
| `REQUIRED_REPAIR_MS` | 5 000 ms | `room.rs:20` | room repair wake |
| `PAIR_DEGREE_LIMIT` | 64 | `transport.rs:17` | pairs per ordinary endpoint |
| service degree | `MAX_SESSIONS − 1` = 127 | `discovery.rs:748-754` | pairs for the service |
| `CHANNEL_ATTEMPT_LIMIT` | 4 | `transport.rs:19` | concurrent attempts per channel |
| `ENDPOINT_ATTEMPT_LIMIT` | 2 | `transport.rs:20` | concurrent attempts per endpoint |
| standby attempts | 1 pending | `transport.rs:295-307` | serial standby |
| `DISCOVERY_TIMEOUT_MS` | 20 000 ms | `transport.rs:32` | attempt deadline |
| `REQUIRED_RETRY_MS` | 5 000 ms | `transport.rs:33` | failure cooldown |
| `MAX_SESSIONS` | 128 | `identity.rs:11` | frontier id table bound |
| `CHANNEL_MESSAGE_BYTES` | 4 MiB | `wire.rs:8` | frontier advice truncation |
| crossings kept per entering node | 2 | `discovery.rs:398-405` | room suggestion options |
| ring steps | ±1, then ±2 after a failure | `connectivity.rs:24-41` | standby ring |
| `Interest` order | Recovering < Channel < Room < Activity < Delivery | `transport.rs:8-14` | retention and reclaim |
| `DiscoveryRank` order | Restoration < Completion < Activity < Room < Channel | `transport.rs:24-30` | admission order |

## What was measured, and what was not

Measured:
- **Offline placement study** (`topology-improvement-design.md:140-195`;
  harness on branch `test/placement-study` at `84b46474`, ignored tests,
  drives the real authority and room through the public command path; pair
  outcomes from an *invented* NAT-class model, `topology_study/model.rs`;
  every assigned flow proved instantly; branch-and-bound solver for
  coverage-then-summed-depth). Results at limit 2: extra hops per viewer
  0.00/0.13/0.33/0.51 at 4/8/16/32 viewers; leaf moves recover 9–14% of the
  loss; one hypothetical pair attempt closes 93–98%; no tree serving more
  viewers was found. No latency, bandwidth, picture or overlap cost.
- **Five-node exhaustive comparisons** (`network-lab.md:388-430`): coverage
  optimality, early-exit equivalence, planning time, relay-removal repair.
- **Unreachable first viewer** (`network-lab.md:432-458`): a pending direct
  attempt held the only source slot for about 20 s.
- **One explicit Switch** on loopback (`network-lab.md:585-624`): commit after
  7.45 s and 14.53 s; the incumbent froze once during a trial with no gain.
- **Idle pair cost**: about 2.4 KiB/s for twenty idle pairs on a desktop
  Browser (`adr/0018:107-108`).

Not measured (from the code's perspective):
- Delay or picture cost per extra hop (no per-hop latency anywhere in the
  planner); the depth the planner produces on live networks.
- Time from a parent's departure to the orphans' first frame, including
  sequential 20 s Prepare turns.
- How often the direct-pair shortcut succeeds in the field, and how often
  `direct_attempted` blocks a later useful shortcut.
- Any comparison of the frontier's UUID-ordered choice with a depth-aware
  choice; any run of `ordinary`'s articulation protection.
- Voice trees: no measurement of relayed voice under the per-tree limit.

## Questions for the reviewer

1. **Edges before depth.** `append_path` seeds every usable placed node at
   distance 0 (`routes.rs:452-460`) and the tuple puts −edges before −depth
   (`:353-358`). Smallest case: S has a free output; D is placed at depth 5
   with a free output; U is an unplaced relay; confirmed S–U, U–V, D–V. V is
   placed under D at depth 6, not via U at depth 2; the relay candidate pass
   skips U because it could take only one receiver (`:407`). Only if the
   separately requested S–V pair later confirms does the one-time shortcut
   lift V to depth 1; a confirmed U–V is never used. Is "fewest added edges"
   the intended first objective for an interactive screen?
2. **UUID order chooses the next pair.** Frontier crossings rank by
   (confirmed, pending, retry_after, endpoints) (`discovery.rs:230-237`) and
   `repair_candidate` breaks benefit ties by index (`connectivity.rs:157-168`).
   With fresh bridges from depth-1 relay A and depth-6 relay D to V, the
   lower endpoint pair is tried. Depth of the `from` node is never consulted.
3. **Placement frozen during a reduction.** While any parent is over its limit
   placement does not run (`publication.rs:343`). Lower relay A's limit 3→2
   and let relay B depart at the same time: B's orphans and any newcomer wait
   for A's Reduce (≤ 20 s per moved child, one child at a time).
4. **Which child a reduction moves.** All children of an over-full parent are
   "excess" (`routes.rs:851-852`); the first in UUID order with a feasible
   parent moves (`publication.rs:598-604`), regardless of subtree size or
   depth gain. Moving a relay with a large subtree re-leases every descendant.
5. **Voice capacity per speaker tree.** No `shared` reservations for voice
   (`room.rs:1596-1615`): with room default 2 and five speakers, one listener
   relay can be planned to forward voice to up to ten distinct peers; with a
   personal Auto limit nothing caps it. Screens share capacity; is the
   difference intended?
6. **`ordinary`'s alternative can be another rejected pair.** Only the first
   candidate is checked against `rejected` (`discovery.rs:645-651`); exact
   demand pairs outrank everything in `select` (`connectivity.rs:116-134`) and
   a rejected pair counts as available here. Case: S–R, R–V1, R–V2 confirmed,
   S–V1 and S–V2 both rejected → first = (S,V1), alternative = (S,V2), both
   filtered at admission; no protective pair around R is ever proposed.
7. **Alternate only for some inputs.** `alternate` iterates `watch_order`
   (viewers only) and skips viewers with helpers (`publication.rs:257`,
   `:447`): a pure transit relay or App helper whose input is disconnected
   never gets one; it also requires the child's own report `(child, old)` and
   no other operation (a newcomer's Prepare blocks it for up to 20 s).
8. **Sequential Prepare turns.** Only the first unproved frontier edge carries
   a deadline (`publication.rs:491-498`); k orphan edges that fail silently
   take up to k × 20 s. And the assisted Switch replaces a current Prepare
   without expiring it (`:470-487`), restarting that edge's clock although the
   network doc says reconciliation does not extend the wait
   (`channel-network-design.md:596-600`).
9. **One shortcut forever.** `direct_attempted` is set at attempt start and kept
   while the session is routable (`publication.rs:105-109`, `:516`): a viewer
   that shortcut once and is later re-placed deep by a repair is never
   shortcut again, even when the source frees a slot.
10. **The pool discards depth-useful pairs.** A confirmed pair that carries no
    flow, is not a requested direct pair, not on a repair path and not in the
    DFS/back-edge/ring skeleton is released on the next channel reconcile
    (`transport.rs:268-288`, `connectivity.rs:17-22`). The study's "shallow
    places are free; the confirmed pairs to them are missing" may partly come
    from here, not only from never asking.
11. **Unbounded refusal retry.** `retry_required` clears refusals of every
    unplaced viewer every 5 s while `needs_repair` holds (`routes.rs:887-899`,
    `room.rs:1588-1590`); a parent that fails silently is retried about every
    25 s (5 s wake + 20 s Prepare) with no backoff or count.
12. **Two owners shed load differently.** Lowering a personal limit refuses
    flows at once in peer-UUID order (`forwarding.rs:240-249`) and reports
    them as media failures (subtree detached, parent refused); lowering the
    room default goes through a 20 s Reduce that picks by child UUID and
    feasibility. Same physical outcome, two rules.
13. **Voice edges never time out in the room.** Voice returns before any
    Prepare (`publication.rs:443-445`), so an edge that never proves has no
    room deadline; only transport failure or a Reduce moves it.

## Not read

- `transport.rs` beyond discovery/admission (flow leases, snapshot details,
  UDP preparation), `channel.rs` (except where cited), `remote.rs` beyond
  `planning_sessions`, `file_delivery.rs`, `watch_delivery.rs`, `topology.rs`.
- `room.rs` outside the routing paths (commands, projection building beyond
  frontiers, history); room tests in `room/tests/*` other than names.
- Test bodies of `pool_standby.rs`, `pool_concurrency.rs`, `activity_paths.rs`,
  `base_routes/coexisting_demand.rs` and most of `base_routes.rs` (names only,
  plus `demand_probes_one_shortcut_over_a_working_relay`,
  `selected_input_disconnection_prepares_alternate_branch`,
  `prepared_branch_waits_for_downstream_transport` and
  `pool_coldstart.rs:485-551`).
- The placement-study harness beyond the solver header and the NAT model.
- Native and Browser runtimes (how `down` reports and proofs are produced).
- `channel-network-design.md` outside lines 150-224 and 405-816.
