# Current TODO Ledger

Last reviewed: 2026-10-06

Only **Now** is executable. Product modules own behavior; Git/PRs own completed
history. A parked idea is not implementation authority.

## Now

No active implementation work. Deferred proposals and evidence-dependent reports
remain below; release delivery is tracked by the pipeline and deployment records.

## Held By Owner

- [ ] **4K and resolution/capability expansion.** Not planned for this phase,
  reaffirmed by the owner on 2026-10-06 because of cost relative to benefit. Keep the
  public v23/v9/v7 contract and 1440p ceiling. Resume the extensibility audit and
  [media extension assessment](./research/native-client-media.md#media-capability-extension-assessment)
  only with a renewed benefit/cost decision. This includes unfinished
  cross-platform capture and capability negotiation; local tests alone do not
  authorize a protocol break or a 2.0 release. Retain recoverable Git evidence
  for the experiment without requiring an active worktree.
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

## Deferred Feature Work

These proposals remain deferred beyond the accepted interaction phase.

- [ ] **Native Magicsock integration.** The [isolated comparison](./research/nat-traversal.md#integration-cost-and-recovery-controls)
  establishes Go feasibility and relay-assisted recovery, but no additional
  direct-reachability class in its tested matrix. Keep product transport unchanged.
  Reopen integration only for a repeatable benefit on matched networks that
  justifies the extra identity, readiness, packet-size and relay responsibilities.
- [ ] **Managed Demo hosting.** Evaluate cost and public UDP support before any
  migration. The assessment remains outside the current product release; keep
  the existing P2P-only Demo deployment until a provider and operating boundary
  are accepted.
- [ ] **Phone as a Host microphone: assess after the current work.** Explore an
  opt-in link that pairs a phone's microphone with the Host's existing audio
  mixer. Evaluate pairing/revocation, latency/echo, browser background limits
  and Browser/native input ownership before accepting an implementation. This
  proposal does not reopen room voice or change the current release scope.
- [ ] **Passive App attachment: design hold.** Site mode authorizes one selected
  origin and supplies native media without starting a local room server. A
  passive replacement needs an accepted site-consent/discovery flow; it must not
  admit arbitrary sites or add another runtime owner. Keep Site mode until that
  decision; removal of the Demo prefill does not authorize changing site trust.

## Awaiting Device Or Reporter Evidence

These reports remain unmatched. A local repair or successful test is not proof
of a reporter's cause; research owns the completed experiments and their limits.

- [ ] **Intermittent native capture self-test failure.** The worker check now
  records its phase, original exception and per-output progress. A local pass
  does not explain the earlier CI failure; use the next failed run's diagnostics
  before changing deadlines or worker behavior.
- [ ] **macOS and Linux physical capture.** Complete the remaining capture/audio
  checks in [verification status](./verification-status.md#device-evidence-boundary),
  including an Intel Mac with a usable hardware H.264 encoder, an ARM64 Linux
  desktop, and Linux systems beyond the PR author's Hyprland/NVIDIA result.
- [ ] **Signaling recovery on passwordless sites (#446).** Verify the admission
  correction against a matched Host/Server attempt; identify the event preceding
  the handshake failure rather than inferring password denial from `AUTH_REQUIRED`.
- [ ] **HDR, audio-exclusion and mobile interaction device coverage.** Complete
  the [physical matrix](./verification-status.md#device-evidence-boundary):
  HDR/mixed displays, voice-app process trees across playback devices and phone
  keyboard/theater/participant-menu interaction. Browser HDR overexposure is an
  accepted limitation with [documented alternatives](./guide/troubleshooting.md#hdr-picture-looks-too-bright-or-washed-out);
  reopen conversion work only with new evidence and an accepted implementation.
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
  [#443](https://github.com/TNTcraftHIM/Piik/issues/443) lacks a connected Native
  edge and its paired Viewer/App transport report;
  [#448](https://github.com/TNTcraftHIM/Piik/issues/448) only reaches route allocation.
  The v1.6.3 candidate-timeout report lacks share-start and SDP/ICE evidence.
- [ ] **Camera and Host microphone device coverage.** Check real audio levels,
  echo, device replacement/native mixing and phone camera permission, orientation
  and background behavior. Include OBS virtual-camera/audio-input sound quality
  and A/V synchronization. The [capture assessment](./research/camera-and-microphone.md)
  owns current behavior and the accepted physical limits.
- [ ] **Public-invitation startup and HTTP 1033.** Obtain version and matched
  diagnostics for creation failures, Demo access and a stream stalling before
  reload returns 1033. Distinguish connector recovery/exit, DNS/provider failure
  and an obsolete link from media routing. Compare
  [#396](https://github.com/TNTcraftHIM/Piik/issues/396#issuecomment-5691465700) with
  the [runtime evidence](./research/cross-platform-client-runtime.md#public-invitation-startup).
  [#434](https://github.com/TNTcraftHIM/Piik/issues/434) establishes DNS refusal
  during edge discovery, not a cause shared by all startup reports.
- [ ] **Viewer interruptions.** Obtain paired endpoint/upstream-relay diagnostics
  for established viewing returning to P2P connecting, including
  [#429](https://github.com/TNTcraftHIM/Piik/issues/429)'s SFU-to-P2P dropout.
  Separately retest the v1.5.0 App public-link report where one Viewer drops
  immediately after connection details appear while others work. Distinguish
  first-frame admission, signaling grace and current-edge recovery.
- [ ] **Windows 11 capture border remains visible.** Identify the App/Browser
  capture path, Windows build, permission result and other active captures.
  [Capture evidence](./research/native-client-lifecycle.md#windows-capture-borders)
  owns the graceful-retirement and concurrent-capture checks.
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
Before adopting magicsock in the product, establish a benefit on matched network
pairs and define room-authorized peer keys, endpoint exchange, MTU/resource limits
and mixed Browser/Native behavior. Keep the experiment isolated from the
production [routing contract](./standards/routing-transport.md); Go reuse already
works, so a Rust alternative needs a concrete Go limitation.

## Parked Product Work

1. **Representative device/network acceptance.** Resume the remaining matrix in
   [verification status](./verification-status.md#remaining-device-and-network-acceptance)
   when directed, preserving platform deferrals and serial physical checks.
   Before reusing the optional `viewer-mbb` canary, replace its obsolete
   Viewer-only trigger and capacity assertions with the sender-owned contract.
2. **Broader quality work.** Reopen from measured interruptions, failed recovery
   or healthy-sibling degradation at acceptable complexity. The
   [Browser pool comparison](./research/browser-local-encoding-pool.md#balanced-startup-and-recovery)
   owns cold-encoder tradeoffs; low resolution alone is not a defect. Check
   whether a proposed move merely shifts pressure to another parent's siblings.
3. **Signaling execution model.** Measure signaling-lock contention, synchronous
   persistence, presence fan-out, diagnostic I/O and cross-room password-work
   fairness before changing the lock or execution model.
4. **Reachable ownership/refactor work.** With related behavior changes, evaluate
   per-share Host and Viewer route ownership under
   [engineering review](./standards/engineering.md#ablation-and-review).
   Reopen C=3 structural-intent retention or multi-child evidence ownership only
   with current-contract reproductions. Shared recovery must preserve Native
   bridge versus network-failure semantics. Before changing Host loopback-failure
   retirement, account for its preview, Browser quality candidates, quality/SFU
   updates and track-ended consumers; independent Native publication alone does
   not make ignoring the failure safe. This is not a diagnosed field cause.
5. **Storage fault recovery.** Choose and verify a damaged-disk/COMMIT/ROLLBACK
   recovery policy before adding catch-and-continue or retries. This failure
   boundary remains unestablished after ordinary persistence checks.
6. **Platform output.** Reopen for a registered receiver acting as an ordinary
   Viewer only after the [platform-output gate](./research/platform-output.md)
   passes.
7. **Additional languages.** Review community catalogs and their rendered UI
   following the [translation guide](./guide/translating.md), including names,
   menu navigation, text direction and layout.
8. **Windows code signing.** Revisit after enrollment in a trusted signing
    service. Sign executables before archive checksums; publisher identity does
    not guarantee that antivirus cloud scanning stops.
9. **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
    and retain Gitee; do not add a self-hosted mirror. Chrome still blocks the
    Gitee attachment when Referer is removed. Reopen for new evidence or a
    provider review; the warning remains unresolved.
10. **Release-operation policy.** Protected release environments, immutable
    draft assets and changing mirror-failure policy remain unaccepted proposals;
    evaluate their benefit before adding release machinery.
11. **Automatic local chat history.** Explicit TXT export covers manual retention.
    Reconsider automatic storage only with a stable room-incarnation identity,
    bounded retention and a clear delete control; reusable room codes must not
    combine conversations. No new history service or wire field is authorized.
12. **Direct OBS input (#436).** Reopen for a measured virtual-camera limitation.
    The [capture assessment](./research/camera-and-microphone.md) records raw-frame
    output and the WHIP boundary; virtual camera alone is not a second encode.
    Do not add an RTMP/WHIP listener without an accepted publication owner.
