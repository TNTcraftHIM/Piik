# Current TODO Ledger

Last reviewed: 2026-10-18

Explicit owner holds remain in force; an investigation does not itself
accept a new feature or architecture. A missing device or reporter trace blocks
only that evidence claim, not unrelated work. Product modules own behavior;
Git/PRs own completed history.

## Now

The 2.x maintenance line retains the published protocol and route owners.
Release artifacts and operator records own exact delivery; remaining product
work is listed below. Broader device coverage does not override the owner's
platform deferrals or establish a diagnosis for unmatched reports.

- [ ] **Attended keyboard/mouse remote control.** Windows App display/window sharing now
  offers optional input over the existing direct, Browser/App relay and SFU
  routes in experimental `remotecontrol` builds. Keep one Host publication and
  one controller, with source-scoped permission disabled by default. Local Windows
  routed input, consent/revocation, relay recovery, window geometry and mobile
  touch/keyboard emulation pass; the [prototype boundary](./research/room-interactions.md#attended-remote-control-prototype)
  owns implementation and evidence. Finish owner acceptance before release.
  Physical Android/iOS, mixed-DPI displays, commercial games and an actual
  remote-device trial remain. macOS Quartz/Accessibility and Linux RemoteDesktop
  Portal backends are implemented; Linux compilation and synthetic input/release
  checks pass, but desktop permission/capture remains unverified. macOS needs
  an Apple SDK build and physical focus/Retina/input checks. The
  [window/game assessment](./research/room-interactions.md#window-capture-and-game-input)
  owns platform and game-compatibility limits. This is not a public feature.

- [ ] **Viewer playback settings acceptance (#477).** The current prototype adds
  local fit/crop/stretch and per-viewing Auto/P2P/SFU choice through the existing
  route controller and shared playback settings. Host/site policy still wins;
  [routing](./standards/routing-transport.md#viewer-route-choice) owns the boundary.
  Include Host input-availability feedback and retained Viewer volume preferences
  in this UI acceptance; [presentation](./standards/presentation-lifecycle.md)
  owns their meaning.
  Also accept the combined interaction window, including its on-demand reaction
  tray and live reactions when detached; it reuses the existing room session and palette.
  Finish owner UI acceptance before release.

- [ ] **macOS bundle startup acceptance (#479).** The package now contains the
  actual Mach-O entry and helpers inside `.app`, replacing the shell launcher's
  dependency on an external sibling executable. A moved-bundle assembly check
  passes. Run the native package gate and Finder launch on macOS, including a
  downloaded/quarantined bundle and capture permissions. The packaging defect
  is established; its correction has not yet been matched to the reporter's Mac.

- [ ] **Return LiveKit to an upstream pin.** Native publication now supplies
  unmet encoder demand to the existing allocator through the scoped dependency
  revision submitted in [upstream #5016](https://github.com/livekit/livekit/pull/5016).
  When maintained upstream provides this input, pass the same recovery gate and
  remove the temporary replacement. [Provenance and removal](../internal/thirdparty/README.md#local-encoder-probe-demand)
  own that boundary; this local repair does not diagnose the unmatched field
  reports below.

- [ ] **Audio-exclusion explanation (#480).** At release, point the reporter to
  the [source-audio scopes](./guide/getting-started.md#exclude-a-voice-app-from-screen-audio).
  The missing window/camera exclusion control is intentional; investigate a
  specific unwanted recording only if a matching source/input report establishes it.

- [ ] **SFU recovery rollout.** Shared forwarding now gives DownTrack one
  owner for video sender reports and RR/RTT accounting, with Pion scheduling.
  Matched SFU logs established clock contamination blocking layer changes and
  missing RTT updates. RTCP, constrained recovery and the current App/Server
  lifecycle checks pass locally. After the approved release, verify the affected
  deployment with both corrected App and Server; an ICE restart does not replace
  the affected upstream clock. This does not diagnose every unmatched
  sustained-quality report below.

- [ ] **Persistent loss with low source utilization.** An App-to-Browser field
  trace and a controlled reproduction expose excessive budget reduction when
  actual video uses only part of its requested bitrate. The CTR group-boundary
  accounting repair does not resolve that behavior. Compare estimator handling
  of persistent loss and real bandwidth constraints before selecting a change;
  [evidence and limits](./research/node-local-media-design.md#persistent-loss-with-low-source-utilization)
  distinguish the reproduced mechanism from the still-unknown cause of field loss.

## Held By Owner

- [ ] **Multiple remote-control screens.** Deferred by the owner on 2026-10-17.
  Keep one shared source and the existing Host source picker; Viewer-initiated
  screen switching and simultaneous multi-screen streams are later work.
- [ ] **Independent virtual input devices for remote co-play.** Deferred by the owner on
  2026-10-17. This phase uses keyboard/mouse only and adds no virtual gamepad
  driver. Per-player virtual keyboards, mice and gamepads are later work.
  The [input assessment](./research/room-interactions.md#remote-co-play) owns
  platform dependencies and the distinction from shared keyboard/mouse control.
- [ ] **32-bit Windows/Linux Apps.** Deferred by the owner on 2026-10-02;
  no package or website option is planned. Browser use remains available where
  the OS/browser supports the required media APIs. Retain the isolated
  Git evidence for the Windows x86 capture experiment; revisit its native dependencies,
  atomic alignment and real 32-bit device coverage only if this work is reopened.
- [ ] **Windows ARM64 App.** Deferred by the owner on 2026-10-03. Keep Windows
  App packages and website downloads x64-only until this work is reopened.
- [ ] **Alternative public-invitation providers.** Deferred by the owner on
  2026-10-16. Retain Cloudflare Quick Tunnel; do not integrate localhost.run or
  another provider in this phase. The [provider assessment](./research/cross-platform-client-runtime.md#alternative-invitation-providers)
  retains the probe results and tradeoffs for a later decision.

## Awaiting Device Or Reporter Evidence

These physical checks or reporter diagnoses remain unverified. A local repair or
successful test is not proof of a reporter's cause; research owns the completed
experiments and their limits.

- [ ] **Sustained quality loss.** Retest the affected Native Host and the
  v1.9.2 self-hosted Browser setup with matched Host/Viewer/Server diagnostics,
  route and codec. [Native controls](./research/node-local-media-design.md#send-queue-recovery)
  and [P2P/Browser trials](./research/network-lab.md#sustained-quality-recovery)
  do not establish these reports' causes. Windows native QP tuning improves the
  [controlled recovery cases](./research/webrtc-encoder-pool.md#budget-restoration).
  Browser recovery can still take tens of seconds or remain downscaled after
  allocation recovers; its internal QP settings are not exposed to page scripts.
  Controlled repetition no longer depends on reporter availability; matched
  reports are needed to attribute their cases.
  Do not infer server CPU requirements from an unmatched report.

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
- [ ] **Physical device and network acceptance.** Complete the
  [device checks](./verification-status.md#device-evidence-boundary) and
  [network/endurance matrix](./verification-status.md#remaining-device-and-network-acceptance),
  preserving platform deferrals and serial capture checks. Include limited
  decoders, macOS geometry, sustained game/4K use, live changes through relay/SFU,
  audio levels/fidelity/exclusion, mobile keyboard/fullscreen and camera behavior,
  plus passive App approval/revocation and Local coexistence. The linked
  verification owner retains the detailed evidence boundaries; this does not
  reopen additional codecs, surround or end-to-end HDR.
- [ ] **Native H.264 motion quality (#432).** Obtain matched source/decoded
  pictures and bitstream for the original 720p30 game comparison. Retain current
  codec parameters. The [evidence review](./research/native-client-media.md#native-h264-motion-quality)
  owns the withdrawn CBR claim, Baseline admission repair and Main/High comparison;
  none establishes this report's cause.
- [ ] **Self-hosted room creation HTTP 403.** Retest affected deployments using
  the [address checks](./guide/troubleshooting.md#room-creation-returns-403).
  Obtain the configured public address/origin and response details; distinguish
  Piik's rejection from a proxy/WAF 403 before assigning their cause.
- [ ] **No available media route.** Obtain paired reports and compare the same
  endpoints before assigning a regression. Separate allocation, ICE, first-frame
  admission and rejection; similar messages do not establish one cause.
  [#443](https://github.com/TNTcraftHIM/Piik/issues/443),
  [#448](https://github.com/TNTcraftHIM/Piik/issues/448) and
  [#453](https://github.com/TNTcraftHIM/Piik/issues/453) need paired transport traces;
  the v1.6.3 timeout also needs share-start/SDP evidence.
  [#471](https://github.com/TNTcraftHIM/Piik/issues/471) reports working STUN and
  a router mapping on v2.1.0, but no ICE check responses. Obtain the retained
  paired reports; that summary alone does not distinguish NAT filtering,
  upstream mapping or a blocked path.
  [#468](https://github.com/TNTcraftHIM/Piik/issues/468) needs the complete join/
  reauthentication trace on repaired connection-opportunity accounting.
  [#464](https://github.com/TNTcraftHIM/Piik/issues/464) needs matched SFU reports
  after updating; the Viewer-side publication diagnostic was not Host evidence.
  [#467](https://github.com/TNTcraftHIM/Piik/issues/467) needs the Host/App rejection
  preceding its 170 ms exhaustion; extending ICE timeouts is not justified.
  For [#465](https://github.com/TNTcraftHIM/Piik/issues/465), isolate local-network
  permission from IP masking using the [local controls](./research/browser-local-encoding-pool.md#local-connection-failure-control).
  [#463](https://github.com/TNTcraftHIM/Piik/issues/463) needs the Mac/phone attempt
  details to distinguish capture, entry and media failure.
- [ ] **Public-invitation startup and HTTP 1033.** Obtain version and matched
  diagnostics; distinguish connector exit/recovery, DNS/provider failure and
  obsolete links from media routing. Compare [#396](https://github.com/TNTcraftHIM/Piik/issues/396#issuecomment-5691465700)
  with [runtime evidence](./research/cross-platform-client-runtime.md#public-invitation-startup).
  [#434](https://github.com/TNTcraftHIM/Piik/issues/434) establishes DNS refusal;
  [#452](https://github.com/TNTcraftHIM/Piik/issues/452) needs a same-endpoint
  accelerator comparison for QUIC/TCP timeouts, separately from its H.264 report;
  [#466](https://github.com/TNTcraftHIM/Piik/issues/466) needs the original exit log.
- [ ] **Viewer interruptions.** Obtain paired endpoint/upstream-relay diagnostics
  for established viewing returning to P2P connecting.
  Separately retest the v1.5.0 App public-link report where one Viewer drops
  immediately after connection details appear while others work. Distinguish
  first-frame admission, signaling grace and current-edge recovery.
- [ ] **App discovery and share-start failures.** Retest authorization, Browser
  permissions, control capacity, enumeration and startup. The v1.6.5 Auto-to-VP8
  report needs the Browser exception/assets and actual output; its early
  `stop-share` is not proof of a no-frame timeout. [#419](https://github.com/TNTcraftHIM/Piik/issues/419)
  and [#437](https://github.com/TNTcraftHIM/Piik/issues/437) need matched App reports.
  For `input-texture-create / 0x887a0005`, obtain subsequent candidates and the
  final result; [native media research](./research/native-client-media.md#current-boundary)
  owns hardware evidence and limits.
- [ ] **Native sharing ends unexpectedly.** The v2.0.0 `app/capture/failed` and
  game-entry reports need capture path, codec and matched App diagnostics.
  Locate the first capture/output, preview-bridge, control or authority failure;
  distinguish quiet sources, target/display changes and device loss using
  [capture evidence](./research/native-client-lifecycle.md#quiet-sources-and-viewer-recovery).
  The error key alone identifies neither a driver nor a timeout.
- [ ] **System becomes very laggy after starting a share.** Obtain mode, actual
  codec, profile, display refresh rate and CPU/GPU use, distinguishing startup
  from sustained lag. Compare saturated GPU/game-FPS impact and multi-output
  recovery with the [helper-cost checks](./research/native-client-media.md#windows-helper-cost-2026-09-29)
  before changing allocation or cadence. For Native/SFU stalls, correlate the
  relevant Go runtime using the [GC attribution boundary](./research/realtime-quality-adaptation.md#go-gc-attribution);
  no field report currently establishes GC as its cause.

## Next: P2P Connection And Feedback Evidence

- [ ] **Coordinated Native retry acceptance.**
  Compare the same difficult-network peers with enhancement enabled/disabled,
  including mixed stable/sequential observations in both directions and decoded
  continuity. Preserve the first ordinary attempt, immediate Browser decline
  and fixed deadlines. The [process lab](./research/network-lab.md) and
  [assessment](./research/nat-traversal.md#coordinated-native-punching-assessment)
  own existing controls; random-port overlap and field benefit remain unproven.

Prioritize App-to-Browser and Browser-to-Browser comparisons across interface
changes, lost mappings and asymmetric restrictions, then Native/SFU handoffs
and background P2P recovery. Measure connection success, first-picture time and
failure stage with existing Debug provenance under the [NAT evidence boundaries](./research/nat-traversal.md#gateway-and-survey-limits).
The [Browser-compatible assessment](./research/nat-traversal.md#browser-compatible-follow-up)
owns upgrade and literature evidence; local success is not a field percentage.
Keep Magicsock excluded unless a matched comparison establishes additional
reachability within the [integration boundary](./research/nat-traversal.md#iroh-and-tailscale-comparison).
Keep standard ICE recovery while [renomination's reverse-feedback failure](./research/nat-traversal.md#pion-renomination-preflight)
remains; do not add another retry/transport owner to bypass these limits.

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
8. **Managed Demo hosting.** The [provider assessment](./operations/website.md#managed-hosting-assessment)
    identifies UDP/storage requirements but establishes no cost saving. Keep the
    existing P2P-only Demo; reopen for an accepted provider and operating boundary.
9. **Phone as a Host microphone.** The [input assessment](./research/camera-and-microphone.md#phone-microphone-assessment)
    identifies pairing/revocation and native decoded-input ownership beyond the
    device selector. Reopen for a concrete use case that justifies this boundary
    and physical latency/echo/background checks. This does not reopen room voice.
10. **Remote co-play and mobile controlled platforms.** The [co-play assessment](./research/room-interactions.md#remote-co-play)
    separates virtual gamepad slots from attended keyboard/mouse assistance.
    Desktop input acceptance remains above; independent gamepads and mobile
    controlled endpoints need a separate scope decision.
11. **Multiple simultaneous sharers.** The [party-mode assessment](./research/room-interactions.md#multiple-sharers-assessment-not-implemented)
    separates room administration from publication ownership, with one selected
    picture per Viewer and shared endpoint upload limits. Define publication and
    subscription lifecycles before a prototype. The current one-Host contract
    remains; names and UI follow the model decision.
