# Current TODO Ledger

Last reviewed: 2026-10-11

The current 2.0 preparation includes independent investigation across this
ledger. Explicit owner holds remain in force; an investigation does not itself
accept a new feature or architecture. A missing device or reporter trace blocks
only that evidence claim, not unrelated work. Product modules own behavior;
Git/PRs own completed history.

## Now

- [ ] **2.0 candidate preparation and acceptance.** The owner reopened investigation,
  useful improvements and outstanding acceptance on 2026-10-07, and on 2026-10-09
  chose to hold the maintenance changes for 2.0 rather than publish them separately.
  Prepare one coherent candidate and stop before publication. Preserve the existing
  product model; evaluate held features against measurable benefit and total complexity
  before accepting a changed contract.
- [ ] **Linux Portal target identity acceptance (#470).** The
  [contributor fix](https://github.com/TNTcraftHIM/Piik/pull/470) is integrated
  with authorship retained: serial and node-ID targeting remain distinct.
  Candidate compilation and headless targeting checks pass. Verify an actual
  Portal that omits `pipewire-serial`; the headless check does not exercise
  desktop capture.
- [ ] **Reconcile open PRs with the final candidate.**
  [#462](https://github.com/TNTcraftHIM/Piik/pull/462)'s 256/320 kbps request and
  [#469](https://github.com/TNTcraftHIM/Piik/pull/469)'s 4K request overlap the
  numeric-media candidate; neither PR has been merged. 4K60 is included in
  candidate admission, alongside the tested wider video control range, and still
  needs physical device/network acceptance. Preserve
  contributor credit and explain the disposition at integration. Rewrite
  [#459](https://github.com/TNTcraftHIM/Piik/pull/459)'s earlier maintenance scope
  and compatibility claims around the final 2.0 result before integration.
- [ ] **Independent Gitee mirror recovery.** Implementation and local acceptance
  are complete. Integrate through the next owner-approved publishing merge and
  verify the separate workflow with its original CI artifacts. Mirror failure
  must remain visible without blocking product CI or Website delivery.

## Held By Owner

- [ ] **Magicsock adoption: no-go for this candidate.** Its direct-path
  augmentation requires App transport at both ends and does not improve the
  core App-to-Browser edge. Stop product integration, combined packaging and
  Magicsock field-test recruitment. Retain isolated evidence in Git; preserve
  independently verified ordinary ICE/media repairs. The
  [assessment](./research/nat-traversal.md#integration-cost-and-recovery-controls)
  owns the rationale. Reopen only for a concrete Browser-compatible benefit
  with acceptable complexity, or a newly accepted App-only product scope.

- [ ] **Browser-internal encoder work.** Paused by the owner on 2026-10-01.
  [Comparisons and Chromium traces](./research/browser-local-encoding-pool.md#sustained-h264-recovery)
  own the evidence for synchronous H264 initialization, native adaptation and
  the unbuilt upstream repair candidate. Keep the verified Piik budget and
  handoff repairs; do not add periodic resets, a quality floor or a Browser fork.
  The field room's cause and all brief blur are not established as resolved.
- [ ] **32-bit Windows/Linux Apps.** Deferred by the owner on 2026-10-02;
  no package or website option is planned. Browser use remains available where
  the OS/browser supports the required media APIs. Retain the isolated
  Git evidence for the Windows x86 capture experiment; revisit its native dependencies,
  atomic alignment and real 32-bit device coverage only if this work is reopened.
- [ ] **Windows ARM64 App.** Deferred by the owner on 2026-10-03. Keep Windows
  App packages and website downloads x64-only until this work is reopened.

## Feature Assessments

Assess these proposals against the owner's benefit/complexity condition.
Existing negative results narrow the next experiment; they do not freeze the
whole candidate or require another version-number decision before other work.
Implementation needs a concrete useful result within the product model.

- [ ] **Media parameters and capabilities for 2.0.** Follow the
  [media assessment](./research/native-client-media.md#media-capability-extension-assessment):
  separate UI presets, numeric requests, bounded implementation capabilities and
  actual output. Numeric request, capability and observation boundaries are now
  separate from implementation admission. Keep receiver, codec/alignment and
  resource budgets intact; opening an output range still needs end-to-end evidence.
  The inherited menu-only source range is replaced by 1..60 fps / 0.1..50 Mbps,
  with coherent lower-output bounds and actual-progress preflight. Local
  production-codec, source-change, Browser loopback, Native Host and SFU checks
  cover both rate bounds. Preserve these checks in final package acceptance.
  Keep the audio sender ceiling backed by the existing packet-size evidence.
  Numeric audio and video controls are implemented; the assessment
  owns local capture, codec, derived-output, SFU and bounded mixed-route evidence.
  Remaining receiver acceptance needs physical limited decoders and camera
  orientation behavior, beyond the bounded SDP-limit and mixed-route controls.
  Browser display capture, Browser relay, Browser-to-Native fanout and SFU have
  bounded high-resolution continuity evidence. macOS geometry SDK/hardware
  checks and physical 4K/game capture remain open. The fanout controls did not
  establish sustained 60 fps; retain that performance limit when arranging
  device/network acceptance. Preserve safety limits and
  framework-owned adaptation. The
  [audio controls](./research/browser-screen-audio-quality.md#numeric-bitrate-assessment)
  retain explicit receive-limit enforcement and the current 320 kbps sender
  ceiling. Physical listening, mobile and field-network acceptance remain open;
  research owns the bounded real-Opus impairment and video-recovery control.
  Validate the existing mono/stereo and Windows HDR-to-SDR paths under the
  [fidelity boundary](./research/media-fidelity.md); surround delivery and
  end-to-end HDR are outside this candidate. Additional codecs are also outside
  this candidate. Later inclusion needs complete
  encode/decode/forward support and a late-Viewer policy;
  selecting a codec cannot transcode an existing publication. Final package
  acceptance must retain the verified live-change, relay/SFU and limited-receiver
  behavior, and check explicit 1.x mismatch with packaged builds. The published
  1.x enums remain that major's baseline; the PR is not a compatible enum-only extension
  of v1.9.2.
- [ ] **2.0 candidate acceptance.** Finish the combined numeric-media UI,
  App/room lifecycle, ordinary Browser/Native routes and regression checks before
  asking the owner to arrange external testing. Keep each test build frozen and
  identifiable; the retired Magicsock package is not the current candidate.
- [ ] **Managed Demo hosting.** The [provider assessment](./operations/website.md#managed-hosting-assessment)
  identifies UDP/storage requirements but establishes no cost saving. Keep the
  existing P2P-only Demo until a provider and operating boundary are accepted.
- [ ] **Phone as a Host microphone.** The [input assessment](./research/camera-and-microphone.md#phone-microphone-assessment)
  identifies pairing/revocation and native decoded-input ownership beyond the
  existing device selector. Keep it outside this candidate until a concrete
  use case justifies that boundary and physical latency/echo/background checks.
  This proposal does not reopen room voice.
- [ ] **Passive App attachment: design hold.** Site mode authorizes one selected
  origin and supplies native media without starting a local room server. A
  passive replacement needs an accepted site-consent/discovery flow; it must not
  admit arbitrary sites or add another runtime owner. Keep Site mode until that
  decision; removal of the Demo prefill does not authorize changing site trust.

## Awaiting Device Or Reporter Evidence

These reports remain unmatched. A local repair or successful test is not proof
of a reporter's cause; research owns the completed experiments and their limits.

- [ ] **Windows 11 capture border remains visible.** The new report does not
  identify the affected version, capture path or Windows build. The reviewed
  picker/start/source-change paths preserve the border preference; no additional
  confirmed defect was found. [Capture evidence](./research/native-client-lifecycle.md#windows-capture-borders)
  owns the permission correction, retirement checks and preview-cancellation
  boundary. Visible permission changes, display-mode changes and the reporter's
  setup still need matched physical evidence; API success does not prove that
  Windows hid the border.
- [ ] **Physical device and network acceptance.** Complete the remaining
  [device checks](./verification-status.md#device-evidence-boundary) and
  [network/endurance matrix](./verification-status.md#remaining-device-and-network-acceptance),
  preserving platform deferrals and serial physical checks. Include macOS/Linux
  capture, HDR/mixed displays, audio exclusion across real process trees and
  playback devices, and mobile keyboard/theater/participant controls. The
  [camera and microphone assessment](./research/camera-and-microphone.md)
  additionally owns levels, echo, device replacement/native mixing, OBS input
  A/V synchronization and phone camera permission/orientation/background limits.
- [ ] **Native H.264 motion quality (#432).** Obtain matched source/decoded
  pictures and bitstream for the original 720p30 game comparison. Retain current
  codec parameters. The [evidence review](./research/native-client-media.md#native-h264-motion-quality)
  owns the withdrawn CBR claim, Baseline admission repair and Main/High comparison;
  none establishes this report's cause.
- [ ] **Self-hosted room creation HTTP 403.** Retest affected deployments using
  the [address checks](./guide/troubleshooting.md#room-creation-returns-403).
  Obtain the configured public address/origin and response details; distinguish
  Piik's rejection from a proxy/WAF 403 before assigning their cause.
- [ ] **No available media route.** Compare the same endpoints/networks before
  assigning a regression since v1.4. Obtain paired Host/Viewer/App reports and
  distinguish route allocation, ICE, first-frame admission and route rejection.
  Retest the public-invitation STUN report with ordinary discovery redundancy;
  its endpoint timeout results lack paired ICE traces and the prediction setting.
  [#443](https://github.com/TNTcraftHIM/Piik/issues/443) lacks a connected Native
  edge and its paired Viewer/App transport report;
  [#448](https://github.com/TNTcraftHIM/Piik/issues/448) only reaches route allocation.
  [#453](https://github.com/TNTcraftHIM/Piik/issues/453) has no matched endpoint
  reports to distinguish network reachability from a product failure.
  The v1.6.3 candidate-timeout report lacks share-start and SDP/ICE evidence.
  [#468](https://github.com/TNTcraftHIM/Piik/issues/468) needs the complete join
  trace to distinguish a new Viewer from reauthentication with lost local media;
  its excerpt starts with an already committed SFU edge. Retest the affected
  deployment with the repaired retained-connection opportunity accounting.
  [#467](https://github.com/TNTcraftHIM/Piik/issues/467)'s Viewer report reaches
  four preparations and exhaustion in about 170 ms, without local peer creation
  or a Viewer failure report. Obtain the paired Host/App rejection before
  attributing this attempt to NAT or extending its network timeout.
  [#465](https://github.com/TNTcraftHIM/Piik/issues/465) reports Chrome/Firefox
  LAN asymmetry, local-pool timeout and separate public-path quality loss.
  Its successful repeat changed both local-network permission and IP masking.
  [Local controls](./research/browser-local-encoding-pool.md#local-connection-failure-control)
  retain P2P through producer timeout; isolate the settings and compare paired
  reports before changing routing or advising users to disable IP masking.
  [#463](https://github.com/TNTcraftHIM/Piik/issues/463) lacks the Browser-only
  Mac/phone attempt details needed to distinguish capture, entry and media failure.
- [ ] **Public-invitation startup and HTTP 1033.** Obtain version and matched
  diagnostics for creation failures, Demo access and a stream stalling before
  reload returns 1033. Distinguish connector recovery/exit, DNS/provider failure
  and an obsolete link from media routing. Compare
  [#396](https://github.com/TNTcraftHIM/Piik/issues/396#issuecomment-5691465700) with
  the [runtime evidence](./research/cross-platform-client-runtime.md#public-invitation-startup).
  [#434](https://github.com/TNTcraftHIM/Piik/issues/434) establishes DNS refusal
  during edge discovery, not a cause shared by all startup reports.
  [#452](https://github.com/TNTcraftHIM/Piik/issues/452) records both QUIC and TCP
  connection timeouts; compare the same endpoint with/without its accelerator.
  That startup log contains no evidence for its separate H.264 report.
  [#466](https://github.com/TNTcraftHIM/Piik/issues/466) supplies only an early-exit
  screenshot. Retaining dependency failure details improves the next report;
  it does not establish or resolve this attempt's cause.
- [ ] **Viewer interruptions.** Obtain paired endpoint/upstream-relay diagnostics
  for established viewing returning to P2P connecting.
  Separately retest the v1.5.0 App public-link report where one Viewer drops
  immediately after connection details appear while others work. Distinguish
  first-frame admission, signaling grace and current-edge recovery.
- [ ] **App discovery and share-start failures.** Retest missing sources and
  unreachable App reports across authorization, browser permissions, control
  capacity, enumeration and startup. For the v1.6.5 Auto-to-VP8 report, obtain
  the Browser exception/assets and actual VP8 output: Browser `stop-share`
  precedes any local-edge request and does not prove a no-frame timeout.
  [#419](https://github.com/TNTcraftHIM/Piik/issues/419)'s AMD manual-H264 failure
  and [#437](https://github.com/TNTcraftHIM/Piik/issues/437)'s Auto-only failure
  need the same attempt's App diagnostics. For `input-texture-create / 0x887a0005`,
  obtain the next candidate/fallback result and final state; a rejected candidate
  alone is not the share outcome. [Native media research](./research/native-client-media.md#current-boundary)
  owns the hardware checks and limits.
- [ ] **Share ends after entering a game.** Obtain version, capture path, codec
  and paired diagnostics. Locate the first capture/output, preview-bridge,
  control or authority failure; distinguish source silence from target replacement,
  display-mode change and device loss. [Capture research](./research/native-client-lifecycle.md#quiet-sources-and-viewer-recovery)
  owns the quiet-source behavior; an encoder output deadline remains a candidate
  mechanism, not a diagnosis of this report.
- [ ] **Windows launcher exit after opening the page.** A user reports that the
  mode-selection page opens, then the App console reports
  `Piik App could not open its launcher: exit status 0xc0000005`.
  Retest the browser handoff and obtain the affected build and URL-handler
  process/dump evidence if it still fails.
- [ ] **System becomes very laggy after starting a share.** Obtain mode, actual
  codec, profile, display refresh rate and CPU/GPU use, distinguishing startup
  from sustained lag. Compare saturated GPU/game-FPS impact and multi-output
  recovery with the [helper-cost checks](./research/native-client-media.md#windows-helper-cost-2026-09-29)
  before changing allocation or cadence. For Native/SFU stalls, correlate the
  relevant Go runtime using the [GC attribution boundary](./research/realtime-quality-adaptation.md#go-gc-attribution);
  no field report currently establishes GC as its cause.

## Next: P2P Connection And Feedback Evidence

For the transport assessment, measure connection success, time to first picture and
failure causes on representative networks, especially App and P2P-only sites.
Use existing Debug provenance and selected-path events under the
[NAT evidence boundaries](./research/nat-traversal.md#gateway-and-survey-limits).
Separate candidates, attempts, successful paths and timeouts; scope observations
to connection generations without raw endpoints. Verify survey responses and
P2P/SFU handoffs, including background direct attempts behind working SFU media.
The [iroh/Tailscale comparison](./research/nat-traversal.md#iroh-and-tailscale-comparison)
records the isolated Go media/migration experiment and Browser/relay limits.
Prioritize one-App-to-Browser and Browser-to-Browser controls using existing
ICE, IPv6 and gateway mapping, with changing interfaces, lost mappings and
asymmetric network restrictions. The
[Browser-compatible assessment](./research/nat-traversal.md#browser-compatible-follow-up)
owns current literature and applicability. Do not infer a benefit from another
stack's success percentage or add a new retry/transport owner without evidence.
The candidate's stable Pion upgrade has local Browser resolution and
interoperability/recovery evidence in that assessment. Include the upgraded
Native/SFU composition in physical-network acceptance; local success is not a
measured increase in field hole-punching success.
The [renomination preflight](./research/nat-traversal.md#pion-renomination-preflight)
rejects enabling the current automatic option: Firefox's recovered video did not
restore reverse feedback. Keep standard ICE recovery while that boundary remains.

## Parked Product Work

1. **Broader quality work.** Reopen from measured interruptions, failed recovery
   or healthy-sibling degradation at acceptable complexity. The
   [Browser pool comparison](./research/browser-local-encoding-pool.md#balanced-startup-and-recovery)
   owns cold-encoder tradeoffs; low resolution alone is not a defect. Check
   whether a proposed move merely shifts pressure to another parent's siblings.
2. **Platform output.** Reopen for a registered receiver acting as an ordinary
   Viewer only after the [platform-output gate](./research/platform-output.md)
   passes.
3. **Additional languages.** Review community catalogs and their rendered UI
   following the [translation guide](./guide/translating.md), including names,
   menu navigation, text direction and layout.
4. **Windows code signing.** Revisit after enrollment in a trusted signing
    service. Sign executables before archive checksums; publisher identity does
    not guarantee that antivirus cloud scanning stops.
5. **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
    and retain Gitee; do not add a self-hosted mirror. Chrome still blocks the
    Gitee attachment when Referer is removed. Reopen for new evidence or a
    provider review; the warning remains unresolved.
6. **Release-operation policy.** Protected release environments and immutable
    draft assets remain unaccepted proposals; evaluate their benefit before
    adding release machinery.
7. **Automatic local chat history.** Explicit TXT export covers manual retention.
    Reconsider automatic storage only with a stable room-incarnation identity,
    bounded retention and a clear delete control; reusable room codes must not
    combine conversations. No new history service or wire field is authorized.
8. **Direct OBS input (#436).** Reopen for a measured virtual-camera limitation.
    The [capture assessment](./research/camera-and-microphone.md) records raw-frame
    output and the WHIP boundary; virtual camera alone is not a second encode.
    Do not add an RTMP/WHIP listener without an accepted publication owner.
