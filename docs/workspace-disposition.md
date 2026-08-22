# Workspace Disposition

Last sampled: 2026-08-22 11:42 HKT

This is the demand-loaded schedule for restoring one canonical repository root and disposing of auxiliary work safely. It is not permission to delete, merge, rebase, or resume a TODO. Shared state is dynamic, so every action must re-sample Git status, refs, PRs, and links immediately before execution.

## Canonical Target And Stop Gate

- The canonical repository root is the registered worktree whose sibling-directory name is `Screener`; all other `Screener-*` worktrees are auxiliary.
- Its required terminal state is a clean, exact latest `main`. An auxiliary worktree must not retain `main` afterward.
- The audit-guard truth checkpoint merges first; it does not accept a final routing model. The root's staged user rules must be proved present in that updated `main` or explicitly preserved before its index changes.
- After truth integration, canonical-root restoration, and the approved workspace cleanup below, produce the holistic routing model as a held proposal from canonical `main`. Then report the main SHA, dirty/untracked count, retained worktrees/branches, route proposal, held candidates, and proposed high-confidence TODOs to the user.
- Do not create or resume a remaining-TODO implementation worktree until that checkpoint is explicitly confirmed. After confirmation, every new branch/worktree starts from the exact canonical `main` SHA.

## Disposition Classes

- `A PRESERVE`: required before truth integration, dirty, disputed, open, or carrying unique/unknown work. No cleanup.
- `B RECONCILE`: evaluate only after accepted truth is in `main`; transplant approved scoped code/tests/evidence, never an old truth snapshot.
- `C CANONICAL`: handle only while restoring the canonical root to latest `main`.
- `D CLEANUP`: eligible only after semantic disposition, integration/equivalence, clean-tree, open-reference, and non-following link checks all pass.
- `E RETAIN`: active stack, external evidence, archive, or unknown provenance; keep until a separate reviewed decision.

## Registered Worktrees

The snapshot contains 30 registered worktrees. Seven are dirty. Only
`Screener-local-oneclick` has nonignored untracked files: five unique project
files.

