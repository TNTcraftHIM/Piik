# TODO Execution Audit Hold

Last updated: 2026-08-22

This is a temporary execution quarantine, not a backlog and not a deletion list. It prevents old assumptions, unchecked requirements, experimental conclusions, and agent-generated follow-ups from becoming authorized work after context compaction.

## Boundary And Rules

- Audit boundary: 2026-08-22 02:51:57 HKT, when broad TODO discovery and parallel execution began. Work already active before that point keeps its prior status; it does not automatically authorize new follow-ups.
- `CONFIRMED`: the user explicitly requested the product scope. The implementation still needs normal design and risk review.
- `REVIEW-REQUIRED`: the direction is relevant, but routing/state semantics must be reconciled before more changes merge or deploy.
- `AUDIT-HOLD`: preserve and inspect only. Do not continue, merge, deploy, delete, or revert it until provenance, necessity, and current semantics are reviewed.
- `EVIDENCE-ONLY`: retain reproducible measurements, but do not infer product policy, performance, capacity, or a release gate from them.
- `PRODUCTION-FACT`: a dated deployment record. It describes what ran, not what the product should continue to do.
- `SUPERSEDED`: a retained recovery/reference input that must not be executed. Remove it only after the truth audit and the normal Git/link safety checks.

Latest direct user decisions override contradictory older text during this audit: every non-server endpoint uses one server-authoritative downstream cap, default `2` and configurable as `1`, `2`, or `3`; upstream receive is free; Browser/UA/visibility does not define a separate tier. The routing audit must still settle SFU publication/subscription semantics, TURN accounting, and transitional resource leases as one system.

## Audit Order

1. Reconcile TODO provenance and the current truth set. Classify contradictions and holds without implementing them.
2. Produce the documentation/archive and worktree/branch/folder disposition schedule. Preserve all disputed or unknown material; do not delete, move, rebase, or merge it yet.
3. Merge this audit-guard truth, restore the canonical root to exact current `main`, and execute only the approved workspace cleanup schedule.
4. Stop and reconcile the organized canonical state and TODO classifications with the user before route modeling or another cleanup pass.
5. After explicit confirmation, produce the holistic routing model from those reconciled inputs as a held proposal; do not implement or silently accept disputed semantics.
6. Stop again for route-semantics confirmation. Only after accepted owning truth is merged may high-confidence worktrees start from that exact newer canonical `main`, or other TODOs be resumed, parked, superseded, or cleaned from the reviewed ledger.

Parallel work may accelerate one active phase, but it must not start a later phase early.

## Requirement Checkbox Audit

`docs/需求理解.md` currently contains 41 checkbox lines: 37 unchecked and 4 checked. They are acceptance-contract formatting, not a backlog:

- At least 18 unchecked lines describe behavior that current status/memory already call live or substantially deployed, including entry/room flows, capture/pause, presence, P2P-first routing, quality settings, recovery, observability, access, grants, persistence, private entry, automatic routing, and peer-assisted forwarding.
- Nine unchecked lines overlap disputed capacity, SFU, TURN, fallback, quality-parent, or accounting semantics (`27`, `29`, `31`, `32`, `44`, `48`, `53`, `57`, `63`). They cannot authorize implementation while held.
- Eight unchecked lines are conditional experiments, no-go/reopen conditions, later native/desktop work, platform-output boundaries, or regional questions (`47`, `49`-`52`, `54`, `65`, `66`), not current implementation tasks.
- The four checked lines are not proof of current authorization: connection self-check (`56`) and diagnostic export (`59`) remain provenance holds, while codec choice (`58`) and the Native capture helper (`64`) retain their separately scoped facts and evidence boundaries.

These groups overlap. Therefore neither 37 nor any subtraction from it is the executable TODO count. A normal TODO may be created only after its owning requirement is rewritten as current accepted behavior or a specific remaining gap, its implementation and production facts are reconciled, and any dependent hold is removed.

## Current Truth Owner Risk

