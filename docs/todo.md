# Current TODO Ledger

Last reviewed: 2026-10-02

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

- [ ] **Authorized release delivery.** The owner accepted the room-interaction
  phase, complete bilingual release notes and bounded acceptance, and authorized
  v1.7.0 publication. Follow
  [the integration workflow](../CONTRIBUTING.md#full-integration-and-release-workflow)
  for one squash merge, packaging, publication and scoped postflight. Release
  artifacts and operator records own completion; do not add a release-record
  commit. No implementation work remains open for this phase.

## Held By Owner

- [ ] **Browser-internal encoder work.** Paused by the owner on 2026-10-01.
  [Comparisons and Chromium traces](./research/browser-local-encoding-pool.md#sustained-h264-recovery)
  own the evidence for synchronous H264 initialization, native adaptation and
  the unbuilt upstream repair candidate. Keep the verified Piik budget and
  handoff repairs; do not add periodic resets, a quality floor or a Browser fork.
  The field room's cause and all brief blur are not established as resolved.

## Deferred Feature Work

These proposals remain deferred beyond the accepted interaction phase.

- [ ] **Passive App attachment: design hold.** Site mode authorizes one selected
  origin and supplies native media without starting a local room server. A
  passive replacement needs an accepted site-consent/discovery flow; it must not
  admit arbitrary sites or add another runtime owner. Keep Site mode until that
  decision; removal of the Demo prefill does not authorize changing site trust.

## Awaiting Device Or Reporter Evidence

- [ ] **HDR, audio-exclusion and mobile interaction device coverage.** Complete
  the remaining physical checks in
  [verification status](./verification-status.md#candidate-evidence-boundary):
  real HDR/mixed displays under load, real voice-app process trees across playback
  devices, and phone keyboard/theater/participant-menu interaction. Local GPU,
  decoded-video, synthetic audio and responsive-browser evidence do not cover
  those environments. Issues [#420](https://github.com/TNTcraftHIM/Piik/issues/420)
  (Browser HDR) and [#445](https://github.com/TNTcraftHIM/Piik/issues/445)
  (Windows 10 colors) still need matched capture evidence; do not assign them
  the locally reproduced Native conversion defects.
- [ ] **Native H.264 motion quality (#432).** The original 720p30 H.264/VP8
  visual comparison remains unresolved. Browser evidence confirms similar
  delivered bitrate/format and zero reported loss, but contains no matched
  pictures or bitstream. The reporter withdrew the fixture-contaminated CBR
  ceiling claim. [Evidence review](./research/native-client-media.md#native-h264-motion-quality)
  owns that distinction. Reproduce with identical content and unchanged
  production settings before proposing profile, default-FPS or bitrate changes.
- [ ] **Self-hosted room creation HTTP 403.** Retest affected deployments using
  the [address checks](./guide/troubleshooting.md#room-creation-returns-403).
  Obtain the configured public address/origin and response details; distinguish
  Piik's rejection from a proxy/WAF 403 before assigning their cause.
- [ ] **No available media route.** A decline is reported since around v1.4;
  establish comparable attempts on the same endpoints/network before attributing
  a version regression. Obtain matched Host/Viewer diagnostics from
  a failed attempt, with version and mode. Inspect candidate exchange, selected
  paths, first-frame admission and route rejection separately. A v1.6.3 App
  report has candidate timeouts without share-start or SDP/ICE; obtain Browser
  evidence before calling that an ICE/NAT failure. HTTP 1033 belongs to the
  public-link item below, before media routing. Local fixes and STUN checks do
  not establish these reporters' causes.
  [#443](https://github.com/TNTcraftHIM/Piik/issues/443)'s Host report reaches Native
  prepare/answer/candidate processing without a connected remote edge; obtain
  the same attempt's Viewer and App transport reports to locate the failure.
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
  with version and matched diagnostics. Compare against the bounded checks in
  [runtime evidence](./research/cross-platform-client-runtime.md#public-invitation-startup).
  Demo access failures and public-link HTTP 1033 also remain unconfirmed; check
  connector, DNS/provider and remote access separately from WebRTC availability.
  [#434](https://github.com/TNTcraftHIM/Piik/issues/434)'s attached log records DNS
  refusal during Cloudflare edge discovery, before readiness; retrying media
  cannot repair that resolver failure. Do not assign it to every startup report.
- [ ] **Interruption during established viewing.** A Viewer reportedly returns
  to P2P connecting after watching for a while. Include
  [#429](https://github.com/TNTcraftHIM/Piik/issues/429)'s reported SFU-to-P2P
  dropout in field acceptance of candidate-commit recovery. Obtain paired
  diagnostics, device/network details and any upstream relay's report; confirmed
  local repairs are not matched causes of these reports. Distinguish established
  viewing from the first-frame report below and signaling membership grace.
  Locally verified per-edge signaling and committed SFU recovery repairs do not
  establish a matched cause for these reporters.
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
  failure. Distinguish site authorization, browser permission, control capacity,
  enumeration and capture startup. The v1.6.5 report reaches Auto-to-VP8 startup
  after an MFT timeout, then Browser `stop-share` before any local-edge request;
  it does not prove a no-frame timeout. Obtain the Browser exception, loaded
  assets and actual VP8 output. Controlled connection exhaustion reproduces the
  sequence but does not establish a Piik leak or this reporter's cause.
  [#419](https://github.com/TNTcraftHIM/Piik/issues/419)'s AMD manual-H264 failure
  also needs paired evidence; distinguish activation, codec configuration and
  actual output before changing the encoder contract. Local NVIDIA success
  does not settle AMD activation.
  In [#437](https://github.com/TNTcraftHIM/Piik/issues/437), both manually selected
  codecs reportedly work; its Browser report records Auto startup returning
  `operation-failed` after 6.85 seconds, before the request timeout. Obtain the
  same attempt's App diagnostics to locate selection/activation failure.
- [ ] **Share ends after entering a game.** Screen sharing reportedly works
  until entering a game freezes the picture, followed seconds later by share
  termination. Version, capture path, codec and matched diagnostics are unknown.
  Locate the first capture/output, preview-bridge, control or authority failure;
  distinguish ordinary source silence/resize from target replacement, exclusive
  fullscreen, display-mode change and device loss. Compare with
  [capture research](./research/native-client-lifecycle.md#quiet-sources-and-viewer-recovery);
  do not conflate source silence, receiver decode interruption and capture-process
  failure, or assign the reported Host termination to a repaired Viewer defect.
  An input accepted by hardware without matching output within its two-second
  deadline fails the original output and can end a native Windows share. This
  is a candidate mechanism, not evidence that ordinary source silence or this
  reporter's game caused an encoder failure.
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
- [ ] **System becomes very laggy after starting a share.** Obtain mode, actual
  codec, profile, display refresh rate and CPU/GPU use, distinguishing startup
  from sustained lag. Auto's local selection checks and NVIDIA success do not
  establish this reporter's cause. The bounded
  [helper-cost checks](./research/native-client-media.md#windows-helper-cost-2026-09-29)
  found no justified allocation/cadence change and no capture termination on the
  tested NVIDIA machine. Saturated GPU/game-FPS impact, multi-output recovery
  cost and the reporter's environment remain unmeasured; software encoding cost
  alone is not a diagnosis.

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
   The [Browser pool comparison](./research/browser-local-encoding-pool.md#balanced-startup-and-recovery)
   records a cold-encoder adaptation tradeoff; a low resolution by itself is not
   a defect or active repair target. Prioritize avoidable interruptions, failed
   recovery or degradation of healthy siblings when evidence establishes them.
   Preserve chosen profiles, bitrate ceilings, endpoint capacity and P2P-first
   routing unless a new accepted decision supports changing them. No weighted
   score, all-pairs probes, periodic rebalancing, parent-wide prediction or
   room-wide minimum. Check whether a quality move merely shifts pressure to
   another parent's siblings before widening policy.
3. **Signaling execution model.** Measure signaling-lock contention, synchronous
   persistence, presence fan-out, diagnostic I/O and cross-room password-work
   fairness before changing the lock or execution model; their cost remains a tradeoff.
   No parallel security framework, accounts, risk score or speculative policy layer.
4. **Reachable ownership/refactor work.** Retain Host/Viewer page media-session
   extraction as a candidate alongside related behavior changes. Evaluate clear
   resource owners, fewer shared writers and a smaller change surface under
   [engineering review](./standards/engineering.md#ablation-and-review); file
   size alone does not justify a split. The completed audits do not close this
   candidate. Evaluate a per-share Host resource owner and a Viewer route owner
   only with related behavior changes; fewer page-local refs alone do not prove
   a simpler lifecycle. Reopen C=3 structural-intent retention and multi-child evidence
   ownership only with current-contract reproductions.
   When related behavior changes, compare the Browser/Native recovery budget;
   preserve Native bridge versus network failure distinctions when sharing code.
   No new revision namespace, failure-state mirror or topology queue by default.
   Native Host loopback media failure currently ends the share, although Native
   publication has its own source. The loopback stream also supplies Browser
   quality candidates and gates quality/SFU updates; simply ignoring its failure
   leaves dead consumers. Review those owners and the track-ended handler before
   changing recovery. This is not an established cause of the game-entry report.
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
10. **4K in advanced sharing settings.** Hold the isolated candidate for joint
    review with the next room-interaction release; its compatibility and release
    boundary are not yet accepted. Add 3840x2160 without changing the default or recommended
    presets. Extend the existing capture, decode and relay bounds together; verify
    H.264 level negotiation for 4K at 60 fps. Current strict quality messages reject
    `2160p`, so preserve published Browser/App/Server compatibility through explicit
    receiving-end support before exposing or sending the new setting. Include
    source replacement, lower outputs and resource limits in acceptance.
11. **Release-operation policy.** Protected release environments, immutable
    draft assets and changing mirror-failure policy remain unaccepted proposals;
    evaluate their benefit before adding release machinery.
12. **Linux ARM64 Server distribution (#439).** Evaluate archives and container
    publishing together with deployment names, update links and runtime checks.
    A cross-compile alone does not establish a supported package. This is a
    community proposal, not part of the current accepted candidate.
