# Current TODO Ledger

Last reviewed: 2026-09-10

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

Complete the confirmed Host access/capability recovery and Native discovery
repairs before version/workflow work. Preserve Browser operation, strict command
validation and the existing resource owners. Main and production retain their
prior release; keep this phase together and preserve the rename recovery archive
and external-audit worktree.

Before declaring a public release, implement the readiness work owned by
[versioning](./reference/versioning.md#first-public-release-readiness): product
version plus SHA in the existing release pipeline, SemVer-aware update readers
and actual mixed-version checks. Discovery mismatch and descriptive metadata
handling are implemented; full public compatibility is not established. Do not
reset storage or live authority generations or publish a first release implicitly.

After these fixes, decide the owner-requested post-merge automation: a complete
PR merged to main computes the release version, builds and publishes through one
pipeline without version-record commits back to main. Use commit/PR semantics
to express compatible fixes, features and breaking public changes. Protect main
as PR-only when GitHub account/repository visibility permits it (the current
private free repository rejects branch protection/ruleset APIs). Finish the
held template/naming drafts then; no repository settings or release automation
have been activated. Website/README expansion follows this work.

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

The repository-wide lifecycle and ablation audit remains broader than this
documentation/contract-map pass. Use [engineering review](./reference/engineering.md#ablation-and-review)
and the App-discovery/settings failures to find:

- Permission, activation, capability, readiness and operation ownership conflated.
- Failed promises/resources cached beyond their lifetime.
- Obsolete async completion or cleanup modifying a replacement operation.
- Cancellation, failure or absence interpreted as success.
- Shared resources acquired too early, retained unused or retired by one consumer.
- Draft/requested/applied settings or duplicated presentation writers overwriting
  the current authority.

Search hits are leads. Trace real acquisition, use, commit and retirement,
including A replaced by B before A finishes; fix proven owning boundaries.
Keep uncertain observations separate from repairs. No generic manager, extra
state machine or repository rewrite follows from a wording mismatch.

[Verification status](./verification-status.md) owns remaining device/network
limits, including iOS playback/window/audio behavior. NAT and Auto are complete
features; broader statistics are not a new blocker. Keep packaging manual,
branch CI quiet, physical workloads serial and executables at stable paths.

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
