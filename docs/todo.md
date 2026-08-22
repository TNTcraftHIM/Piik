# Current TODO Ledger

Last reviewed: 2026-08-22

Only items in **Now** are executable after their stated decision gate. A branch name, unchecked requirement, experiment, review suggestion, or deployed behavior is not a TODO by itself.

## Now

1. **Merge accepted routing truth.** Reconcile the accepted holistic model across requirements, design, ADR, memory, status, and this ledger, then merge that truth into canonical `main` before dependent implementation.
2. **Migrate routing from accepted truth.** Rebuild the scoped runtime change from that exact `main`: every non-server endpoint defaults to steady outbound media-copy cap `2`, deployment accepts `1/2/3`, a peer child or Host publication consumes one slot, upstream receive is free, selected TURN replaces the same copy's transport, and no Browser tier exists. Replace split topology/route/transport authority and policy magic numbers with one controller, one committed ingress graph, typed reservations, and shared invariants. Keep `EdgeHealth` child-scoped; let the quality owner supply finite correlated windows and independent-edge corroboration for `RelayEligibility`, with no IP-ranking or room-wide score.
3. **Validate and release.** Run focused state-machine tests, child-vs-parent quality ownership, cap `1/2/3` topology and recovery matrices, constrained Host/SFU/TURN paths, independent routing review, build/full gates, bounded production preflight, deployment, postflight, and rollback verification.

The existing route implementation is an input to these tasks. Preserve its verified generation, authorization, make-before-break, and media-proof invariants while migrating capacity and fallback accounting.

## Product Decisions Needed

| Deployed or retained item | Decision |
| --- | --- |
| #169 connection self-check | Keep, revise, or remove the user-facing pre-share probe. Do not extend it automatically. |
| #170 explicit 1-16 Viewer admission | Confirm the small-room admission range independently of endpoint fanout. |
| #171 diagnostic JSON export | Confirm a support workflow or remove the extra surface. |
| #181 selected-pair response counter | Keep as local observation or remove; it has no route authority. |
| #182 signaling watchdog | Confirm Host, mobile/background, and selected-edge session semantics before calling it complete. |
| `feat/local-oneclick-bundle` | Decide whether local one-click startup belongs in the current Web roadmap. |
| Windows/native sender work | Keep as later optimization unless a browser capability gap changes priority. |

These decisions are not permission to continue old branches, and current deployment remains unchanged until a scoped decision is made.

## Evidence And Later Work

- Open PR #192 measures synthetic flash/tone timing; it is not an A/V correction feature.
- The Native PR stack #16/#18/#22/#23/#25/#28 and related fanout branches are one research program, not six product TODOs.
- Cap3, resource, route-recovery, Viewer-MBB, signaling-blackhole, Host-generation, SFU-shaping, NAT, mobile, and endurance artifacts remain bounded evidence. Merge or retain them only when a current decision consumes them.
- Real heterogeneous-network SFU/TURN, mobile lifecycle, audio/A-V device, and endurance/resource acceptance are scheduled at the relevant release boundary.

## Candidate Handling

- Preserve `fix/configurable-relay-cap`, but do not commit or merge it. Its relevant intent must be rebuilt after route truth is accepted.
- Preserve dirty or unique worktrees and open stacked branches until reviewed. Never resolve their conflicts by importing old truth into `main`.
- Sample worktree, branch, PR, artifact, and reparse-point state immediately before cleanup; do not maintain a permanent workspace inventory here.
