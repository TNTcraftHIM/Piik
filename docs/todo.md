# Current TODO Ledger

Last reviewed: 2026-11-28

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

The first 3.0 internal test targets Windows and Android. Prioritize confirmed
blocking defects in startup, room access, conversation, media, recovery and
shutdown. UI polish, terminal presentation and alternative views follow during
the feedback period; they do not delay that delivery.

## Now

- Capture a visible H.264 stall on an affected setup. Correlate presented frames, received frames and the selected route across the stall. Two foreground viewers continued playing in the [direct and Server relay controls](./research/network-lab.md#hosted-h264-with-two-viewers).

### Active work

- [ ] **Current candidate priority: NAT connectivity.** Compare ordinary ICE
  and enhanced preparation when a configured STUN service is silent. Verify
  successful-socket reuse and handoff, and the discovery of eligible room relays
  after direct failure. Use matched connection and first-media controls before
  changing sampling, deadlines or production defaults.
  Regional reachability controls must identify proxy and tunnel
  participation; an unclassified local Binding success is insufficient.
- [ ] **Beta.62 native interaction performance.** Verify host-owned title-bar
  gestures on the affected setup during More options, playback-popover closure
  and native maximize/restore. Verify the opt-in window-loop timing report with
  an actual delayed event and normal shutdown. Compare host queue delay with
  renderer frames when investigating any remaining stall.
- [ ] **Native caption visual acceptance.** Verify the integrated caption's
  materials against the underlying page in both themes on the matching Windows
  package, including modal surfaces and maximize/restore.
  Restore touch dragging and the native caption context menu with host-owned
  gestures; keep CSS drag regions disabled.
- [ ] **Beta.62 missing chat image thumbnails.** Trace a reported message's
  inline preview, media-clear watermark, readable image and render binding.
  Identify whether older history, newly sent images or both are affected.
- [ ] **Beta.62 webpage startup latency.** The reported source eventually played
  after a long wait. Identify its original-site or App-forwarded path and locate
  the initial read, connection and first-picture delays without interrupting it.
  Trace intermittent stalls and temporary position disagreement after seeking,
  followed by automatic realignment, through the normal Sync watching entry.
- [ ] **Browser session ownership.** Continue accepted
  [ADR-0015](./adr/0015-browser-session-lifetime-owners.md) with follow-latest,
  operation feedback and the remaining capture, embed
  and source-setting operations. Review their acquisition and release at the
  actual resource owner.
  Agree the next file handoff first; retain request correlation and local playback
  choices at their existing owners.
- [ ] **Native optional-flow acceptance.** Complete presented playback and
  physical sound checks alongside the verified capture-enabled encoder worker. Reuse the
  [Driver and SDK controls](./research/network-lab.md#native-desired-capacity);
  keep cross-flow allocation separate from SDK congestion control and frame admission.
- [ ] **Apple UDP source selection.** Include the merged
  [Apple IPv4 source-selection fix](https://github.com/n0-computer/noq/pull/912)
  in macOS acceptance before changing the UDP dependency. Keep patch ownership
  in the [Native provenance](../prototype/channel-native/README.md#rtc-dependency).
- [ ] **Native preparation test under load.** If the completed-success refusal
  control fails again, retain its deadline and scheduling trace. One busy Windows
  run failed while isolated repeats and an idle full run passed; do not infer a
  product timeout change from that result.
- [ ] **Audio device acceptance.** Verify physical output selection, unplugging
  and recovery across shared players. Keep failures actionable without silently
  changing the selected device. Check audible message alerts with the Windows
  App focused and in the background, including when it is visible but unfocused
  or behind another fullscreen window. Check alert suppression while its room's
  conversation popout is focused. Compare throw sounds in their intended window
  states. Room microphones, source audio inputs and system-output capture retain
  their separate scopes.
- [ ] **Capture device loss.** On real hardware, validate what a Windows share
  does when its graphics device is lost (`capture/gpu.rs`, `capture/frames.rs`),
  then state the accepted behaviour in the
  [media standard](./standards/media-quality.md). The published line states a
  rule; 3.0 has the code path and no accepted description.
- [ ] **Webpage source selection and watching continuity.** Complete
  matching-package GUI checks for document navigation, popup selection,
  consecutive source replacements and a viewer reselecting its local video.
  Verify retained viewing, retired media grants and window-group closure through
  the actual Native windows. After an explicit stop, verify the waiting tile,
  viewer dismissal and a separately started share that requires a new Watch
  action. Keep member-site field acceptance separate.
  Revisit quick source and video switching in Piik after the current NAT work;
  moving playback to the original webpage is not a substitute for that flow.
- [ ] **Webpage viewer readiness.** Reproduce reports of a loading viewer shown
  as already watching, including Native original-page playback. Keep membership
  distinct from proved playable media in the viewer surface and participant list.
- [ ] **Virtual LAN invitation and page access.** For intermittent Android 2.x
  failures across browsers, correlate the selected virtual address, effective
  firewall rules and incoming requests. Establish whether page access or media
  delivery failed. For the UU report where only the tab title appears, capture
  the stalled document or script response.
- [ ] **Intermittent App-to-Browser virtual LAN video.** After initial playback
  is reachable, correlate the reported roughly 22-second connection replacement
  cycle with receiver frame counters and the first flow-retirement event.
  Host capture and encoding continue during the observed cycle.
- [ ] **Original webpage closes when a viewer joins.** On the reporting Windows
  setup, correlate the stop reason with the activity, selected page and App
  control connection. Preserve original-page playback when the selected video
  element changes its resource URL; keep media-byte grants bound to the selected
  resource. [Original-page controls](./verification-status.md#current-evidence)
- [ ] **Freeze the first public 3.0 contract.** Decide
  [ADR-0017](./adr/0017-contracts-fixed-before-release.md) against actual readers,
  writers and release storage fixtures. The
  [rule for extending interfaces](./standards/versioning.md#extending-interfaces)
  is set. Complete Browser/App mixed-version artifact acceptance before
  publication alongside the SDK/Server controls.
  Cover every public reader's message families and nested choices, including
  unchanged snapshots, using its actual receive dispatch and populated fixtures.
  Establish unknown outcomes or tested baseline writer projections before the
  first public contract is frozen.
  Confirm the [module and connection-pool owners](./standards/engineering.md#architecture-baseline)
  and [public compatibility boundary](./standards/versioning.md#public-compatibility-promise).
  Verify unknown request outcomes cannot confirm work in the selected Native,
  Browser and SDK readers. Keep API/Bot capabilities within existing actions
  and authority. [Adopted architecture](./adr/0016-shared-rust-core.md) ·
  [Design review](./research/clean-room-design-review.md)
- [ ] **Remaining ownership reductions.** Preserve platform queue retirement
  semantics and the destination writer's validation when sharing their owners.
  Review SQLite single-row storage and a
  full byte-tree wire change only with their concrete ownership benefit and
  regression cost; neither is a demonstrated runtime defect.
- [ ] **Calibrate 3.0 forwarding on independent networks.** Compare the
  [bounded probe and standby policy](./research/channel-forwarding-plan.md#route-planning-procedure)
  with on-demand routing on Browser/App combinations under matched workloads. Measure time to usable media,
  coverage, connection attempts, idle cost and disruption. Repeat the
  [file and voice recovery control](./research/network-lab.md#file-forwarding-during-a-room-call)
  on a shared physical uplink before tuning fanout and retry/standby budgets.
  Reuse local diagnostics for aggregate candidate outcomes, first frame and hops.
  Compare capability-based relay ties and grandparent standby reuse before
  changing either policy; any remotely collected telemetry needs its own decision.
- [ ] **Public Demo room acceptance.** Verify invite-only discovery and entry
  on the deployed public Demo. Check anonymous admission and persisted identity
  growth at the service boundary before choosing additional resource controls.
  [Local package control](./verification-status.md#current-evidence)
- [ ] **Physical camera orientation.** Check portrait capture on a phone through
  Native and pooled Browser paths. Compare the orientation of the source and
  the decoded viewer picture after a device rotation.
- [ ] **Two-App connection failure.** Correlate the reported failed attempt's
  actual source/viewer endpoints, App control state, Native session generations,
  STUN observations and ordinary/enhanced ICE outcome. Two open Apps do not
  establish that their Native endpoints participated in the media route.
- [ ] **beta.33 Browser window selection stalls.** Reproduce manual selection
  of another Chrome window on the reporting machine, including window audio.
- [ ] **App source selection fails or disconnects.** On the reporting platform,
  capture the failed source request's elapsed time and outcome. If App control
  disconnects during webpage selection, capture its first close diagnostic to
  distinguish a control failure from a picker timeout or enumeration failure.
  On Android, verify request-scoped system selection on the matching package:
  rejected admission, cancellation with the picker open, and a cancelled
  request's delayed intent while another selection is pending.
- [ ] **Member-video viewing on the reporting network.** Verify the authorized
  source with the updated App and Browser on that network. Record the selected
  player and sharing mode, then locate any remaining source-access or delivery failure.
  [Member-video controls](./verification-status.md#current-evidence)
- [ ] **beta.33 shared-screen blur and brief stalls.** Correlate capture,
  encoder input/output, requested/applied quality, selected route and receiver
  cadence during an actual episode before attributing it to conservative probing.
  Check equivalent 2.x timeout owners separately from the new webpage-player path.
- [ ] **beta.32/33: no media with a weak site and strong source.** Capture the
  affected peers' source limit, selected route and first received media on
  independent networks. The [three-browser control](./research/network-lab.md#screen-capacity-with-an-unreachable-first-viewer)
  measures how a prior viewer's pending assignment occupies a source slot.
- [ ] **Native performance under the reported workload.** Measure capture,
  conversion, encoding and decoded cadence on the affected machines during
  normal use and contention. Identify the limiting stage before changing quality
  policy. Explicit hardware-encoder failure recovery does not establish smooth
  playback or lower resource use while hardware encoding still succeeds.
- [ ] **Windows H.264 format changes.** Verify hardware output renegotiation on
  the Intel setup reported in [#452](https://github.com/TNTcraftHIM/Piik/issues/452).
  Retain the hardware and software encoder's frame, bitrate and retirement
  contracts; injected notifications are separate from driver-generated changes.
- [ ] **2.x periodic brief picture stalls.** With a particular Host or Viewer,
  normally clear playback pauses for less than half a second every few seconds
  or tens of seconds, skips several frames and sometimes briefly blurs. A roughly
  2% loss observation is not yet correlated with the stall. Compare existing
  sender, relay and receiver timing, frame dimensions and repair counters before
  attributing this to loss, codec adaptation or changing sender latency. Keep
  optional receive buffering separate from identifying this report's cause.
- [ ] **Windows shared sound only works with process exclusion.** The beta.29
  reporter needs any process excluded for viewers to hear sound, while beta.25
  works normally. Compare default-endpoint packets and queue/output progress
  with process loopback on that setup. For [#534](https://github.com/TNTcraftHIM/Piik/issues/534), record the application's
  playback endpoint and capture result before and after first using exclusion.
  The [output-routing control](./research/media-fidelity.md#windows-output-routing)
  reproduced the contrast on an alternate endpoint. Each setup still needs its own trace.
- [ ] **Host UDP errors and blurry viewing.** A reported beta.25 Host repeatedly
  prints Windows network-unreachable error 10051 while a friend can view a blurry
  picture. Identify whether the errors affect the selected media path or other
  ICE candidates, and correlate receive resolution with network and encoder
  budgets. The old console line lacks that association; do not treat the newer
  removed-local-address repair as resolution without a matching control.
- [ ] **beta.25 mobile reconnect report.** Identify the actual Browser RTC setup
  error or socket-close cause on the reporting phone. The supplied recording
  shows site reconnection while waiting for a shared picture.
- [ ] **3.0 viewing remains at 60 fps above the requested setting.** Collect the
  actual capture source, applied resolution/frame rate and receiver counters for
  the reported path. Compare capture, encoded, received and decoded cadence;
  identify the displayed statistic. Controlled worker measurements stay in the
  [encoder assessment](./research/webrtc-encoder-pool.md#rust-worker-cadence-control).
- [ ] **3.0 Windows shared-sound noise.** The reporter confirms electrical or
  crackling sound in beta9/10 as well as beta2, while 2.x sounds normal. Excluding
  the window titled Piik removes it; excluding a silent unrelated window does
  not. Its selected process identity remains unconfirmed. The
  [PCM continuity correction](./research/media-fidelity.md#30-pcm-continuity)
  fixes a separate reproduced defect; verify the updated candidate on the
  reported setup and whether intended sound remains after exclusion. Neither
  that correction nor the earlier local-preview fix yet explains the PID-specific report.
- [ ] **Release mirror platform integration.** Verify a supported way to create
  the platform's Release tag or trigger its immediate synchronization during
  publication. Do not assume disabling Pull synchronization makes the repository
  writable. [Mirror operations](./operations/github.md#atomgit-download-mirror) owns setup.
- [ ] **Blue-tinted sharing (#529).** The report has no source, codec, GPU or
  HDR/SDR details. Existing SDR conversion evidence cannot identify its cause;
  obtain a sender/receiver colour-bar or solid-colour comparison before changing
  bitrate, colour metadata or filters.
- [ ] **3.0 iOS/iPadOS room voice feedback.** With noise processing disabled on
  the phone/tablet, a computer listener reports mono sound. Check that device's
  raw capture channels against its received sound; the shared microphone,
  two-hop relay and per-person volume paths retain stereo in controlled input.
  [Media fidelity](./research/media-fidelity.md#30-room-microphone) owns the evidence.
  Keep the published 2.x mono contract separate.
- [ ] **Linux capture ends after selection (#499).** Follow
  [#499](https://github.com/TNTcraftHIM/Piik/issues/499) on niri/Wayland with
  GStreamer NVENC. The Browser report records capture ending before connection
  cleanup; obtain the native capture failure to distinguish the encoder and Portal.
- [ ] **Mouse input stops when Host Chrome is minimized (#502).** The
  [supplied v2.5.2 reports](https://github.com/TNTcraftHIM/Piik/issues/502)
  retain the grant and receive authorized mouse events, but Windows `SendInput`
  rejects a button event and subsequent release attempts. The reporter still
  sees remote control stop after returning to the desktop in v2.8.0; obtain a
  matching diagnostic and distinguish mouse from keyboard input. The v2.8.0
  reporter confirms physical mouse input still works and restoring Host Chrome
  before disconnection restores control without a new grant. Compare the input
  stage counters across that minimize/restore interval.
  Keep the existing grant/release semantics and locate the OS rejection trigger
  before adding desktop recovery. Any recovery must restore the calling thread's
  desktop context and release owned handles. The local controlled Chrome trial
  did not reproduce the failure; reporter-machine SendInput and physical-input
  acceptance remain open.
- [ ] **2.x: return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.
- [ ] **Replace the official webrtc-rs/rtc Git pin with a published release.** Follow
  the merged parser repair in
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency).
  Once a release includes it, verify the consumers and remove the Cargo patch entries.
- [ ] **Return portmapper to an upstream release.** Follow
  [upstream PR #268](https://github.com/n0-computer/net-tools/pull/268), then
  verify an official release containing the repair.
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency)
  owns the temporary pin and removal procedure.
- [ ] **GNOME cancellation cleanup submission.** Submit the independently
  verified Mutter repair when GitLab authentication is available, under the upstream
  contribution rules. The
  [network design](./research/channel-network-design.md#implementation-boundary)
  owns its cause and validation; Piik does not bundle a compositor fork.
- [ ] **2.x: return Pion to an upstream pin.** Follow
  [upstream #3668](https://github.com/pion/webrtc/pull/3668). Once upstream
  includes equivalent H.264 profile matching, verify the receiver and forwarding
  controls and remove the temporary replacement. [Dependency provenance](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md#pion-h264-profile-matching)
  owns the patch and removal boundary.

## Next

- [ ] **Concurrent App invitation entries.** Let local and public entries reach
  the same running authority. Define their startup, advertised addresses and
  stop behavior through the existing launcher and listener owners before
  replacing the current exclusive launch choice.

- [ ] **Quiet topology improvement.** Decide
  [ADR-0018](./adr/0018-quiet-topology-improvement.md). Stage 0 is offline:
  replay the planner on exported diagnostics and look for an opportunity that
  recurs. Resolve the Native observation boundary against receiver playback:
  encoder restrictions, representation selection and pair allocation do not
  yet establish one per-flow limitation reason. Keep automatic trial admission
  on hold until that comparison distinguishes harmless and harmful admission.
  The first production step is one more child tried on unmet demand,
  then one leaf moved to a strictly better place with the present proof.
  The [evidence](./research/topology-improvement-design.md) lists the
  remaining comparisons. Retain the room's explicit voice limit and compare
  Native forwarding cost with the measured Browser hops. Extend relay-exit controls to media-only loss while
  signaling stays connected, and preserve healthy paths during control recovery.
  Reuse the matching-runtime recovery and late-proof controls when extending
  current operation ownership. Calibrate on independent networks before tuning
  candidate budgets or measured-benefit policy.
- [ ] **The life of a message.** Decide
  [ADR-0019](./adr/0019-the-life-of-a-message.md): author editing, quote
  behavior and the merge rule for text and reaction changes. Search is not
  built. Set stored fields and requests with their
  consumers. Before publication, verify that supported archive round trips
  preserve meaningful row data.
- [ ] **One vocabulary for extension.** Decide
  [ADR-0020](./adr/0020-one-vocabulary-for-extension.md). Before the first
  release: settle message fields that a reader ignores and a writer leaves
  out, and strict archive boundaries, through the actual Rust, Browser and
  SDK consumers. Editing supplies the first concrete new request; no
  extension interface or generic capability registry is built. A part interface is weighed only by a bounded
  comparison with plain lifecycle-owner extraction.
- [ ] **Remote-writer route continuity.** Measure writer round-trip time and
  cold repair on independent networks. The
  [local writer control](./research/topology-improvement-design.md#room-writer-turn-cost)
  found no history scan or persistent write during route turns. Any proposal
  to continue new room grants while its writer is offline must define their
  revocation and lifetime separately from physical-pair reuse.
- [ ] **Prepared-path migration after TURN.** Extend the verified Native
  transport handoff to full App signaling and independent networks. Correlate
  selected-path traffic with picture and sound continuity; unknown candidate
  provenance remains bounded preparation, not a claim that the path is direct.
- [ ] **Physical keyframe acceptance.** Check Android codec initialization,
  requested keyframes and rebuilding with the longer interval. Extend the
  Windows hardware control beyond the tested NVIDIA encoder and short sequence.
  Compare admitted input and actual output around forced frames and codec priming.
- [ ] **Rust formatting and diagnostics.** At an agreed file handoff, apply a
  separate mechanical format pass and review actionable Clippy findings by owner.
  Keep style-only changes separate from behavior fixes and new lint gates.
- [ ] **3.0 documentation ownership.** Review remaining research files that
  differ from their 2.x copies, unused research data and outdated couch markers
  against current readers and code.
- [ ] **Whole-page collaboration.** Choose the intended co-browsing flow before
  extending synchronized playback. Evaluate a shared page with explicitly
  granted page-scoped input and each site's own collaborative links. Reuse the
  existing media and input owners; verify viewport coordinates, focused text
  entry and native dialogs before offering page-only control.
- [ ] **App update distribution.** Configure the production signing identity and
  decide the beta-feed policy before distributing updater-capable packages;
  retain manual download. The
  [delivery proposal](./research/cross-platform-client-runtime.md#30-app-update-delivery)
  keeps authority, active sessions and data outside the download operation.
- [ ] **Managed one-click deployment.** Validate an ordinary Piik room and data
  recovery on a persistent hosting target. The
  [deployment assessment](./deployment.md#managed-one-click-hosting) distinguishes
  a full Server from a Vercel-hosted frontend that still needs an external Server.
- [ ] **Accept the unified 3.0 sharing experience.** Review the optional
  screen-centred view with the owner and repeat the first share on the release
  candidate. At integration, resolve main CI against the Rust release jobs and
  align the homepage, public source links, Pages guides, latest downloads and
  Demo with the published version. Pin historical 2.x references at the final
  2.x revision.
  Publish the 2.x pinning guidance and verify clear startup refusal for recognized
  incompatible configuration before changing the default major
  ([evidence](./research/container-tags.md)).
  End separate 2.x maintenance at the accepted 3.0 cutover. Decide
  separately whether to offer a short room-code locator.
- [ ] **3.0 playable-route improvement.** Define when a sustained limit warrants
  replacing a playable upstream. Set bounded candidate attempts, a resource budget
  for overlap and strict-benefit proof through the current switch owner. Account
  for disruption on a rejected trial and delayed natural recovery.
  [Controlled switch evidence](./research/network-lab.md#playable-route-improvement)
  Separately compare stable downstream senders during input replacement, measuring
  SDP, keyframes and visible gaps while retaining generation and access fencing.
- [ ] **Field-test same-room screen recovery.** On restricted networks,
  compare [on-demand relay](./research/channel-network-design.md#idle-room-peers-for-delivery-recovery)
  under the [layered-forwarding validation plan](./research/channel-forwarding-plan.md#review-and-validation-plan)
  after model review. Measure first picture, recovery when a peer leaves, load
  on an existing call and the cost of finding a path through two idle peers.
- [ ] **NAT field coverage.** Measure difficult physical networks and sustained
  concurrent use. [Random-mapping and linear-extension controls](./research/nat-traversal.md#random-mapping-collision-control)
  Compare parallel surveys and search budgets under the same preparation deadline
  before changing the accepted limits.
  Prepare the isolated survey observer independently of the Demo service.
  Package the survey client only after carrying forward its candidate-window
  and reply-origin corrections; verify same-IP filtering separately from
  cross-IP mapping and preserve destination identity in offline replay.
  Evaluate the isolated allocator proposal against held-out per-destination
  mappings, including burst allocations and missing observations; then verify a
  bounded schedule through authenticated preparation and ICE transfer.
  The [field survey](./research/nat-traversal.md#field-survey-and-search-order)
  proposes a pool made between two observations, published as a window per
  address. Compare it under the present deadline. Run a physical pair across
  a network with a counter per destination on the present search order and
  default servers. Measure partial-observation recovery and the defaults from several
  regions after the survey reports missing defaults even with zero or one
  response. Then compare a wider bounded set that keeps each request's index
  and treats a step across a gap as unknown.
  [Allocator controls](./research/nat-traversal.md#allocator-prediction-controls)
  Verify interface-scoped mDNS candidate resolution before adding a resolver.
  Define optional Server-port STUN exposure and authenticated ICE dispatch before
  adding a discovery responder to its existing socket owner.
- [ ] **Codec capability and efficiency comparison.** Measure actual platform
  encoder/decoder and Browser capabilities, then compare one available codec
  with H.264 using synthetic text and motion. Compare hardware and software
  execution under CPU/GPU contention, separating capture/copy, encoding and
  network cost. Include compatible H.264 forwarding cost and sustained runtime
  adaptation; keep congestion control with the RTC owner. Actual GPU-contention
  measurements are still needed to establish hardware/software switching benefit.
  AV1/HEVC product integration remains a separate decision. Review the
  [codec interoperability proposal](./research/webrtc-encoder-pool.md#proposed-codec-interoperability-boundary)
  before extending codec or conversion implementations.
- [ ] **Browser content and pool tradeoffs.** Compare text/motion hints through
  the actual startup, clone and pool paths before changing persistent content
  policy. Compare pooled and ordinary Host/relay delivery at matching quality,
  separating sender encoding from receiver and measurement cost. Keep the current
  pool until measured delivery tradeoffs justify narrowing or removing it.
- [ ] **Native representation selection.** Compare forwarding an available
  lower layer with encoding full-size output at the granted rate. Reuse existing
  encoder grants and prove readability, cadence and resource cost before changing
  layer preference.
- [ ] **Native GUI recovery acceptance.** Complete Windows WebView checks in
  both negotiation roles with the matching App. Reuse the
  [SDK and runtime controls](./research/nat-traversal.md#native-ice-disconnection-and-send-consent)
  for send-consent expiry, input release and branch recovery.
- [ ] **Shared-link website coverage.** Extend actual website and official
  embedded-player coverage toward VideoTogether's playback coverage. Verify
  source-issued media grants, supported commercial live sources, target Browsers
  and cross-network delivery. Trace observed responses through frame association
  before extending discovery. Verify provider restoration in the matching App
  and explicit audio selection on a real page with multiple AAC tracks.
  Retry girigirilove when the original player is
  accessible. Explain the trusted-site scope and local website login before use.
  [Playback and authority boundaries](./research/channel-network-design.md#synchronized-video-sources) ·
  [Website evidence](./verification-status.md#current-evidence)
- [ ] **3.0 Native platform acceptance.** Complete same-room Windows/Android
  admission, two-way chat, Android image preview and live audio/video on the
  matched packages. Verify physical Android capture and media-path recovery,
  and the Windows WebView entry with physical microphones
  and cameras. Check owner entry through the matching App's launcher, terminal
  and automatic startup. Investigate the observed WebView renderer exit during room
  navigation. Exercise macOS Quit, Dock/Finder return, permissions, physical
  capture, sound and input. Verify Linux hardware encoding and physical sound,
  and complete the remaining Linux distribution OBS checks. Verify the App
  source picker and Browser sharing on Cinnamon/X11 without a ScreenCast portal
  backend before deciding the native capture support scope.
  [#552](https://github.com/TNTcraftHIM/Piik/issues/552) ·
  [Device evidence](./verification-status.md#device-evidence-boundary) ·
  [Local OBS coverage](./research/room-interactions.md#local-obs-input)
- [ ] **Enhanced microphone suppression on physical devices (#518).** Compare
  matched-level voice clarity, acoustic echo and mobile runtime cost for the
  optional RNNoise mode.
  [Microphone assessment](./research/media-fidelity.md#stronger-microphone-suppression)

## Held By Owner

- [ ] **Browser/App pairing codes.** Keep automatic App discovery and existing
  per-site approval. A separate first-connection pairing step is declined.
- [ ] **Non-Web desktop interface.** Keep the graphical status-window proof and
  native widget rewrite out of the desktop product.
  [Runtime assessment](./research/cross-platform-client-runtime.md#30-windows-native-entry-prototype)
- [ ] **Automatic room-voice exclusion from Native display sound.** Deferred
  from the first 3.0 internal test. Keep Browser playback; the
  [playback/AEC boundary](./research/channel-network-design.md#implementation-boundary)
  owns the later design constraints.
- [ ] **iOS native App.** Paused in favor of Browser use. Preserve the isolated
  implementation on `feat/ios-client`; native development and publication stay
  outside the current phase.
- [ ] **Additional collaboration cursors.** Deferred by the owner. Keep the
  shared system mouse; do not add multi-cursor or pointer-ownership visualization.
- [ ] **Persistent-loss estimator replacement.** Deferred on 2026-10-18.
  Keep mature congestion control and accept quality reduction under sustained
  high loss; concrete accounting/recovery defects remain ordinary bug fixes.
  [Evidence](./research/node-local-media-design.md#persistent-loss-with-low-source-utilization).
- [ ] **2.x remote control across multiple screens.** Deferred on 2026-10-17.
  Keep remote input bound to one process-wide source.
- [ ] **32-bit Windows/Linux Apps.** Deferred on 2026-10-02. No package or
  website option is planned.
- [ ] **Windows ARM64 App.** Deferred on 2026-10-03. Keep Windows downloads x64-only.
- [ ] **Alternative public-invitation providers.** Deferred on 2026-10-16.
  Keep Cloudflare Quick Tunnel. The [provider assessment](./research/cross-platform-client-runtime.md#alternative-invitation-providers)
  owns alternatives and tradeoffs.

## Parked Product Work

- **First-Join pacing.** The supported-scale control showed no queue benefit.
  Reopen only on an observed admission burst that closes a room writer; review
  the directory visibility and synchronization contract before adding a queue.
- **NDI and additional codecs (#535, #530).** Assess NDI through the existing
  OBS/DistroAV-to-WHIP input before considering another native dependency.
  VP9/AV1/SVC support needs a concrete interoperability and resource decision.
  AV1 and H.265 implementation is deferred by the owner; compare hardware
  efficiency, frame delivery and compatible fallback before proposing adoption.
  Transport feedback and retransmission remain with the existing RTC owner;
  investigate a demonstrated defect there separately from codec expansion.
- **Native H264 scene-change latency.** Revisit an encoder or SDK improvement
  that reduces coded-frame bursts while preserving quality and live recovery.
  [Encoder assessment](./research/webrtc-encoder-pool.md#h264-burst-and-recovery)
- **Keyframe request spacing.** Measure repeated receiver requests against
  existing output deduplication before adding a minimum interval that could delay recovery.
- **Server TCP media candidates.** Verify pinned SDK framing, Browser
  interoperability and integration with the existing pair owner before proposing
  a transport option. A TCP protocol enum alone does not establish support.
- **Virtual gamepads beyond Windows.** Verify Linux desktop permissions and
  physical game recognition. macOS virtual HID needs an entitled App and SDK/runtime
  checks. [Co-play assessment](./research/room-interactions.md#remote-co-play)
- **Platform output.** A registered receiver may act as an ordinary Viewer after
  the [platform-output gate](https://github.com/TNTcraftHIM/Piik/blob/main/docs/research/platform-output.md) passes.
- **Additional languages.** Review community catalogs and rendered UI through
  the [translation guide](./guide/translating.md).
- **Windows code signing.** Revisit when a trusted signing service is available;
  sign executables before archive checksums. Signing does not guarantee the end
  of antivirus cloud scanning.
- **macOS distribution signing.** Developer ID signing and Apple notarization
  need an Apple Developer identity. [#489](https://github.com/TNTcraftHIM/Piik/issues/489)
  reports first-launch blocking; the troubleshooting guide provides a scoped
  opening procedure, not a signing fix. Verify downloaded bundles on a Mac when
  signing becomes available.
- **Managed Demo hosting.** Keep the existing P2P-only Demo pending a concrete
  option. [Provider assessment](./operations/website.md#managed-hosting-assessment)
- **Phone as a Host microphone.** Revisit only for a concrete use case that
  justifies the [pairing and input boundary](https://github.com/TNTcraftHIM/Piik/blob/e79e658d5f2430e2b40534b1dfe20b2d20d344b0/docs/research/camera-and-microphone.md#phone-microphone-assessment).
- **Mobile controlled endpoints.** Separate scope from desktop keyboard/mouse
  control and desktop co-play.
