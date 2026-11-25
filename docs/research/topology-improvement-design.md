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
  connection as a use, while the specification still says a processor cannot
  move frames between streams.
  [Intent to ship](https://www.mail-archive.com/blink-dev@chromium.org/msg10120.html) ·
  [Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/)

## Three Independent Designs

Each designer received the requirements, the canon's principles, the facts of
the platform and the evidence above, and read nothing in the repository. Two
received the same brief. The third was asked to test whether the conventional
answer is wrong for a group of 2 to 20. They are instances of one model
family, so their agreement marks a design worth testing, not a proof.

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

## Measurements That Decide

1. The share of bad viewer-time caused by a parent or an edge, as opposed to
   the viewer's own link. If small, placement and failure repair are enough.
2. How long an untreated bad episode lasts.
3. The cost of a switch on a pooled connection: time to proved render, and any
   glitch at the cut.
4. The cost of one re-encoding hop: delay, resolution, frame rate.
5. Whether a node's proved capacity repeats from day to day.
6. A hop chain for voice, with a Native forwarder and with a Browser.
7. Idle audio connections on a phone, at 3, 7 and 19.
8. Whether a Chromium Browser can forward encoded frames unchanged.
