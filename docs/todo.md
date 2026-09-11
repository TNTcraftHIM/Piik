# Current TODO Ledger

Last reviewed: 2026-09-11

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

Run candidate acceptance for the current audited source before the README,
documentation and website redesign.

### Candidate Acceptance

Accept the pending fixes and release preparation together on one phase branch.
Keep main and production unchanged until owner acceptance; preserve the rename
recovery archive and external-audit worktree. No new wire/quality/lifecycle
mechanism is implied by the remaining checks.

1. Build Windows App and Go Server candidates from one exact audited
   revision through the existing packagers. The `98b29ec1` rehearsal predates
   later source changes and is not final-candidate acceptance.
2. Exercise two real builds sharing the current contract in both App/Site
   directions and an already-open page across a compatible update. The recorded
   `98b29ec1` candidate and the final candidate are a possible pair; verify exact
   artifact identities first. These checks remain unrun. A private contract
   does not prevent this rehearsal or require stale-protocol compatibility code.
3. Verify synthetic stored-room/config preservation and usable subsequent
   sharing across the candidate update. Package startup/probe checks do not
   establish those behaviors. Keep the owner's macOS/Linux physical capture and
   broader device/network deferrals unless a new concrete finding is relevant.
4. Rehearse the local publisher dry run with genuine matching target artifacts;
   the full set remains unverified because macOS needs its native toolchain.
   Do not fabricate descriptors or relabel packages to satisfy it.
5. Provide the Windows candidate for owner acceptance before continuing the
   documentation/website redesign and remaining release preparation.

## Next — Public Introduction And Distribution

Finish the documentation/website redesign and distribution preparation below,
then run regression checks for the final changes and package that exact source.
Prepare one coherent squash PR for the accepted phase. Merge, deployment and
public publication remain separate delivery actions.

### Public Distribution And Activation

Choose source visibility, the public asset set and release notes under the
[first-public-release boundary](./reference/versioning.md#first-public-release-readiness).
Apply main protection once the repository is eligible and complete
[one-time activation](./operations/github.md) after explicit first-release
acceptance. Automatic publication remains disabled pending that acceptance.

Prepare GitHub-primary/Gitee-mirror distribution under the same
[release-source policy](./reference/versioning.md#release-sources). Configure the
owner's README-only Gitee target and implement mirror uploads and update-source
adapters over the existing release model. Validate final package sizes against
the current attachment quota and exercise publication/anonymous download before
enabling the mirror. Reuse the same built artifacts; no Gitee publication or
multi-source update checking is implemented yet.

### Public Introduction

After release preparation, rework the English/Chinese README, first-use guides,
documentation content/navigation and public website as one coherent task.
Prioritize clearer writing and information structure in the README and guides;
the existing drafts still need substantial revision. Include the requested
shared design-language and visual-effect changes, updating the
[public introduction](./design/public-introduction.md) and
[visual language](./design/visual-language.md) as new design decisions are
accepted. This work remains open despite the completed structural audits.

The owner owns **piik.tv**. GitHub Pages is the proposed public website; the
dedicated US server is a proposed separate P2P-only demonstration. Neither is
published. Choose download/demo destinations and finish DNS/Pages setup through
[website operations](./operations/website.md) before approved publication.
Plan the separate US demo deployment before exposing a demo link; the existing
private production service remains private. Describe P2P-only's lack of a
media-server fallback accurately.

## Parked Product Work

The reported persistent low resolution after Viewer backgrounding and square
black video remain unconfirmed incident leads, separate from the closed,
reproduced reconnect ownership bug. They do not block this release. Reopen from
matching upstream/receiver evidence; local H264 relay background checks did not
reproduce them. Missing NAT attempt text alone does not prove skipped attempts.
If Native adaptation is implicated, compare actual VSE limitations with sender
quality evidence before changing policy. Do not add retry budgets, visibility
resets or resolution heuristics without proof. Sanitized aggregates and the
isolated reconnect reproduction remain locally in `build/room7534-investigation/`.
Game/background settings behavior also remains an unconfirmed incident lead;
reopen from actual control actions and matching requested/applied media evidence.

1. **Representative device/network acceptance.** Resume the remaining matrix in
   [verification status](./verification-status.md#remaining-device-and-network-acceptance)
   when directed, preserving the owner's platform deferrals. Correlate freezes
   with publisher/receiver evidence before changing media policy. Run physical
   workloads serially from stable executable paths with cleanup between runs.
2. **Broader quality work.** Reopen from measured benefit at acceptable complexity.
   Preserve chosen profiles, bitrate ceilings, endpoint capacity and P2P-first
   routing unless a new accepted decision supports changing them. No weighted
   score, all-pairs probes, periodic rebalancing, parent-wide prediction or
   room-wide minimum. Check whether a quality move merely shifts pressure to
   another parent's siblings before widening policy.
3. **Control/resource fairness and input review.** Reassess the authenticated
   WebSocket/SFU owner, HTTP/body/resource bounds, authorization and error/log
   handling before adding a queue or limiter. No parallel security framework,
   accounts, risk score or speculative policy layer.
   Measure signaling-lock contention and synchronous diagnostic I/O before
   changing the lock or execution model; their cost remains a tradeoff.
4. **Reachable ownership/refactor work.** Retain Host/Viewer page media-session
   extraction as a candidate alongside related behavior changes. Evaluate clear
   resource owners, fewer shared writers and a smaller change surface under
   [engineering review](./reference/engineering.md#ablation-and-review); file
   size alone does not justify a split. The completed audits do not close this
   candidate. Reopen C=3 structural-intent retention, SFU failure during unrelated
   prepare and multi-child evidence ownership only with current-contract
   reproductions.
   No new revision namespace, failure-state mirror or topology queue by default.
5. **Storage fault recovery.** Choose and verify a damaged-disk/COMMIT/ROLLBACK
   recovery policy before adding catch-and-continue or retries. This failure
   boundary remains unestablished after ordinary persistence checks.
6. **Platform output.** Reopen for a registered receiver acting as an ordinary
   Viewer only after the [platform-output gate](./research/platform-output.md)
   passes.
