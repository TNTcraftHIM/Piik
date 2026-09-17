# Current TODO Ledger

Last reviewed: 2026-09-17

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

No implementation work is currently scheduled. Reporter/device follow-ups and
evidence-dependent work remain below.

## Awaiting Device Or Reporter Evidence

- [ ] **Brief connection followed by repeated Viewer loss on v1.5.0.** One
  Viewer reportedly drops just after connection details appear, while other
  Viewers work; App public-link mode is suspected. Check signaling, first-frame
  admission and current-edge recovery separately. A delayed-confirmation
  reproduction establishes one premature candidate replacement; the affected
  environment and paired diagnostics are still unavailable, so the reporting
  machine's cause remains unconfirmed.
- [ ] **App source-discovery field acceptance.** Retest the missing-window report
  with the current App and page. Obtain OS/browser, version and paired Debug
  reports to distinguish discovery, capture capability and enumeration failures.
  Local permission and recovery checks do not establish the reporting machine's
  cause.
- [ ] **Windows 32-bit candidate acceptance.** Verify the isolated
  `spike/windows-x86-capture` candidate's launch, capture/audio, memory pressure,
  source replacement and update links on a 32-bit Windows device. WOW64
  Host/media checks establish only that environment. Reconcile its scoped
  SDK/toolchain and atomic-alignment changes with current main when accepted;
  the experiment is not part of this maintenance release.
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
   Before using the optional `viewer-mbb` benchmark canary, align its injected
   evidence and capacity assertions with the current sender-owned quality
   contract; its old Viewer-only trigger is not a valid quality acceptance gate.
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
   candidate. Reopen C=3 structural-intent retention and multi-child evidence
   ownership only with current-contract reproductions.
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
9. **Windows code signing.** Revisit after enrollment in a trusted signing
    service. Sign Piik's executables before archive checksums are computed;
    signing improves publisher identity but does not guarantee that antivirus
    cloud scanning stops. Service selection and enrollment remain pending.
10. **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
    and retain Gitee; do not add a self-hosted mirror. Chrome still blocks the
    Gitee attachment when Referer is removed. Reopen for new evidence or a
    provider review; the warning remains unresolved.