| Worktree | Branch / HEAD | Snapshot | Class and next action |
| --- | --- | --- | --- |
| `Screener` | `feat/viewer-presence-polish@d10e879` | staged `AGENTS.md`, no untracked | `A -> C`; preserve two user rules, then restore this root to exact `main`. PR #153 is merged; after restoration, its local and remote branch become `D` only after a fresh merged-head and open-head/base recheck. |
| `Screener-current-routing-truth` | `docs/current-routing-truth` audit branch | truth owner; sampled from `origin/main@7df8217` | `A -> D after merge`; finish, validate, review, and merge before any other integration, then remove its clean merged auxiliary worktree/branch during canonical cleanup. |
| `Screener-connection-details-presentation` | `main@7df8217` | clean | `A -> C`; currently occupies `main`. Release only after dependent junction handling and latest-main verification. |
| `Screener-configurable-relay-cap` | `fix/configurable-relay-cap@7df8217` | 10 tracked edits; junction to canonical `node_modules` | `A -> B`; disputed routing draft, preserve and later rebuild only approved intent. |
| `Screener-av-sync-next-slice` | `spike/av-sync-next-slice@d9bd4e2` | clean, open PR #192 | `A/E`; evidence-only, preserve open refs. |
| `Screener-real-relay-canary` | `test/real-relay-canary@f135302` | clean; local differs from merged PR head | `A -> B`; retain possible one-line report correction, never delete solely because #191 merged. |
| `Screener-resource-matrix-gate` | `docs/resource-matrix-gate@140dd00` | clean | `A -> B`; retain measurements only, exclude stale Browser1 policy. |
| `Screener-signaling-blackhole-canary` | `test/signaling-blackhole-canary@e972b75` | clean; junction to auxiliary-main `node_modules` | `A -> B`; evidence for held watchdog decision; handle junction before releasing auxiliary main. |
| `Screener-routing-architecture` | `docs/routing-algorithm-convergence@43b1f46` | clean | `A -> B`; historical/disputed model input only. |
| `Screener-relay-parent-quarantine` | `fix/relay-parent-quarantine@5bab93b` | 2 tracked server edits | `A -> B`; unknown routing draft, preserve pending model review. |
| `Screener-connection-details-stability` | `fix/connection-details-stability@55f4cbc` | clean | `A -> D`; superseded design input, cleanup only after #187 equivalence recheck. |
| `Screener-current-route-canary` | detached `b77f4eb` | clean | `D`; old exact-main fixture, recheck no consumer before removal. |
| `Screener-host-generation-debug` | `spike/host-generation-quality-evidence@fc4b0b0` | clean, local-only | `E`; unknown provenance. |
| `Screener-local-oneclick` | `feat/local-oneclick-bundle@e3ab39c` | 7 tracked edits plus 5 untracked project files | `A/E`; unique dirty work, never clean or remove automatically. |
| `Screener-native-live-bridge` | `spike/native-live-encoded-bridge@8121b69` | clean, draft PR #22 | `E`; preserve Native stack. |
| `Screener-native-live-feedback-loop` | `spike/native-live-feedback-loop@aad560e` | clean, draft PR #28 | `E`; preserve Native stack. |
| `Screener-native-primary-nack-retransmit` | `spike/native-primary-nack-retransmit@a6c3456` | clean, draft PR #25 | `E`; preserve Native stack. |
| `Screener-native-shared-encode` | `spike/native-shared-encode-browser@80f65d0` | clean, draft PR #18 | `E`; preserve Native stack. |
| `Screener-native-shared-feedback-control` | `spike/native-shared-feedback-control@eb9aabe` | clean, draft PR #23 | `E`; preserve Native stack. |
| `Screener-pion-rtp-fanout` | `spike/native-rtp-fanout-oracle@5b09f0a` | clean, draft PR #16 | `E`; preserve Native stack. |
| `Screener-native-two-viewer-fanout` | `test/native-two-viewer-fanout@bf898b6` | clean, remote branch, no PR | `E`; held Native candidate. |
| `Screener-windows-shared-encode-sender` | `feat/windows-shared-encode-sender@1ce732e` | clean, 14 local commits | `E`; unique held Native candidate. |
| `Screener-participant-connection-truth-plan` | `docs/participant-connection-truth-plan@4b536d0` | clean, local-only | `E`; unknown docs input. |
| `Screener-quality-evidence-followups` | `docs/quality-evidence-followups@d3f160f` | clean, local-only | `E`; unknown docs input. |
| `Screener-recovery-details-release` | `fix/recovery-details-release@b0e013f` | 2 tracked docs edits | `A/E`; stale code ancestry plus unique unknown docs. |
| `Screener-route-status-visual` | `fix/route-status-visual-recall@79ee46e` | clean, local-only | `E`; unknown and likely overlapped. |
| `Screener-sfu-healthy-reselection` | `docs/sfu-healthy-reselection@47c2ce7` | clean, local-only | `E`; old design, semantic review required. |
| `Screener-sfu-stable-stream` | `fix/sfu-stable-subscriber-stream@4d46a4a` | clean, local-only | `E`; unknown. |
| `Screener-target-peer-error` | `fix/target-peer-not-connected@7141cd9` | clean, local-only | `E`; unknown. |
| `Screener-viewer-c-evidence` | `docs/viewer-c-evidence-contract@911b03b` | 4 staged/add plus `docs/status.md` conflict | `A/E`; unresolved conflict and unique work, never remove/rebase automatically. |

## Local Branches Without Worktrees

- `docs/production-smoke-record@231a7c3`: `E`, unknown.
- `feat/room-viewer-access-merge-history@921e8a2`: `D`, merged-equivalent after final recheck.
- `feat/sfu-media-mode@fb7d4f1`: `D` candidate, closed-unmerged PR #12; semantic supersession must be proved first.
- `fix/ice-status-wording@4f7fee4`: `D`, current-main ancestor after final recheck.
- `fix/screen-audio-bitrate-target@5a71462`: `E`, local unique commits despite a related merged remote head.

## Open And Remote References

