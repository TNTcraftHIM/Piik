# Current TODO Ledger

Last reviewed: 2026-09-10

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

Finish the owner-authorized PR386 squash, matched Web/Client/Server cutover and
cleanup, then resume Piik appearance. Entry/Client lifecycle repairs, confirmed
reconnect ownership fixes and the permanent-room/Hosted SQLite-default revision
are implemented and verified. Product modules and
[ADR-0002](./adr/0002-memory-resident-protected-rooms.md) own that accepted behavior.

Use the [coordinated cutover](./deployment.md#permanent-room-schema-cutover) to
preserve existing SQLite authority and unchanged Browser credential keys; old
active pages reload at the signaling v23 boundary. Runtime release metadata and
the operator record own deployment completion. Do not recreate databases or
add a replacement garbage collector. Later manual feedback is nonblocking.

## Next — Awaiting Owner Direction

1. Resume the [Piik brand study](./design/piik-brand.html) after the experience
   repairs. Keep round i dots; the tiny-e experiment was rejected. Try using the
   two outer stems as small headphones/earcups on the TV, retaining its familiar
   silhouette and the k diagonals as antennae. Display `Piik` and technical
   `piik` remain proposals. Settle identity before coordinated renaming or the
   public-site implementation.
2. After the brand discussion, rename display copy, Go/npm source identity,
   Client/Server packages and OS icons, strict protocol/service identifiers,
   diagnostic redaction, configuration and deployment tooling in one coordinated
   phase. Inventory is complete. Browser storage contains room authority/grants
   and Client configuration contains a saved Site; decide preservation/reset
   explicitly before renaming their keys or directories. Preserve SQLite room
   authority when changing deployment paths. Use matching Web/Client/Server
   artifacts and one current reader/writer, without compatibility aliases.
   Keep third-party names/notices and historical evidence attribution accurate.

The owner owns **piik.tv**.
Agree on casing, TV mascot/wordmark treatment, repository and runtime identifiers,
release names and the GitHub Pages website before implementing the rename.
Keep one current internal contract and remove replaced names in the coordinated
change; no private compatibility aliases. Existing sketches are input, not an
accepted identity. Do not configure DNS/Pages or publish the brand before that
design discussion. The private production service is not a public demo.

Include the owner-requested frontend/backend ablation review in that phase.
Review duplicated behavior/state, module boundaries, interface clarity, lifecycle
ownership, cohesion and coupling. Reuse mature modules and stable shared behavior.
The primary goal is lower total complexity, not perfect performance: small gains
do not justify permanent mechanisms or larger maintenance cost. Preserve viewing
quality and product behavior; fewer lines alone do not justify a rewrite.

Use the Client discovery and settings-ownership findings as leads for a
repository-wide lifecycle audit across Web UI, shared Go server, Client and
media adapters. This is future work, not an expansion of the current entry fix.
Look for these recurring patterns:

- Permission, remembered activation, capability, connection readiness and live
  operation ownership represented by the same flag or inferred from UI state.
- Cached promises retaining `null`, rejection or a closed resource indefinitely;
  failure latches whose lifetime exceeds the evidence that justified them.
- Results after `await`, callbacks and `finally` writing shared state or closing
  the current resource without checking the original operation/resource owner.
- Cancellation, failure and absent observation sharing a return value that a
  caller interprets as success; review the complete caller chain.
- Connections, slots, listeners and queues acquired before actual demand, kept
  after their consumer ends, or retired while another consumer still owns them.
- Draft, requested, applied and server-acknowledged settings overwriting one
  another; duplicated writers or status models that can contradict real media.

Search results are leads, not defect evidence. Trace acquisition through use,
commit and retirement, including error paths and shared consumers. Reproduce
representative interleavings: A starts, is cancelled/replaced, B starts, then A
completes or fails. Check both obsolete writes and obsolete cleanup, plus
stop/restart and transient-failure recovery. Fix the owning boundary and remove
redundant state rather than add case-specific flags, timers or a generic manager.
Keep confirmed repairs separate from documented tradeoffs and unsupported
suspicions; retain only focused checks that demonstrate a meaningful failure.

English/Chinese Quick Start, documentation map and license guidance are prepared.
Keep the README short and friendly, with the logo and a small usage illustration;
detailed deployment/development guidance belongs in the linked guides. Draft a
static GitHub Pages homepage with tutorials and self-contained demonstrations
matching the living-room UI. Review final release assets, update/replacement
guidance and public distribution alongside the new brand; existing packagers and
Docker recipe are the baseline.
Keep expensive packaging manual and branch CI quiet. No broad media redesign is
part of naming or documentation work.

[Verification status](./verification-status.md) owns broader physical limits.
NAT and Auto are complete features; further statistical/hardware research is not
required to finish this phase. Run any new physical workload serially, with stable
executable paths and cleanup before the next.

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
   public asset set and release notes before publishing a full-SHA GitHub Release
   or image. Do not add automatic installation, container self-update, Watchtower,
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
