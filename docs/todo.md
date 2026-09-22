# Current TODO Ledger

Last reviewed: 2026-09-22

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

- [ ] **Passive App attachment: design hold.** Site mode authorizes one selected
  origin and supplies native media without starting a local room server. A
  passive replacement needs an accepted site-consent/discovery flow; it must not
  admit arbitrary sites or add another runtime owner. Keep Site mode until that
  decision; removal of the Demo prefill does not authorize changing site trust.
- [ ] **Complete manual accessible-name review.** Verify the empty video's
  screen-reader output: Chromium exposes an unavailable-media
  description despite the literal shared-picture label and no media error. Also
  review accessible naming on disabled tooltip wrappers and the UI catalogue's
  paired-character example; automated checks leave those for manual review.
- [ ] **Refine the isolated room-interaction prototype.** Review chat, optional
  danmaku and participant-targeted reactions for usability, placement and intended
  cross-view synchronization. Preserve room authorization and media-route owners.
  Accept its combined layout: sharing settings with the picture, wide-screen chat
  beside participants, stacked chat on narrow screens and room actions before
  diagnostics. Check its theater chat entry and participant menu on real devices;
  keep chat available independently of sharing.
  Retain current room creation: the first share creates a room, an existing room
  can resume, and stopping media keeps the opted-in interaction session. Do not
  add visit-triggered creation or a separate pre-share room-creation entry.
  This experiment does not authorize integration or publication.

## Awaiting Device Or Reporter Evidence

- [ ] **No available media route.** Obtain matched Host/Viewer diagnostics from
  a failed attempt, with version and mode. Inspect candidate exchange, selected
  paths, first-frame admission and route rejection separately. The Browser
  candidate-queue rejection defect is repaired and regression-tested; current
  STUN reachability and route-lifecycle checks do not establish these reporters'
  causes. HTTP 1033 belongs to the public-link item below, before media routing.
- [ ] **Camera and Host microphone device coverage.** The owner accepted the
  sharing layout and authorized release with these physical limits recorded.
  Verify real audio levels/echo, multiple-device replacement and native mixing on
  target systems, plus phone camera permission, orientation and background use.
  Keep the existing capture and route owners. The
  [capture assessment](./research/camera-and-microphone.md) owns behavior and
  separates bounded Windows/browser checks from untested device combinations.
- [ ] **App public-invitation startup field acceptance.** Retest the frequent
  creation-failure report and the earlier
  [#396 timeout](https://github.com/TNTcraftHIM/Piik/issues/396#issuecomment-5691465700)
  with the updated App. A controlled UDP-blocked/TCP-available reproduction confirms
  a dependency configuration defect; the existing tunnel now uses cloudflared's
  bounded protocol fallback. [Runtime evidence](./research/cross-platform-client-runtime.md#public-invitation-startup)
  separates this fix from DNS, provider and remote access failures. The reporting
  environments still need version and diagnostic evidence before assigning a cause.
  Demo access failures and public-link HTTP 1033 also remain unconfirmed: current
  Demo health/assets and an external-host public-link HTTP/WebSocket gate pass.
  Check connector reachability separately from WebRTC media availability.
- [ ] **Interruption during established viewing.** A Viewer reportedly returns
  to P2P connecting after watching for a while. Native receiver renegotiation,
  retired event delivery and SFU replacement have locally reproduced defects
  and regression checks, but paired diagnostics and device/network details are
  still needed to establish this reporter's cause. Include an upstream relay's
  report when present. The existing five-second Viewer membership grace during
  signaling loss is unchanged. This is distinct from the first-frame report below.
- [ ] **Windows 11 capture border remains visible.** Identify the App/Browser
  capture path, Windows build and capture-border permission result. Local checks
  reproduced a border surviving forced process termination; parent cancellation
  now uses bounded graceful retirement. [Capture evidence](./research/native-client-lifecycle.md#windows-capture-borders)
  verifies the repair and concurrent-capture behavior on Windows 11. The
  reporter's cause remains unconfirmed; check consent and other active captures.
- [ ] **Brief connection followed by repeated Viewer loss on v1.5.0.** One
  Viewer reportedly drops just after connection details appear, while other
  Viewers work; App public-link mode is suspected. Check signaling, first-frame
  admission and current-edge recovery separately. A delayed-confirmation
  reproduction establishes one premature candidate replacement; the affected
  environment and paired diagnostics are still unavailable, so the reporting
  machine's cause remains unconfirmed.
- [ ] **App discovery and share-start field acceptance.** Retest the missing-window
  report, an unreachable App despite its process running, and generic share-start
  failure with the current App and page. OS/browser, version, selected source and
  paired Debug reports are still unavailable. Distinguish site authorization,
  browser permission, control capacity, enumeration and capture-start failures;
  local permission and recovery checks do not establish the reporters' causes.
  Manual H264 returning immediately to idle also needs reporter diagnostics;
  bounded selection past an unusable hardware encoder is locally verified.
- [ ] **Windows 32-bit candidate acceptance.** Verify the isolated
  `spike/windows-x86-capture` candidate's launch, capture/audio, memory pressure,
  source replacement and update links on a 32-bit Windows device. WOW64
  Host/media checks establish only that environment. Reconcile its scoped
  SDK/toolchain and atomic-alignment changes with current main when accepted;
  the experiment is not part of this maintenance release.
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
7. **Additional languages.** Review community catalogs and their rendered UI
   following the [translation guide](./guide/translating.md). Add website,
   documentation or App console translations as contributed; verify text
   direction and layout when a language requires it. Check contributed language
   names and rendered menu navigation when registering a new catalog.
8. **Windows code signing.** Revisit after enrollment in a trusted signing
    service. Sign Piik's executables before archive checksums are computed;
    signing improves publisher identity but does not guarantee that antivirus
    cloud scanning stops. Service selection and enrollment remain pending.
9. **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
    and retain Gitee; do not add a self-hosted mirror. Chrome still blocks the
    Gitee attachment when Referer is removed. Reopen for new evidence or a
    provider review; the warning remains unresolved.
10. **4K in advanced sharing settings.** Deferred until after the current capture
    maintenance phase. Add 3840x2160 without changing the default or recommended
    presets. Extend the existing capture, decode and relay bounds together; verify
    H.264 level negotiation for 4K at 60 fps. Current strict quality messages reject
    `2160p`, so preserve published Browser/App/Server compatibility through explicit
    receiving-end support before exposing or sending the new setting. Include
    source replacement, lower outputs and resource limits in acceptance.