- `AGENTS.md`, `docs/project-memory.md`, and `docs/status.md` are auto-loaded and must never mix disputed policy into confirmed intent or active milestones. During this audit they point here and separate dated production behavior from future product truth.
- `docs/需求理解.md`, `docs/方案设计.md`, and accepted ADR-0005 contain mixed deployed, historical, experimental, and disputed routing text. Their temporary banners freeze only the disputed route-dependent meaning; the accepted P2P-first, automatic, exact-generation, bounded-failure direction remains.
- `docs/verification-status.md` and `docs/deployment.md` may retain Browser1/root-two statements only as dated `9461e20` production evidence. Evidence does not authorize the next design.
- Research and historical ADR text remains source material. A proposal, threshold, benchmark, future gate, or past accepted status cannot become current work until its owner is reconciled against this hold.

## Pre-Boundary Active Scope

These scopes were already active or directly requested before broad TODO execution. Keep them, but do not extrapolate adjacent work from them:

Git history also shows mixed-provenance PRs: #164's core demotion commit was authored before the boundary while later selected-lease fixes landed in the same PR after it; #166's Host SFU and selected-endpoint work started before the boundary while encoder/A-V evidence was integrated afterward. Audit behavior and source, not just PR number.

| Scope | Status | Boundary |
| --- | --- | --- |
| Bad-relay corroboration, downgrade, reparenting, and make-before-break correctness | `REVIEW-REQUIRED` | Core user request; must now be reconciled with cap, SFU/TURN fallback, odd/full topology, and route generations as one design. |
| Share advanced audio settings and 64/128/256 kbps sender ceilings | `CONFIRMED` | Sender ceilings and observability are not fidelity proof. |
| Local connection details, selected candidate endpoints, and A/V observations | `CONFIRMED` | Local observation only; do not infer public IP, correction, or route authority. |
| Status archive/index policy and bounded NAT research | `CONFIRMED` | Documentation governance/research only; neither creates product runtime work. |

## Post-Boundary Mainline Changes

The range begins at PR #164. A merged or deployed item can still be under audit; do not rewrite production history.

| Item | Status | Audit reason |
| --- | --- | --- |
| #164 relay-parent demotion | `REVIEW-REQUIRED` | Requested behavior, but the bundled selected-lease/cap state must be checked against the unified route model. |
| #165 share audio presets | `CONFIRMED` | Directly requested product behavior. |
| #166 local media-path evidence | `CONFIRMED` | Covers requested endpoint/A-V observability; remains observation-only. |
| #167 status/verification split | `CONFIRMED` | Direct response to the status-budget/archive decision. |
| #168 cap3 topology benchmark | `EVIDENCE-ONLY` | Functional evidence for configurable cap; not a performance ranking or release gate. |
| #169 connection self-check | `AUDIT-HOLD` | Automatically expanded from an old broad checkbox; its reduced health/WSS/STUN contract was not independently reconfirmed. |
| #170 explicit 16-Viewer admission | `AUDIT-HOLD` | Restored an older configurable contract without a fresh product-size decision; default remained eight. |
| #171 diagnostic JSON export | `AUDIT-HOLD` | Automatically expanded from an old diagnostic-page checkbox; no confirmed support workflow. |
| #172 relay resource benchmark | `EVIDENCE-ONLY` | Short same-machine evidence cannot select cap or block reversible cap2. |
| #173 peer-quality MBB | `REVIEW-REQUIRED` | Requested routing direction; state/mutex/fallback behavior needs holistic audit. |
| #174 and #176 rollout records | `PRODUCTION-FACT` | Dated deployment records only. |
| #175 Viewer-parent provisional edge | `REVIEW-REQUIRED` | Required by MBB safety, but must fit the final lease/accounting model. |
| #177 Browser1 clamp | `AUDIT-HOLD` | Reversed prior cap2 behavior without failure evidence and conflicts with the latest explicit cap decision. |
| #178 routing-lifecycle truth | `AUDIT-HOLD` | Propagated Browser1 and room-global lease assumptions that are now disputed. |
| #179 SFU root-two invariant | `AUDIT-HOLD` | Hardened a conservative design constant without LiveKit/resource evidence; publication/subscription topology is under review. |
| #180 audio/production truth | `PRODUCTION-FACT` | Audio facts remain useful; adjacent routing claims are not reauthorized. |
| #181 selected-pair response observation | `AUDIT-HOLD` | Agent-generated diagnostic slice with no prior product requirement or recovery authority. |
| #182 signaling silent-partition watchdog | `AUDIT-HOLD` | Useful failure detection is plausible, but Host continuity and selected-edge session replacement remain unproven. |
| #183 Host-parent provisional edge | `REVIEW-REQUIRED` | Requested routing direction; retain while auditing the unified topology/lease model. |
| #184 and #189 production records | `PRODUCTION-FACT` | Dated deployment records only. |
| #185 SFU shaping prerequisites | `EVIDENCE-ONLY` | Environment prerequisite record; not a product feature or blocker for unrelated work. |
| #186 and #190 Browser1 truth changes | `AUDIT-HOLD` | Repeated the disputed Browser1 assumption into auto-loaded truth. |
| #187 relayed-detail stability | `CONFIRMED` | Completes the requested stable connection-detail presentation without new wire or route authority. |
| #188 route-recovery evidence | `EVIDENCE-ONLY` | Retain exact test limits; do not treat it as real network/SFU/TURN proof. |
| #191 Viewer MBB canary | `EVIDENCE-ONLY` | Synthetic evidence plus real local PCs; no detector, network, or performance claim. |
| #192 A/V sync fixture (open) | `EVIDENCE-ONLY` | Freeze merge while the audit is open; measurement plumbing is not a correction loop or quality proof. |

