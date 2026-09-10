# Current TODO Ledger

Last reviewed: 2026-09-10

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

Finish the in-flight README/first-use corrections and homepage review, then
consolidate repository conventions before expanding the public website. The
owner accepted the general visual direction; keep App/Server behavior unchanged.
The website, domain and demo have not been published. Preserve the rename recovery
archive and external-audit worktree.

Inventory design, documentation, naming/coding rules, API contracts, frontend/
backend responsibilities and module boundaries. For each topic identify its
existing owner, callers and any conflicting or duplicated prescriptions. Merge
duplicate requirements into that owner and link from the shared documentation
entry; do not turn one giant document into a new source of coupling. Keep
accepted rules distinct from historical research and proposed changes. Trace
code before treating a wording mismatch as an implementation defect. Fix proven
low-cost inconsistencies; plan material contract or module changes separately.
The shared visual-language consolidation is the first example of this work.

Define the public version/compatibility policy in that same preparation pass.
Inventory App/Server release identity, build SHA, Web/native signaling and
capture protocols, persisted schema and room/route generations before choosing
their rules. Compare mature projects and primary specifications; decide whether
the first public release is `v1.0.0` or SHA-labelled, how an installed App and a
newer site negotiate support, and how incompatible upgrades are presented and
recovered. A release label, compatibility version and live generation are not
interchangeable counters. Preserve traceable build identity and establish one
documented compatibility promise; avoid coordinated resets, automatic broad
compatibility layers or data migrations before the policy is accepted. The
current pre-release single-contract rule still applies in the meantime.

Resume the [public introduction](./design/public-introduction.md), English/Chinese
guides and `site/` once this conventions pass is complete. Local preview and the
manual Pages workflow remain the baseline; publication is a separate step.

## Next — Awaiting Owner Direction

The owner owns **piik.tv**.
Review deployment feature switches, starting with an explicit P2P-only mode:
the operator must be able to disable SFU in configuration while retaining STUN,
room authority/signaling and P2P viewing. Current `SFU_UDP_PORT` already controls
SFU availability; inspect that contract and the forced-private-mode UI before
adding a second boolean with potentially conflicting meaning. Review which
other options belong to deployment configuration, runtime parameters or fixed
implementation constants. Keep this separate from public-facing documentation drafting.

The owner proposes GitHub Pages for the public website and the dedicated US
test server for a separate P2P-only demonstration site. Plan this after naming
and configuration review; no public demo is deployed yet. The existing private
production site remains private. P2P-only has no SFU fallback when direct/peer
paths cannot connect; the demonstration must describe that actual capability.

Choose public download assets and source visibility before enabling website
download links or publishing Pages. Keep the public introduction brief and
visual, with deeper detail in the linked developer guides. DNS/Pages and public
publication are separate from the private production service. Retain accurate
third-party names, notices and platform limitations.

Include the owner-requested frontend/backend ablation review in that phase.
Review duplicated behavior/state, module boundaries, interface clarity, lifecycle
ownership, cohesion and coupling. Reuse mature modules and stable shared behavior.
The primary goal is lower total complexity, not perfect performance: small gains
do not justify permanent mechanisms or larger maintenance cost. Preserve viewing
quality and product behavior; fewer lines alone do not justify a rewrite.

Use the App discovery and settings-ownership findings as leads for a
repository-wide lifecycle audit across Web UI, shared Go server, App and
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
