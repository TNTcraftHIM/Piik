# Current TODO Ledger

Last reviewed: 2026-10-07

The current 2.0 preparation includes independent investigation across this
ledger. Explicit owner holds remain in force; an investigation does not itself
accept a new feature or architecture. A missing device or reporter trace blocks
only that evidence claim, not unrelated work. Product modules own behavior;
Git/PRs own completed history.

## Now

- [ ] **2.0 candidate preparation and acceptance.** The owner reopened investigation,
  useful improvements and outstanding acceptance on 2026-10-07. Prepare one
  coherent candidate and stop before publication. Preserve the existing product
  model; evaluate held features against measurable benefit and total complexity
  before accepting a changed contract.
- [ ] **Signaling execution and fairness.** Measure signaling-lock contention,
  synchronous persistence, presence fan-out, diagnostic I/O and cross-room
  password work before changing the lock or execution model. Start from the
  existing bounded owners; do not introduce per-room actors without evidence.
- [ ] **Storage fault boundaries.** Extend real SQLite fault checks to disk I/O
  failure during COMMIT/ROLLBACK. Write rejection, page-capacity exhaustion and
  deferred-constraint COMMIT rejection are covered by the room tests. Verify
  durable and in-memory room authority remain consistent and the next operation
  has a defined outcome before choosing a recovery change; do not add
  catch-and-continue retries.
- [ ] **Lifecycle ownership review.** Trace reachable per-share Host/Viewer,
  source replacement, signaling recovery and media retirement paths under
  [engineering review](./standards/engineering.md#ablation-and-review).
  Reproduce C=3 structural-intent or multi-child evidence concerns before changing
  their ownership. Keep Native bridge failure distinct from network failure;
  account for preview, quality candidates, SFU updates and track-ended consumers
  before changing Host loopback retirement. Simplify only for a concrete gain.
- [ ] **Documentation consistency.** Check the remaining guides, research and
  owner links against current behavior; remove obsolete service/API descriptions
  while retaining the scope and date of historical measurements.
- [ ] **Native capture cadence acceptance.** The local Native SFU throughput
  rerun is limited by [low WGC arrival cadence](./research/native-client-media.md#virtual-display-acceptance-limit)
  reproduced on unchanged main and a separate Windows-API-only capture probe.
  Compare on a physical display before claiming current Native throughput
  acceptance; do not lower the unchanged 300-frame/30-second requirement.
- [ ] **Independent Gitee mirror recovery.** Implementation and local acceptance
  are complete. Integrate through the next owner-approved publishing merge and
  verify the separate workflow with its original CI artifacts. Mirror failure
  must remain visible without blocking product CI or Website delivery.

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

## Feature Assessments

Assess these proposals against the owner's benefit/complexity condition.
Existing negative results narrow the next experiment; they do not freeze the
whole candidate or require another version-number decision before other work.
Implementation needs a concrete useful result within the product model.

- [ ] **4K and additional codecs.** The [media assessment](./research/native-client-media.md#media-capability-extension-assessment)
  recommends retaining current limits. Assess concrete source/receiver cases
  before accepting coordinated capture, forwarding and resource-bound changes;
  keep UI presets separate from those bounds in any new design. Additional
  formats must account for late Viewers and relays that cannot decode or forward
  the published format; codec negotiation alone does not transcode it.
- [ ] **Native Magicsock.** Go reuse is feasible, but the
  [matched comparisons](./research/nat-traversal.md#integration-cost-and-recovery-controls)
  have not established improved direct reachability. Seek a repeatable benefit
  before accepting peer-key authorization/revocation, underlay readiness and
  relay operation. Keep the isolated experiment separate from product routing;
  the P2P evidence work below owns the network/interop acceptance boundary.
- [ ] **Managed Demo hosting.** The [provider assessment](./operations/website.md#managed-hosting-assessment)
  identifies UDP/storage requirements but establishes no cost saving. Keep the
  existing P2P-only Demo until a provider and operating boundary are accepted.
- [ ] **Phone as a Host microphone.** Assess an opt-in link that pairs a phone's
  microphone with the Host's existing audio mixer. Evaluate pairing/revocation,
  latency/echo, browser background limits
  and Browser/native input ownership before accepting an implementation. This
  proposal does not reopen room voice; establish feasibility before accepting it.
- [ ] **Passive App attachment: design hold.** Site mode authorizes one selected
  origin and supplies native media without starting a local room server. A
  passive replacement needs an accepted site-consent/discovery flow; it must not
  admit arbitrary sites or add another runtime owner. Keep Site mode until that
  decision; removal of the Demo prefill does not authorize changing site trust.

## Awaiting Device Or Reporter Evidence

These reports remain unmatched. A local repair or successful test is not proof
of a reporter's cause; research owns the completed experiments and their limits.

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
  [#453](https://github.com/TNTcraftHIM/Piik/issues/453) has no matched endpoint
  reports to distinguish network reachability from a product failure.
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
  [#452](https://github.com/TNTcraftHIM/Piik/issues/452) records both QUIC and TCP
  connection timeouts; compare the same endpoint with/without its accelerator.
  That startup log contains no evidence for its separate H.264 report.
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
2. **Broader quality work.** Reopen from measured interruptions, failed recovery
   or healthy-sibling degradation at acceptable complexity. The
   [Browser pool comparison](./research/browser-local-encoding-pool.md#balanced-startup-and-recovery)
   owns cold-encoder tradeoffs; low resolution alone is not a defect. Check
   whether a proposed move merely shifts pressure to another parent's siblings.
3. **Platform output.** Reopen for a registered receiver acting as an ordinary
   Viewer only after the [platform-output gate](./research/platform-output.md)
   passes.
4. **Additional languages.** Review community catalogs and their rendered UI
   following the [translation guide](./guide/translating.md), including names,
   menu navigation, text direction and layout.
5. **Windows code signing.** Revisit after enrollment in a trusted signing
    service. Sign executables before archive checksums; publisher identity does
    not guarantee that antivirus cloud scanning stops.
6. **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
    and retain Gitee; do not add a self-hosted mirror. Chrome still blocks the
    Gitee attachment when Referer is removed. Reopen for new evidence or a
    provider review; the warning remains unresolved.
7. **Release-operation policy.** Protected release environments and immutable
    draft assets remain unaccepted proposals; evaluate their benefit before
    adding release machinery.
8. **Automatic local chat history.** Explicit TXT export covers manual retention.
    Reconsider automatic storage only with a stable room-incarnation identity,
    bounded retention and a clear delete control; reusable room codes must not
    combine conversations. No new history service or wire field is authorized.
9. **Direct OBS input (#436).** Reopen for a measured virtual-camera limitation.
    The [capture assessment](./research/camera-and-microphone.md) records raw-frame
    output and the WHIP boundary; virtual camera alone is not a second encode.
    Do not add an RTMP/WHIP listener without an accepted publication owner.