## Frozen Local Candidates

| Candidate | Status | Next audit action |
| --- | --- | --- |
| `fix/configurable-relay-cap` | `REVIEW-REQUIRED` | Preserve the draft; do not continue until the unified route/accounting model is accepted. |
| `test/signaling-blackhole-canary@e972b75` | `EVIDENCE-ONLY` | Retain for the #182 decision; it proves Viewer continuity only. |
| `docs/resource-matrix-gate@140dd00` | `EVIDENCE-ONLY` | Preserve the short-run data; do not merge old Browser1 policy text. |
| `test/real-relay-canary@f135302` | `EVIDENCE-ONLY` | One-line #191 report correction may still be useful even though the later local canary helper also contains it. |
| `docs/routing-algorithm-convergence@43b1f46` | `AUDIT-HOLD` | Historical design input only; it contains stale capacity assumptions. |

## Unresolved Routing Inputs

These are user-supplied scenarios to test against the holistic route model. They are neither accepted implementation designs nor executable TODOs yet.

1. A Host may reach media only through selected TURN while two first-level roots also cannot relay onward directly and need SFU-backed delivery. The final model must avoid two independent peers republishing the same screen into two competing SFU source truths. Audit whether one canonical share-generation publication, with TURN used only for its ingress when necessary, lets both roots and their descendants subscribe without duplicated encoding or lineage.
2. A mostly healthy room may already have two ordinary root branches when a newly joined leaf cannot receive its assigned P2P edge and needs SFU. Audit whether the leaf should leave that peer edge and subscribe to the room's canonical publication while its previous parent reclaims the ordinary child slot. Do not assume the intermediate parent must republish the same source.
3. Retain optional selected TURN during this audit. Decide keep, narrow, or remove only after comparing its exact-edge and Host-to-SFU-ingress value against credential, lease, recovery, and state-machine complexity. The examples above are not by themselves evidence that TURN should be removed.

The preferred simplicity test is one Host screen lineage, at most one canonical SFU publisher per share generation, selective SFU subscribers wherever P2P is unavailable, ordinary peer descendants where healthy, and TURN as a transport lease rather than another topology. This is a review hypothesis, not yet accepted architecture.

## Release Of A Hold

For each held item, record: original user requirement or lack of one; current consumer; behavior and rollback cost; security/privacy/resource boundary; conflicting facts; and a keep, revise, park, or remove decision. Only then update the owning requirement/ADR/research/status text in place. Do not use this temporary file as permanent architecture documentation.

Merge this audit-guard truth first; that merge does not accept a final routing model. Then preserve any root user changes, release `main` from auxiliary worktrees, restore the canonical repository root to the exact latest `main`, and complete only the approved workspace cleanup. Report that organized state and the TODO classifications, then wait for explicit user confirmation before producing the holistic routing proposal as a held document. Stop again for route-semantics confirmation. Only afterward may accepted route semantics be written into their owning truth and merged into `main`; retained candidates or remaining TODOs may be rebuilt or resumed only from that newer exact canonical-main commit. Candidate-era truth files must never overwrite it.
