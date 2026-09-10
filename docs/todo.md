# Current TODO Ledger

Last reviewed: 2026-09-11

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

### Completed Phase: Repository Cohesion Audit

The static repository audit completed on branch `audit/repository-cohesion`.
`docs/research/repository-cohesion-audit-2026-09-11.md` owns the coverage map,
landed findings and verification. Landed: v23 evidence correction, test-only
route seeding moved to the route harness, duplicate CI Browser build removed,
historical commentary ablated, one shared visual-kind owner (17 cycles -> 0),
dead media-warning chain removed and injected route diagnostics. Deterministic
Web and Go checks pass.

One owner decision remains from this pass: media/peer layers persist localized
strings in snapshots, so a live language switch can leave stale copy until the
next media event. The root fix is a typed `{ key, detail? }` fact resolved by
the presentation layer across host/viewer peers, SFU routes and both pages; no
caller-level patch was applied. Keep this entry until accepted or dropped.

This audit does not replace physical mixed-version or target-package acceptance
from the lifecycle plan below.

Accept the current fixes and release-preparation changes together: Host
access/capability recovery, observable Native incompatibility, extensible
descriptive metadata, product version plus SHA, update comparison and queued
post-main publication. Existing resource owners and strict control commands stay
intact. Main and production retain their prior release; preserve the rename
recovery archive and external-audit worktree.

### Next Phase Plan: Lifecycle Audit And Candidate Acceptance

Review the pending implementation against its recorded candidate baseline
`ebea1c49`; keep canonical main unchanged during the audit. This is a bounded
review of Piik-owned runtime code and its adapters, not a rewrite or an audit of
every upstream dependency. Steps 1-3 are complete through `e36c7a34`: the
static/automated ownership audit, one confirmed source-switch quality repair and
its coverage record are in `docs/research/lifecycle-audit-2026-09-10.md`.
Steps 4-5, real mixed-version acceptance and target-package acceptance, remain.

1. Inventory every owning runtime area and its boundaries. Split read-only work
   across Browser/App orchestration, Server room/route/SFU effects, media/capture
   resource ownership, and interface/package/update contracts. Keep a coverage
   map with reviewed areas, findings and explicit unreviewed limits.
2. Trace acquisition, use, commit and retirement, including A replaced by B before
   A completes or cleans up. Prioritize discovery retry, authentication recovery,
   live settings/source replacement, App exit/restart, two Native sessions, room
   revocation during preparation, reconnect and repeated start/stop. Look for
   conflated permission/capability/readiness, failed-promise latches, stale writes,
   shared resources retired by one consumer, and cancellation treated as success.
3. Reproduce or prove concrete defects before editing. Fix the owning boundary,
   retain one focused check per meaningful repaired behavior, then remove newly
   unnecessary state/branches. Separate confirmed defects from documented costs
   and uncertain leads. Larger contract/media changes need their own justified
   decision; no generic lifecycle manager, quality heuristic or size-only split.
4. Exercise two real distinct builds with a deliberately supported common
   contract: older App/newer Site, newer App/older Site, and an open page across
   a compatible update. Different protocol versions are negative recovery checks,
   not authority to support stale private clients. Relabelled builds are not
   compatibility evidence; if no meaningful pair exists, record that limit.
5. Accept Windows App and Go Server candidates through the existing checks,
   including synthetic stored-room/config preservation and usable subsequent
   sharing. Rehearse the same local release scripts when Actions is unavailable,
   using dry-run publication and matching artifacts. Document the native-platform
   build prerequisites; do not pretend one Windows machine produces every App.

Finish when the coverage map accounts for the scoped owners, confirmed phase-core
P0/P1 failures are resolved, the selected candidate scenarios pass and remaining
limits are explicit. This does not establish universal compatibility or exhaustive
race/endurance coverage. Retain the owner's deferred macOS/Linux physical capture
and broad network matrices unless a concrete finding makes them relevant.
Then provide the Windows candidate for owner acceptance and one coherent PR;
merge/deployment/publication remain separate authorized delivery actions.

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

## Next — Awaiting Owner Direction

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

The lifecycle audit above follows [engineering review](./reference/engineering.md#ablation-and-review).
Its results determine repairs; search hits and file size alone do not authorize
a repository rewrite.

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
