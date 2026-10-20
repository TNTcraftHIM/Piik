# Current TODO Ledger

Last reviewed: 2026-10-20

Explicit owner holds remain in force; an investigation does not itself
accept a new feature or architecture. A missing device or reporter trace blocks
only that evidence claim, not unrelated work. Product modules own behavior;
Git/PRs own completed history.

## Now

The 2.x maintenance line retains the published protocol and route owners.
Release artifacts and operator records own exact delivery; remaining product
work is listed below. Broader device coverage does not override the owner's
platform deferrals or establish a diagnosis for unmatched reports.

- [ ] **Remote-control stop shortcut.** Design separately configurable Host
  emergency-stop and Viewer-release chords using the existing local preference
  owners. Windows currently reserves Ctrl+Alt+F10 at App startup; a collision
  disables its input backend. Report the actual registered chord or failure,
  preserve the visible stop action, and keep shortcut changes out of route or
  remote-authority identity.

- [ ] **Return LiveKit to an upstream pin.** Native publication now supplies
  unmet encoder demand to the existing allocator through the scoped dependency
  revision submitted in [upstream #5016](https://github.com/livekit/livekit/pull/5016).
  When maintained upstream provides this input, pass the same recovery gate and
  remove the temporary replacement. [Provenance and removal](../internal/thirdparty/README.md#local-encoder-probe-demand)
  own that boundary; this local repair does not diagnose the unmatched field
  reports below.

- [ ] **New promotional film.** Refine the accepted short proof's art direction
  into a standalone Chinese/English introduction that assumes no earlier film.
  Functional and mechanism work takes priority. Keep the draft in the online
  review player; export video only after the owner accepts that preview.
  Keep sharing, invitation, Host consent
  and playing together causally connected, using product components with staged
  content for actual operations. The local 36-second cut now carries this story,
  including a real reaction picker and a friend's tomato throw;
  refine the two-player party-game vignette, motion, reading time and soundtrack
  before replacing the online film. Depict the published local-Host plus one
  remote-friend keyboard flow; experimental multi-controller features are not claims.

## Held By Owner

- [ ] **Remote-control latency and responsiveness.** Scheduled after this release.
  Compare input-to-visible-response timing on the same endpoints, source and
  network against a mature remote-control implementation. Separate input
  delivery, Host execution, capture/encode and receive/playout; retain the
  existing route and authorization owners. Identify the dominant delay before
  changing budgets or buffering, and compare loss/recovery as well as steady latency.

- [ ] **Persistent-loss estimator replacement.** Deferred by the owner on
  2026-10-18. Retain mature congestion control and accept quality reduction under
  sustained high loss; no custom loss model or release prerequisite is added.
  [Evidence and limits](./research/node-local-media-design.md#persistent-loss-with-low-source-utilization)
  retain the low-utilization collapse and distinguish it from concrete feedback
  accounting or recovery defects, which remain in scope for ordinary fixes.
- [ ] **Multiple remote-control screens.** Deferred by the owner on 2026-10-17.
  Keep one shared source and the existing Host source picker; Viewer-initiated
  screen switching and simultaneous multi-screen streams are later work.
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

- [ ] **Joining participant attribution.** Obtain a matched Browser report if an
  independent remote Viewer's joining avatar again appears as a different local
  Viewer. Compare presence/chat peer IDs with the rendered seat; default names
  and faded waiting colours alone do not establish identity reuse.

- [ ] **macOS bundle startup acceptance (#479).** Verify Finder launch,
  quarantine and capture permissions on a physical Mac. The Mach-O entry and
  helpers are inside `.app`; moved-bundle assembly and both architecture builds
  pass. The corrected packaging has not yet been matched to the reporter's Mac.

- [ ] **macOS sharing with source audio (#486).** Verify actual screen/window
  audio plus microphone startup. Both Darwin architectures compile and pass the
  audio self-test in candidate CI.
  The local repair confirms audio readiness when platform startup succeeds,
  rather than waiting for samples. Go pipe controls preserve video with silent
  or unavailable audio. The reporter's full start-share timeout and separate
  window-filter crash remain unconfirmed; do not close the report on this partial
  correction. [Evidence](./research/native-client-media.md#macos-audio-startup)
  separates the confirmed readiness defect from the unresolved system failures.

- [ ] **Remote-control device acceptance.** Verify physical Android/iOS
  controllers, mixed-DPI displays, commercial games and an actual remote-device
  session. macOS needs Finder/Accessibility, focus, Retina and input checks;
  Linux needs desktop Portal permissions and capture/input checks. Existing
  [evidence and limits](./verification-status.md#device-evidence-boundary) remain
  distinct from build and emulated-controller acceptance.

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
  a router mapping on v2.1.0, but no ICE check responses. Its single STUN URL
  enables ordinary discovery, not the three-destination prediction survey.
  Obtain the retained paired reports; that summary alone does not distinguish NAT filtering,
  upstream mapping or a blocked path.
  [#468](https://github.com/TNTcraftHIM/Piik/issues/468) needs the complete join/
  reauthentication trace on repaired connection-opportunity accounting.
  [#464](https://github.com/TNTcraftHIM/Piik/issues/464) needs matched SFU reports
  after updating; the Viewer-side publication diagnostic was not Host evidence.
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
  still needs a matched App report. The new v2.2.2 log in
  [#437](https://github.com/TNTcraftHIM/Piik/issues/437#issuecomment-6284470067)
  confirms device loss during Auto's synthetic-input preparation, followed by
  actual VP8 fallback. The candidate aligns probe input with live GPU conversion;
  this does not establish the cause of `DEVICE_HUNG`. Retest on the affected device
  before declaring it fixed. For other `input-texture-create / 0x887a0005` reports,
  obtain subsequent candidates and the
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

## Local Interaction Prototypes

- [ ] **Audio-only accompaniment.** Assess sharing one application's audio as
  a Host source, retaining source-audio quality and stereo independently of
  speech permissions. Reuse the room route; check source-only readiness and
  playback before choosing an implementation. Do not use a dummy video or
  silently send accompaniment through the mono speech publication.

- [ ] **Room-voice test packages (#484).** Finish the local normal App/Server/Web
  candidate and distribute it for field acceptance; leave production and the
  public Demo unchanged. One existing controller serves room voice and picture,
  including pre-share creation, Host admission/speaking grants and local mute.
  Normal UI checks cover Peer relaying and embedded SFU; the
  [transport assessment](./research/room-interactions.md#room-voice-transport-assessment)
  owns that evidence. Validate physical microphones/echo, mobile behavior,
  difficult external networks, and concurrent voice/video upload before release.
  The [test-build guide](./guide/getting-started.md#room-voice-in-test-builds)
  describes the integrated controls.

- [ ] **Shared-keyboard remote co-play.** Prototype several consented Viewers
  using the existing input channel and media route. Keep one Host source and
  one grant/retirement owner, track held keys per participant, and release a key
  only after its last holder lets go. Give the shared pointer one explicit owner.
  The local Host-plus-two-Viewer trial covers actual decoded video and encrypted
  input, individual revoke/disconnect, source replacement and stop/rejoin. Review
  the prototype before product integration; its recording sink does not establish
  desktop injection, physical Host key overlap or game compatibility.
  Multiple screens remain deferred. This experiment
  does not accept a new published grant model or claim universal game support.

- [ ] **Optional virtual gamepads for remote co-play.** The owner authorized an
  isolated input-backend experiment on 2026-10-19. Let the Host supply the
  optional dependency; do not install or bundle a kernel driver. Reuse the
  encrypted input route and grant owner, with Host-assigned independent devices
  and neutralization/removal on retirement. Evaluate maintained backends,
  licensing, privileges and real-game recognition before product integration.
  The [input assessment](./research/room-interactions.md#remote-co-play) owns
  platform dependencies and the distinction from shared keyboard/mouse control.

## Next: P2P Connection And Feedback Evidence

- [ ] **External forwarding and participant relays.** Field-test the integrated
  voluntary Peer relay and [optional frp recipe](./operations/self-hosting.md#optional-forward-an-existing-server-with-frp).
  Before adopting frp
  for a deployment, compare loss/recovery and performance on that network; the
  local SFU media/feedback and STUN controls establish feasibility and the address
  limitation, not public-network performance. Keep the [forwarding assessment](./research/nat-traversal.md#external-forwarding-and-participant-relays)
  as the evidence owner; no second graph or App-hosted SFU is integrated.

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
12. **Windows x64 Server packaging (#485).** Review the contributor's package
    extension separately from the maintenance release, including descriptors,
    container filtering, mirror inventory and Windows runtime acceptance.
    Remove the unrelated history-check fallback before integration; an absent
    push base is not a Windows packaging requirement. Existing Linux Server
    packages and Windows App support are unchanged.
