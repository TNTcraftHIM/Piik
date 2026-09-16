# Current TODO Ledger

Last reviewed: 2026-09-16

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

- [ ] **Windows capture border preference.** After the current release, investigate
  [#401](https://github.com/TNTcraftHIM/Piik/issues/401) with the packaged Native
  helper. Verify Windows' permission-based `GraphicsCaptureAccess` /
  `IsBorderRequired` flow and the available or denied cases before choosing a
  setting. Keep ordinary capture working; Browser capture indicators remain
  browser-owned.
- [ ] **App/Browser source discovery and feedback.** Investigate the report of
  missing window sources; confirm the exact message, screen, OS/browser and App
  version. The custom selector currently renders both App unavailability and a
  successfully loaded empty list as "No sources available". Distinguish these
  outcomes using facts from the existing discovery/capture owners. Check prior
  site activation versus a fresh Browser profile, configured-origin matching,
  local-network permission timing (including the 400 ms discovery deadline),
  protocol mismatch, occupied control sessions, helper/encoder capabilities and
  source-list failures. Compare startup-only probing with list refresh and App
  restart recovery; keep Browser capture usable and local media-bridge failures
  separate. A generic fetch
  failure cannot prove a permission denial. Confirm the reporting machine's
  cause before claiming resolution.
- [ ] **Linux output failure boundary.** Run the wired `build.sh --check` on a
  supported Linux runner, including encoder admission and primary error checks.
  Then verify and isolate output-local encoder failures while retaining fatal
  shared source/engine errors. Windows checks do not establish this boundary.
- [ ] **Post-launch monitoring.** Collect App/Server feedback and verify the
  public downloads, container pulls and deployed services after product releases.
  Follow the [deployment runbook](./deployment.md) for the private service and keep public
  demo deployment separate. Preserve the owner's
  [device/network deferrals](./verification-status.md#candidate-evidence-boundary).
- [ ] **Public invitation startup timeout.** The reporter in
  [#396](https://github.com/TNTcraftHIM/Piik/issues/396#issuecomment-5691465700)
  confirmed Local startup is fixed, but separately reported that the public
  invitation service did not connect within 30 seconds. Trace tunnel startup,
  network reachability and the existing timeout/error feedback using a current
  Debug report; the Local fix does not establish this separate failure's cause.
- [ ] **Windows launcher exit after opening the page.** A user reports that the
  mode-selection page opens, then the App console reports
  `Piik App could not open its launcher: exit status 0xc0000005`.
  Recheck on the reporting machine after the browser-handoff repair. The Windows
  URL-handler crash itself still needs the affected build and process/dump
  evidence; local checks cannot establish its underlying cause.

Keep fixes on a maintenance branch until acceptance. The public release is the
compatibility baseline; private service deployment stays independent.

## Next: P2P Connection And Feedback Evidence

After the current phase, measure connection success, time to first picture and
failure causes on representative networks, especially App and P2P-only sites.
Use existing Debug provenance and selected-path events before adding runtime
counters. Separate emitted candidates, actual connection attempts, successful
paths and timeouts; keep observations scoped to connection generations and
exclude raw endpoints. Establish survey response visibility without treating
local listener binding as proof of public reachability. The
[NAT evidence](./research/nat-traversal.md#gateway-and-survey-limits) owns the
dependency and observation limits. Compare current P2P/SFU handoffs, including
background P2P attempts behind working SFU media, before choosing changes.
Preserve one graph and one operation under the
[routing contract](./standards/routing-transport.md) and
[ADR-0005](./adr/0005-automatic-hybrid-media-routing.md). Prior ownership audits do
not establish better connection success or speed; this note adds no retry policy.

## Parked Product Work

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
   [engineering review](./standards/engineering.md#ablation-and-review); file
   size alone does not justify a split. The completed audits do not close this
   candidate. Reopen C=3 structural-intent retention, SFU failure during unrelated
   prepare and multi-child evidence ownership only with current-contract
   reproductions.
   When related behavior changes, compare the Browser/Native recovery budget;
   preserve Native bridge versus network failure distinctions when sharing code.
   No new revision namespace, failure-state mirror or topology queue by default.
5. **Storage fault recovery.** Choose and verify a damaged-disk/COMMIT/ROLLBACK
   recovery policy before adding catch-and-continue or retries. This failure
   boundary remains unestablished after ordinary persistence checks.
6. **Platform output.** Reopen for a registered receiver acting as an ordinary
   Viewer only after the [platform-output gate](./research/platform-output.md)
   passes.
7. **Full UI themes.** After the base version, research themes that can change
   layout, composition and motion, including a restrained graphic/cinematic
   direction with original Piik assets. Assess extension boundaries and cost
   before scheduling any theme/plugin API. Design experiments remain in Git
   history, outside the main source tree.
8. **Additional languages.** Review community catalogs and their rendered UI
   following the [translation guide](./guide/translating.md). Add website,
   documentation or App console translations as contributed; verify text
   direction and layout when a language requires it. Check contributed language
   names and rendered menu navigation when registering a new catalog.
9. **32-bit App packages.** Deferred until suitable native capture dependencies
    are available. Windows x86 core compilation alone does not establish App
    support: the pinned capture SDK currently has no Windows x86 package.
    Complete native packaging and real launch/capture acceptance before
    advertising a 32-bit target.
10. **Windows code signing.** Revisit after enrollment in a trusted signing
    service. Sign Piik's executables before archive checksums are computed;
    signing improves publisher identity but does not guarantee that antivirus
    cloud scanning stops. Service selection and enrollment remain pending.
11. **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
    and retain Gitee; do not add a self-hosted mirror. Chrome still blocks the
    Gitee attachment when Referer is removed. Reopen for new evidence or a
    provider review; the warning remains unresolved.
