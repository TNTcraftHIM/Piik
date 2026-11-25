# Quiet Topology Improvement: Evidence And Independent Designs

- Date: 2026-11-25
- Status: evidence for [ADR-0018](../adr/0018-quiet-topology-improvement.md),
  not a decision.

## Question

The [canon](../canon.md#media-and-network) asks for a topology that keeps
improving by itself, judged by how playback goes, without disturbing what
works. Three earlier rules stood in the way for stated reasons: no weighted
route score, because an edge has too few samples; no probing of all pairs,
because a probe is a real media session; and no periodic rebalancing, because
it risks working playback. This note records what mature systems do about
those three difficulties and what three independent designers proposed.

## What Mature Systems Do

No system found faces all three difficulties at once. Each well-known
mechanism leans on a condition a room of friends lacks: a playout buffer of
many seconds, trial traffic that is useful in itself, hundreds of peers, or a
history over many sessions.

- **Round-trip time is free, capacity is not.** The candidate pair's
  round-trip time comes from connectivity checks, including consent checks, so
  it exists on an idle pair. The available outgoing bitrate does not exist for
  a pair that never sent media.
  [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/) ·
  [RFC 7675](https://www.rfc-editor.org/rfc/rfc7675.html)
- **A deployed single-tree broadcast** changed parent only when throughput
  fell below 90% of the source rate and loss confirmed it. It lengthened the
  detection time after recent changes. Loss seen by siblings at the same time
  pointed at the parent, and a node that kept changing parent and still
  suffered was itself the cause.
  [End System Multicast, USENIX 2004](https://www.usenix.org/legacy/publications/library/proceedings/usenix04/tech/general/full_papers/chu/chu.pdf)
- **Comparing a loaded path with an idle one fails.** A multipath transport
  did so, switched about once a minute, and lost most of its throughput. Its
  maintainers concluded that minimum round-trip times should be compared and
  that a switch needs a real margin.
  [Path selection under load](https://github.com/n0-computer/iroh/issues/4644)
- **Sending on both paths until the new one is trusted** is how a mesh VPN
  moves from a relay to a direct path, with a retry at most once a minute and
  no switch for a marginal gain.
  [magicsock](https://github.com/tailscale/tailscale/blob/main/wgengine/magicsock/endpoint.go)
- **Exploration budgets** such as the optimistic unchoke work where a trial is
  cheap and useful. A relay-selection study for a large calling service
  explored only at call setup, from history across calls, never mid-call.
  [BitTorrent](https://bittorrent.org/bittorrentecon.pdf) ·
  [VIA](https://www.cs.cmu.edu/~junchenj/via.pdf)
- **Voice.** A tree per speaker saves a listener nothing, because each
  listener still receives one copy of each speaker. It moves upload from the
  speaker to relaying listeners and adds hops. A direct mesh of 20 needs about
  1 Mbps of upload from whoever is speaking, with discontinuous transmission
  on. [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587)

## What The Literature Does Not Answer

- What a viewer sees when a parent changes at sub-second latency.
- The delay and quality cost of a forwarder that decodes and encodes again,
  for video and for Opus speech.
- Whether an adaptive overlay beats a static one at 2 to 50 nodes.
- What 7 or 19 idle audio connections cost a phone.
- Whether a Browser can forward encoded frames unchanged. Chrome shipped
  constructors for encoded frames and named forwarding to another peer
  connection as a use, while the specification says a processor cannot move
  frames between streams. A test in Chrome 156 settled it for now: a
  constructed copy of an encoded audio frame delivered no frames, on the same
  sender and across connections, so a Browser relay still decodes and encodes
  again.
  [Intent to ship](https://www.mail-archive.com/blink-dev@chromium.org/msg10120.html) ·
  [Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/)

## Three Independent Designs

Each designer received the requirements, the canon's principles, the facts of
the platform and the evidence above, and read nothing in the repository. Two
received the same brief. The third was asked to test whether the conventional
answer is wrong for a group of 2 to 20. They are instances of one model
family, so their agreement marks a design worth testing, not a proof. They
also assumed one encoding per stream and counters that the Native runtime
does not have. Frame counts are not comparable across layers or re-encoding,
and in the present tree a report to the room authority sends a full snapshot
to every session. [ADR-0018](../adr/0018-quiet-topology-improvement.md)
therefore starts offline and decides a move by comparison.

All three agree on the following. The third designer concluded that the three
earlier rules were right in substance.

- **Voice is a direct mesh at every size**, with discontinuous transmission
  on and one relay hop only for a pair that cannot connect. In a room with
  voice, that mesh is the connection pool: every pair is connected and its
  round-trip time is known.
- **Nothing speculative across a site.** A viewer without voice keeps one
  spare connection to an eligible parent. A pair's last result is remembered.
- **No weighted score.** Candidates are ordered lexicographically over proved
  facts, with margins.
- **No separate media trial.** The overlap of a make-before-break switch is
  the trial: the same frames in the same seconds on two paths, both loaded.
- **One move at a time per stream.** Every voluntary move strictly lowers a
  bounded quantity, so moves end.
- **Blame before moving.** Siblings bad together mean the parent is full. A
  node bad alone moves once, and a node still bad after moving is limited
  locally and is left alone.
- **Capacity is learned, not set.** A node starts from a prior, grows by one
  when every child stays healthy under real load, shrinks when its sender
  reports a limit or its children suffer together, and its proved value is
  remembered across days.
- **Health is frames rendered against frames the source sent**, confirmed by
  loss or freezes. Freeze counters alone misfire on screen content.
- **Failure** is detected when the source advances and the child receives
  nothing for about two seconds. Only the head of the stalled subtree moves,
  over a connection that already exists.
- **Record first.** One report a second from each endpoint, a decision log,
  and the planner run in shadow before it acts.
- **Not built:** media probes, speed tests, a periodic global re-solve, media
  standby, voice trees, an exact solver as the actuator, and any capacity
  number shown to a person.

| Topic | Positions |
| --- | --- |
| Unit of capacity | Outgoing edges (one); the peak rate a node has carried (two) |
| Moves for delay alone | Allowed above 30 ms and 20%, or 50 ms and 25% (two); refused until logs show the gap (one) |
| Re-encode generations | At most one (one); at most two (one); ordered, not capped (one) |
| Depth | At most three (one); not capped (two) |

## Compared With The Tree

| Topic | The three designs | The tree |
| --- | --- | --- |
| Voice | Direct mesh, one relay hop for a failed pair | A tree per speaker under the room fanout |
| Pool standby | The voice mesh, or one spare per viewer | Ring neighbours and a bounded alternate |
| Capacity | Learned from what was carried | A peer count a person sets, 2 by default |
| Parent choice | Generations, then depth, then proved headroom | Fewest hops, ties by session identifier |
| Health | Rendered frames against source frames | Decoded frames in a window, which a static screen cannot supply |
| A parent that degrades | Repair after sustained evidence and blame | Never replaced until it fails |
| Voluntary improvement | Continuous, one proved move at a time | One shortcut to the source per viewer |
| Silent parent | About two seconds, from frame counters | Connection failure, up to the consent timeout |
| Proof before a switch | The overlap, both paths loaded | The same, already present |

## Offline Placement Study

A test-only harness drives the real planner on synthetic sessions: one sharer,
N viewers who arrive, leave and sometimes leave while relaying, with pair
connectivity drawn from an assumed mix of NAT classes. It compares each tree
with a search over the same confirmed pairs and limits, maximizing coverage
before minimizing summed depth. The harness is on the branch
`test/placement-study` at `84b46474`,
excluded from the ordinary suite. It measures placement only: it has no
latency, bandwidth, picture quality or overlap reservations. Moves and pair
attempts are free and instant, and the NAT shares are invented.

At a limit of two, the confirmed-pair results are medians across seeds. Extra
hops divide the summed depth gap by placed viewers across equal-coverage
snapshots. Deepest depth averages snapshot maxima and has its own search
objective at maximum coverage. A snapshot counts as improved if the search
served more viewers or served as many at lower summed depth. These columns
use the best trees found. The harness reports exactness separately.

| Viewers | Extra hops per viewer | Deepest viewer, planner and search | Snapshots improved |
| --- | --- | --- | --- |
| 4 | 0.00 | 1.50 and 1.43 | 0% |
| 8 | 0.13 | 2.40 and 2.00 | 45% |
| 16 | 0.33 | 3.68 and 2.77 | 75% |
| 32 | 0.51 | 5.31 and 3.78 | 88% |

- Across sampled states, the confirmed-pair search found no tree serving
  more viewers. No waiting viewer had a linked parent with a free place.
- **Depth loss grows with the sampled room size.** At four viewers the median
  gap rounds to zero. The loss is lower before the first departure, suggesting
  repairs add most of it: orphans are placed again by fewest hops on whatever
  pairs exist, and nothing improves them afterwards.
- **A leaf move over existing pairs is worth little.** An opportunity that
  recurs appears in 59% of sessions of 16 and 96% of 32, and the rule never
  cycled. It recovers 9 to 14% of the loss. The shallow places are free; the
  confirmed pairs to them are missing.
- **One pair attempt closes more of the sampled depth gap**: 93 to 98% of the
  summed depth gap to the best tree found on all connectable pairs. The
  fraction pools hops across seeds and equal-coverage snapshots, with moves
  simulated afresh on each observed tree. The median session tried about 20
  distinct hypothetical pairs at 16 viewers and 72 at 32, deduplicated
  across snapshots.
  A leaf that moves can leave its parent childless, and that parent becomes a
  movable leaf, permitting further rearrangement on the wider graph.
- **A refused viewer whose linked parents are all full is rare** at a limit
  of two or more. "Placed deeper while a parent was full" is true of almost
  every viewer and cannot serve as evidence.

The loss in depth, the small value of plain leaf moves and the absence of
cycles hold under a pessimistic and an optimistic connectivity setting. The
number of pair attempts and the count of refusals do not.

Local saturation alone does not establish maximum coverage. With capacity one
and undirected edges S–A, S–B, B–A and A–W, the tree S→A→B strands W, while
S→B→A→W serves all three viewers. This is a static alternative; its transition
must still respect the live operation's overlap and proof budget.

## Measurements That Decide

1. The share of bad viewer-time caused by a parent or an edge, as opposed to
   the viewer's own link. If small, placement and failure repair are enough.
2. How long an untreated bad episode lasts.
3. The cost of a switch on a pooled connection: time to proved render, and any
   glitch at the cut.
4. The cost of one re-encoding hop: delay, resolution, frame rate.
5. Whether a node's proved capacity repeats from day to day.
6. A hop chain for voice, with a Native forwarder and with a Browser.
7. Idle audio connections on a phone, at 3, 7 and 19. On a desktop Browser,
   twenty idle pairs cost about 2.4 KiB/s per endpoint
   ([network lab](./network-lab.md#idle-physical-connection-cost)).
8. How long a viewer waits after a parent dies silently.
