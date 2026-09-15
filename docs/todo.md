# Current TODO Ledger

Last reviewed: 2026-09-15

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

- [ ] **Introduction motion and presentation boundaries.** Resolve the automatic
  hero-loop control requirement against the accepted design without restoring
  discarded gesture controls or silently removing animation. Review only the
  remaining concrete layout/accessibility choices; distinguish decorative content
  from functional symbols. Keep independent correctness repairs moving.
- [ ] **Post-launch monitoring.** Collect App/Server feedback and verify the
  public downloads, container pulls and deployed services after product releases.
  Follow the [deployment runbook](./deployment.md) for the private service and keep public
  demo deployment separate. Preserve the owner's
  [device/network deferrals](./verification-status.md#candidate-evidence-boundary).
- [ ] **App startup feedback.** Verify [#396](https://github.com/TNTcraftHIM/Piik/issues/396)
  against the current release. Its older build predates the LAN selector,
  detailed launcher errors and Windows error-exit pause; those repairs do not
  establish resolution on the reporting machine. Use a current Debug report if
  startup still fails.
- [ ] **Windows launcher exit after opening the page.** A user reports that the
  mode-selection page opens, then the App console reports
  `Piik App could not open its launcher: exit status 0xc0000005`.
  Recheck on the reporting machine after the browser-handoff repair. The Windows
  URL-handler crash itself still needs the affected build and process/dump
  evidence; local checks cannot establish its underlying cause.
- [ ] **Tooltip placement around video.** After the current motion/meaning
  acceptance, review placement that keeps the picture visible, including
  side placement and restrained translucency. Keep neighbouring actions
  reachable when a help popup remains open. Current behavior prefers above
  (below for header controls) and flips for viewport space. Discuss the design
  before changing placement rules.

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
[routing contract](./product/routing-transport.md) and
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
   [engineering review](./reference/engineering.md#ablation-and-review); file
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
   direction and layout when a language requires it. Before registering the
   first extra UI language, fix the overflow menu's placement near the viewport
   bottom: it currently permits zero content height. Check native popover
   expanded/collapsed accessibility state with the rendered menu.
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
12. **Windows capture border preference.** [#401](https://github.com/TNTcraftHIM/Piik/issues/401)
    requests an optional borderless capture mode. First verify Windows'
    permission-based `GraphicsCaptureAccess` / `IsBorderRequired` flow with the
    packaged Native helper; keep ordinary capture working when unavailable or
    denied. Browser capture indicators remain browser-owned. No new setting is
    accepted yet.
