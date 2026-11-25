# ADR-0018: Quiet Topology Improvement

- Status: proposed
- Date: 2026-11-25

## Context

The [canon](../canon.md#media-and-network) asks that the topology keep
improving by itself, judged by how playback goes, until every node has its
best upstream and downstream, and that it never disturb what works. It also
says that nobody tunes a network.

Today a viewer is placed by fewest hops and stays there. A parent that plays
badly is not replaced until it fails, the one voluntary move is a single
shortcut to the source, forwarding capacity is a peer count that a person
sets, and a speaker's voice follows that count through relays. The
[evidence and three independent designs](../research/topology-improvement-design.md)
agree on what to add and on what to keep.

## Decision

The rules below are the design. The numbers are starting values, to be
corrected by the records of stage 0.

1. **Record first.** Each endpoint reports once a second what it sent and
   rendered per stream and per connection. The room authority keeps a decision
   log, and the planner first runs in shadow: it logs the move it would make
   and makes none.
2. **Health is frames, confirmed.** A viewer is unwell when it renders under
   90% of the frames the source sent over a window and loss or a freeze
   confirms it. A static screen sends nothing and proves nothing, so only
   active content counts toward a verdict.
3. **Voice goes direct.** A speaker sends to every listener it has a
   connection with, with discontinuous transmission on. A pair that cannot
   connect takes one relay hop through a node that forwards unchanged. Voice
   ranks above screens. In a room with voice this mesh is the pool.
4. **The pool grows from demand.** Nothing is connected in advance across a
   site. A viewer in a room without voice keeps one spare connection to an
   eligible parent. A pair's last result is remembered, and an idle pair is
   retired after a minute.
5. **Capacity is learned.** A node starts from a prior, the present default of
   two. It gains one when every child has stayed healthy under real load, and
   falls back when its sender reports a limit or its children suffer together.
   What it proved is remembered for that device and network. No person sets or
   sees the number. Whether a person forwards at all stays their choice.
6. **Placement is an order over proved facts.** Among eligible parents with
   room: fewest re-encode generations, then fewest hops, then proved room
   before a prior, then least load. Whether a node forwards unchanged is a
   fact proved for that node, not a property of its platform.
7. **Two reasons to move, one move at a time.** Repair, when a viewer has
   been unwell for a sustained period and blame says a move can help.
   Promotion, when a place strictly better in generations or hops is open.
   The switch is make-before-break, and its overlap is the only trial: the new
   copy must render as well as the old one over the same seconds before the
   old one stops. A failed trial marks that parent or pair, with a doubling
   wait before it is tried again.
8. **Blame before repair.** Siblings unwell together mean the parent is full,
   and its newest child leaves. A viewer unwell on streams from two parents is
   limited locally and does not move. A viewer still unwell after two moves
   stops moving.
9. **A silent parent is found from frames.** The source advances and the
   child receives nothing for two seconds, or the parent leaves. Only the head
   of the stalled subtree moves, over a connection that exists, and the
   picture holds its last frame meanwhile.

## What Stays

No weighted route score, no media probe of a pair that carries nothing, and
no periodic re-solve of the whole tree. The evidence supports all three. What
they lacked was the continuous single move of decision 7.

## Stages

Each stage after the first needs the record named beside it.

| Stage | Adds | Justified by |
| --- | --- | --- |
| 0 | Reports, decision log, shadow planner | Nothing; it produces the evidence |
| 1 | Direct voice, learned capacity, placement order, repair after failure | Removes the setting and the voice hops |
| 2 | Repair moves with blame | Parent or edge faults that outlast the trigger in a real share of unwell time |
| 3 | Promotions | Viewers deeper, or behind more generations, than proved capacity requires |
| 4 | Memory across days | Proved capacity that repeats from day to day |
| 5 | Moves for delay alone, relays for a speaker short of upload | Logs that show the gap |

Stages 2 and 3 need a change to touch only the edge that changed. Today a
change of a relay's input gives every flow below it a new identity.

## Not Built

A speed test or any probe with dummy traffic. A second copy of a stream kept
ready on another path. A voice tree or ring. An exact tree solver as the
actuator; it may run on the records as a measure of the gap. Any number that
asks a person how much to forward.

## Open Measurements

The [evidence](../research/topology-improvement-design.md#measurements-that-decide)
lists them. Three decide parts of this record: the cost of one re-encoding
hop sets how hard decision 6 avoids a generation, idle audio connections on a
phone set whether decision 3 needs a ceiling, and whether a Chromium Browser
can forward encoded frames unchanged decides how many nodes count as
forwarders.

## Consequences

- The forwarding limit a person sets becomes a choice to forward or not. The
  room default becomes the prior.
- Voice no longer depends on the room fanout, and a room with voice needs no
  separate standby connections.
- The single shortcut per viewer is replaced by decision 7.
- [ADR-0005](./0005-automatic-hybrid-media-routing.md) and the
  [forwarding design](../research/channel-forwarding-plan.md) keep their
  owners and are amended stage by stage.