- Preserve `main`, open PR #192, and the Native stack #16/#18/#22/#23/#25/#28, including every stacked base branch. Preserve `test/native-two-viewer-fanout`, which has a remote branch without a PR. These are nine retained remote refs in this snapshot.
- The following 14 merged-PR heads are `D` candidates only after a fresh exact remote-head equals merged-PR-head check and confirmation that no open PR uses the branch as head or base: `chore/hygiene-ignore-untracked`, `docs/nat-web-boundary`, `feat/host-display-name`, `feat/host-roster-details-disclosure`, `feat/viewer-presence-polish`, `feat/viewer-topology-map`, `fix/codec-lock-hint`, `fix/peer-relay-quality-release`, `fix/relay-relative-quality`, `fix/revert-low-fps-reselection`, `fix/screen-audio-bitrate-target`, `fix/sfu-viewer-recovery`, `fix/sticky-sfu-cooldown-mainline`, and `test/real-relay-canary`.
- Preserve `feat/screen-audio-stereo` as `E`: PR #147 is closed-unmerged, so the merged-branch deletion rule does not apply merely because later work appears equivalent.
- The remote listing also contains the symbolic `origin/HEAD` alias; it is not a branch cleanup target. Every count and disposition must be re-sampled immediately before action because this 2026-08-22 snapshot is not permanent authority.

## Unregistered Directories And Artifacts

- Empty directory candidates: `Screener-android-pilot-apk`, `Screener-deploy-261e980c`, `Screener-production-truth-66eb` (`D` after exact empty recheck).
- Junction-only shells: `Screener-quality-evidence-alignment`, `Screener-room-peer-canary`. Each points to canonical `node_modules`; unlink the junction itself without following it before considering the empty root (`D`).
- Independent acceptance clone: `Screener-audio-main-acceptance` plus bare `Screener-audio-main-acceptance.git` at `960ae42` (`E`). It is not a canonical worktree; if later removed, use its own bare repository to remove its registered worktree first.
- Deployment archives: `Screener-deploy-artifacts`, `Screener-deploy-builds`, two extracted artifact directories, and five sibling `.tar.gz` files (`E/D`). Pair each with commit, checksum, and deployment retention records before archive/removal; never glob-delete `Screener-*`.

## Known Reparse Points

The non-following scan found exactly four junctions and no scan errors:

1. `Screener-configurable-relay-cap\node_modules` -> canonical root `node_modules`.
2. `Screener-signaling-blackhole-canary\node_modules` -> auxiliary-main `node_modules`.
3. `Screener-quality-evidence-alignment\node_modules` -> canonical root `node_modules`.
4. `Screener-room-peer-canary\node_modules` -> canonical root `node_modules`.

Never recursively remove a containing directory while one of these links remains unresolved. Delete only the link itself using a non-following operation, then verify the external target still exists.

## Execution Order

1. Stop writers and re-sample worktrees, dirty/untracked state, local/remote refs, open PRs, and reparse points.
2. Finish, validate, independently review, and merge the audit-guard truth checkpoint first; do not treat it as final route acceptance.
3. Prove the root's staged user rules exist in accepted `main`; explicitly preserve any unmatched content.
4. Handle the signaling-canary junction without following it. Recheck the auxiliary-main worktree is clean, untracked-free, and at exact latest `main`, then release it.
5. Make the canonical root clean without losing unmatched user work, switch it to exact latest `main`, and verify path, branch, HEAD, dirty/untracked state, and GitHub main equality.
6. Execute only already-approved `D` cleanup items, one exact target at a time, after semantic/equivalence/open-reference/link checks. Preserve all `A`, `B`, and `E` items.
7. From exact canonical `main`, produce only the holistic routing held proposal; do not implement it or resume another TODO.
8. Stop and obtain user confirmation of the organized canonical state, routing proposal, and proposed remaining TODO list.
9. Only after confirmation, update accepted owning truth and merge that truth into canonical `main`. Then create new implementation worktrees from that exact newer canonical-main commit and reconcile `B` candidates one at a time. Old branch truth files never win conflicts.
10. Process independent archives and deployment artifacts last, with checksum and retention evidence.
