# Current TODO Ledger

Last reviewed: 2026-09-11

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

Hold after the completed audit and follow-up corrections, as requested by the
owner. The [cohesion record](./research/repository-cohesion-audit-2026-09-11.md)
and [lifecycle record](./research/lifecycle-audit-2026-09-10.md) own findings,
rejected changes and evidence limits. The
[engineering reference](./reference/engineering.md) retains the useful runtime
lifecycle map and source index. Await direction to resume the release line.

## Next — Candidate Acceptance And Release Preparation

Accept the pending fixes and release preparation together on one phase branch.
Keep main and production unchanged until owner acceptance; preserve the rename
recovery archive and external-audit worktree. No new wire/quality/lifecycle
mechanism is implied by the remaining checks.

1. Build final Windows App and Go Server candidates from one exact audited
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
5. Provide the Windows candidate for owner acceptance, then prepare one coherent
   squash PR. Merge, deployment and public publication are separate delivery
   actions; no release or main update is authorized by this audit closure.

[Versioning](./reference/versioning.md#first-public-release-readiness) owns the
remaining public-readiness boundary: real target packages, first supported
mixed-version acceptance, source/asset publication and activation. The pipeline
and local checks exist; no GitHub Release was published and automatic publication
is still disabled. Do not reset storage or live authority generations.

Templates and naming are prepared; GitHub now permits squash merges only and
uses the PR title/body. Main protection remains blocked by the current private
free-repository plan. Once eligible, apply the PR-only policy and complete
[one-time activation](./operations/github.md) after explicit first-release
acceptance. Website/README expansion follows this preparation.

Prepare GitHub-primary/Gitee-mirror distribution under the same
[release-source policy](./reference/versioning.md#release-sources). Configure the
owner's README-only Gitee target, validate final package sizes against its attachment quota,
and exercise publication/anonymous download before enabling it. Build once;
mirror uploads and update-source adapters must not create another release model
or duplicate CI compilation. No Gitee publication is active yet.
Rehearsal artifacts measure 13.5 MB (Server runtime) and 36 MB (Windows App);
confirm the current Gitee attachment quota before enabling the mirror.

### Public Introduction

Resume the accepted [public introduction](./design/public-introduction.md):
short English/Chinese README and first-use guides, the static site and its
mascot-only interactions. Keep detailed technical help in developer/operations
owners. No further website expansion precedes the conventions/version review.

The owner owns **piik.tv**. GitHub Pages is the proposed public website; the
dedicated US server is a proposed separate P2P-only demonstration. Neither is
published. Choose source visibility, public assets, release notes, download/demo
destinations and DNS/Pages settings before publication. The existing private
production service is not the public demo. P2P-only has no media-server fallback.
Runtime capability configuration is implemented; do not reopen it as a second
boolean or duplicate UI mode.

Further reviews follow [engineering review](./reference/engineering.md#ablation-and-review).
Search hits and file size alone do not authorize a repository rewrite.

[Verification status](./verification-status.md) owns remaining device/network
limits, including iOS playback/window/audio behavior. NAT and Auto are complete
features; broader statistics are not a new blocker. Keep branch CI quiet,
physical workloads serial and executables at stable paths. Packaging remains
manual until the accepted main-release automation is activated.

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

1. **Public distribution and updates.** Candidate packagers, immutable descriptors,
   notices, the runtime-only OCI recipe and release checks exist. Choose the
   public asset set and release notes before publishing a product-versioned
   GitHub Release or image with retained full-SHA provenance, following
   [versioning](./reference/versioning.md). Do not add automatic installation, container self-update, Watchtower,
   compatibility ranges or active-share interruption without distribution and
   recovery evidence. Ordinary branch pushes must not run expensive CI packaging.
2. **Representative device/network acceptance.** Exercise public-network direct
   and relay paths, two-room SFU, real-game A/V, twenty-Viewer endurance,
   sustained loss/recovery and all-UDP-blocked bounded failure. Correlate freezes
   with publisher/receiver evidence before changing representation policy.
   Physical Android/iOS work includes autoplay, background/lock, rotation,
   network migration and relay survival. Secondary desktop platform matrices
   remain explicitly deferred; compilation does not prove capture.
3. **Broader quality work.** Reopen from measured benefit at acceptable complexity.
   Preserve chosen profiles, bitrate ceilings, endpoint capacity and P2P-first
   routing unless a new accepted decision supports changing them. No weighted
   score, all-pairs probes, periodic rebalancing, parent-wide prediction or
   room-wide minimum. Check whether a quality move merely shifts pressure to
   another parent's siblings before widening policy.
4. **Control/resource fairness and input review.** Reassess the authenticated
   WebSocket/SFU owner, HTTP/body/resource bounds, authorization and error/log
   handling before adding a queue or limiter. No parallel security framework,
   accounts, risk score or speculative policy layer.
5. **Reachable ownership/refactor work.** Extract page media-session owners only
   alongside behavior changes; file size alone is not a rewrite reason. Reopen
   C=3 structural-intent retention, SFU failure during unrelated prepare and
   multi-child evidence ownership only with current-contract reproductions.
   No new revision namespace, failure-state mirror or topology queue by default.
6. **Storage fault recovery.** Ordinary transactions persist before memory
    changes; failures must preserve authority. Message-handler panics must unwind
    locks. Damaged-disk/COMMIT/ROLLBACK recovery is not established; choose its
    policy explicitly rather than adding catch-and-continue or retries.
7. **Platform output.** System/tab mirroring needs no adapter. Remote Playback,
    Cast and AirPlay do not provide a portable live MediaStream receiver.
    Reopen for a registered receiver acting as an ordinary Viewer after the
    [platform-output gate](./research/platform-output.md) passes.
