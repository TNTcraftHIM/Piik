# Current TODO Ledger

Last reviewed: 2026-10-15

Explicit owner holds remain in force; an investigation does not itself
accept a new feature or architecture. A missing device or reporter trace blocks
only that evidence claim, not unrelated work. Product modules own behavior;
Git/PRs own completed history.

## Now

2.0 is published on GitHub. The current maintenance phase reviews optional App
capabilities, bounded NAT correctness and media recovery; it retains the published
protocol and route owners. Integrate the verified phase through
[the release workflow](../CONTRIBUTING.md#full-integration-and-release-workflow)
after final checks under the owner's current release authorization. Broader
device coverage below does not override the owner's
platform deferrals or establish a diagnosis for unmatched reports.

- [ ] **Native quality recovery.** Verify the retained-connection budget and
  current-output demand repairs against the affected Host. Local paced-sending,
  partial-recovery and stable-allocation controls pass; they do not prove the
  live report resolved. The publication's sole active rate-controlled RID still
  stops probing below its ceiling. An isolated extension restores it by exposing
  codec demand to the existing allocator, but requires an upstream input absent
  from the current dependency; choose a bounded integration without copying the
  whole allocator, a second controller or fabricated source measurements.
  [Media evidence](./research/node-local-media-design.md#send-queue-recovery)
  owns the comparisons and remaining boundary.
## Held By Owner

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

## Awaiting Device Or Reporter Evidence

These physical checks or reporter diagnoses remain unverified. A local repair or
successful test is not proof of a reporter's cause; research owns the completed
experiments and their limits.

- [ ] **Self-hosted sustained quality loss (v1.9.2).** The report describes
  resolution loss and stutter that clear after Viewer refresh, without paired
  diagnostics, a confirmed route or codec. Six candidate
  [sustained recovery trials](./research/network-lab.md#sustained-quality-recovery)
  restore 720p on retained Browser P2P/SFU connections; recovery still takes
  tens of seconds. Retest the affected setup with matched Host/Viewer/Server
  reports before assigning its cause. Existing queue/probe repairs do not
  establish a diagnosis, server CPU requirements or long-duration stability.

- [ ] **Linux Portal target identity acceptance (#470).** The
  [contributor fix](https://github.com/TNTcraftHIM/Piik/pull/470) is integrated
  with authorship retained. Compilation and headless serial/node-ID targeting
  checks pass. Verify an actual Portal that omits `pipewire-serial` when physical
  Linux capture acceptance resumes; headless checks do not exercise desktop capture.
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
  preserving platform deferrals and serial physical checks. The implemented
  [numeric-media candidate](./research/native-client-media.md#media-capability-extension-assessment)
  still needs physical limited-decoder, camera-orientation, macOS geometry and
  sustained 4K/game evidence. Check live changes and source replacement through
  relay/SFU, and listen across the
  [audio control range](./research/browser-screen-audio-quality.md#numeric-bitrate-assessment).
  Include existing mono/stereo and Windows HDR-to-SDR under the
  [fidelity boundary](./research/media-fidelity.md), audio exclusion across real
  process trees/playback devices, and mobile keyboard/theater/participant controls.
  Passive App attachment still needs cross-device Browser-permission checks;
  retain first/saved approval, replacement/revocation and Local coexistence.
  These are evidence limits for implemented features, not new feature proposals.
  Additional codecs, surround delivery and end-to-end HDR remain outside the candidate. The
  [camera and microphone assessment](./research/camera-and-microphone.md)
  additionally owns levels, echo, device replacement/native mixing, OBS input
  A/V synchronization and phone camera permission/orientation/background limits.
- [ ] **Virtual-microphone echo (#473).** The screenshot has Piik's microphone
  off while screen audio excludes a different voice app. Process exclusion captures
  other renderers across output devices, so a virtual mixer can still enter source
  audio. Obtain the reporter's system-sound-off comparison and routing before
  attributing the duplicate voice to Piik's mixer. The [audio guide](./guide/getting-started.md#exclude-a-voice-app-from-screen-audio)
  explains this boundary; no automatic extra exclusion is planned.
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
- [ ] **Native sharing ends unexpectedly.** The new v2.0.0 `app/capture/failed`
  report and earlier game-entry interruptions need matched App diagnostics.
  The error key alone identifies neither a driver nor a timeout. The local
  Windows lifecycle gate passes; it does not reproduce the affected setup.
  Obtain capture path, codec and paired diagnostics. Locate the first capture/output, preview-bridge,
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

- [ ] **Coordinated Native retry acceptance.**
  The optional two-App preparation is integrated into the existing retry owner.
  The [process laboratory](./research/network-lab.md) covers successful adoption
  through sequential kernel NAT; ordinary continuation when preparation is
  ineligible also passes. Verify successful preparation through physical difficult
  networks and decoded-picture continuity on that path, following the
  [assessment](./research/nat-traversal.md#coordinated-native-punching-assessment).
  Preserve the first ordinary attempt, immediate Browser decline and fixed
  operation deadlines. Future field comparisons should use the same peers with
  the share's enhancement switch
  enabled/disabled, including mixed stable/sequential observations in both
  directions. Local coverage does not establish their field benefit. Random-port
  overlap remains separate and unproven.

For the transport assessment, measure connection success, time to first picture and
failure causes on representative networks, especially App and P2P-only sites.
Use existing Debug provenance and selected-path events under the
[NAT evidence boundaries](./research/nat-traversal.md#gateway-and-survey-limits).
Separate candidates, attempts, successful paths and timeouts; scope observations
to connection generations without raw endpoints. Verify survey responses and
P2P/SFU handoffs, including background direct attempts behind working SFU media.
The [iroh/Tailscale comparison](./research/nat-traversal.md#iroh-and-tailscale-comparison)
records the isolated Go media/migration experiment and Browser/relay limits.
The reopened optional background-App assessment includes current stable
Magicsock/Pion controls; no additional direct reachability was established.
Keep Magicsock outside the candidate. A future matched difficult-network
comparison may reopen adoption, subject to the recorded discovery, datagram,
authorization and relay-policy boundaries. Saved Site approval alone is not
evidence for a transport benefit.
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
9. **Managed Demo hosting.** The [provider assessment](./operations/website.md#managed-hosting-assessment)
    identifies UDP/storage requirements but establishes no cost saving. Keep the
    existing P2P-only Demo; reopen for an accepted provider and operating boundary.
10. **Phone as a Host microphone.** The [input assessment](./research/camera-and-microphone.md#phone-microphone-assessment)
    identifies pairing/revocation and native decoded-input ownership beyond the
    device selector. Reopen for a concrete use case that justifies this boundary
    and physical latency/echo/background checks. This does not reopen room voice.
