# ADR-0018: Quiet Topology Improvement

- Status: proposed
- Date: 2026-11-25

## Context

The [canon](../canon.md#media-and-network) asks that the topology keep
improving by itself, judged by how playback goes, until every node has its
best upstream and downstream, and that it never disturb what works.

Today a viewer is placed by fewest hops and stays there. Core tries one
shortcut to the source per publication and session, and time alone never
produces another attempt. A parent that plays badly is not replaced until it
fails, and forwarding capacity is a peer count with a default of two. The
[evidence](../research/topology-improvement-design.md) covers two surveys,
three independent designs and the measurements taken in the
[network lab](../research/network-lab.md#playable-route-improvement).

## Decision

The goal is continuous improvement. The way there is measured: each step is
the smallest one whose value a record can show. No constant below is chosen
yet.

1. **Stage 0 is offline.** Use the local diagnostics a person exports by
   choice, and replay the planner's decisions on those traces. A live report
   every second is not a free prerequisite: today every reported state change
   sends a full snapshot to every session, a report would give the room
   authority private path facts, and Native lacks several of the counters. A
   live fact is added only when a concrete decision needs it.
2. **A move is decided by comparison, not by a threshold.** A candidate is
   compared with the incumbent under the same viewing intent, in the same
   seconds, both loaded. A move for quality needs no regression and a shown
   advantage, counting any harm the trial causes to the incumbent or siblings.
   Frame counts are not comparable across layers, frame-rate
   intent, re-encoding or a paused display, so the ratio of rendered to sent
   frames is only meaningful for matched layers, intervals and intent, including
   in offline replay.
3. **One proof-based operation at a time**, through the handoff that exists.
   Three reasons are kept apart: repair of an actual failure, improvement of a
   healthy route, and recovery from a starved source, which is not a reason to
   move. A failed attempt is rejected by its generation and reopened only
   under an agreed retry rule and fresh evidence. Input-generation fencing and
   rollback remain independent of whether downstream sender identities are reused.
4. **Observations open a comparison. They do not decide it.** Siblings in
   trouble together, or trouble through two parents, can have several causes:
   source capture, parent ingress, a shared access network or parent egress.
   They say whether a trial is worth its cost. The trial decides.
5. **Auto capacity grows by demand.** When a demand cannot be placed, one more
   child is tried at a sender that already plays the publication, under the
   existing allocator. The trial stays only if the new child reaches proved
   playback and every sibling still proves healthy through the same window;
   otherwise the new child alone is withdrawn, by its generation, and that
   sender is not tried again without fresh evidence. A node healthy with N
   children has proved N for that workload, nothing more, and the room's
   number is where it starts. A sender takes part only while it reports
   headroom: one yes or no for each kind, decided on the device from what its
   own connections measure, which refuses a trial and never proves one. The
   measurements stay on the device. A person's explicit limit, zero included,
   is kept, and each kind keeps its own budget. Memory across days is a later
   stage.
6. **Placement uses negotiated facts.** The generations a path costs depend on
   the formats and the implementation negotiated for that flow, not on a
   platform label. An unknown cost is not zero, and a pair's estimate is not
   an endpoint's headroom. Any new order is compared with the present hop
   order before it replaces it, including a transitive order when facts are unknown.
7. **The pool keeps its shared-interest ownership.** A spare connection that
   protects a receiver from losing its only relay is compared with denser fill
   of a room before density becomes a target.
8. **Voice has no additional overlay.** It uses the shared planner, pool and
   allocator, with independent voice counts and explicit user limits. Keep
   reachable multi-hop paths. The room's number of downstream connections
   bounds a speaker's own voice as it bounds a picture: one control for both,
   and less upload for the speaker. Its
   [measured cost](../research/topology-improvement-design.md#voice-fan-out-measured)
   is about 50 ms for each Browser relay a listener sits behind. The measured
   Chromium voice session did not negotiate discontinuous transmission. DTX
   and priority need their own comparisons.
9. **A lost parent is repaired through actual flow failure**, and each
   surviving branch needs its own entry. How long a viewer waits after a
   parent dies silently is not measured. Connection failure is one detection
   signal, not a bound on resumed rendering. Preserve the last frame during the
   owned recovery attempt. Measure silent loss separately from signaled departure
   before adding a detector.

## What Stays

No weighted route score, no media probe of a pair that carries nothing, and no
periodic re-solve of the whole tree. The shared pool, the grants, the
per-kind counts and media proof stay until a reviewed step replaces one of
them.

## Stages

| Stage | Step | Shown by |
| --- | --- | --- |
| 0 | Offline traces and a replayed decision | Nothing; it produces the evidence |
| 1 | One more child tried on unmet demand | Viewers left unplaced while a sender stayed healthy: with twenty endpoints that reach only the source, the planner serves 2 of 19 at the room's default and 4 with a limit of 4 |
| 2 | One leaf moved to a strictly better place, with the present proof | A missed opportunity that recurs in the traces |
| 3 | A targeted spare connection | Receivers that lost their only relay |
| 4 | Quality comparisons gated by observations; memory across days | Impairment that outlasts natural recovery; capacity that repeats |

Repeated moves of a subtree need a cost test on a real workload before sender
reuse is chosen or rejected. Two measured replacements kept playback while
their leases changed.

## Not Built

A speed test or any probe with dummy traffic. A second copy of a stream kept
ready on another path. A second overlay for voice. An exact tree solver as
the actuator. A number that a person has to set.

## Open Measurements

- How long a viewer waits after a silent parent death.
- The cost of one re-encoding hop for a screen and for speech.
- Idle connections on a phone. On a desktop Browser, twenty idle pairs cost
  about 2.4 KiB/s per endpoint.
- Matched stay and switch runs with different release times, counting the harm
  a trial does to the incumbent and to siblings.
