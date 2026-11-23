# Current TODO Ledger

Last reviewed: 2026-11-22

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

The first 3.0 internal test targets Windows and Android. Prioritize confirmed
blocking defects in startup, room access, conversation, media, recovery and
shutdown. UI polish, terminal presentation and alternative views follow during
the feedback period; they do not delay that delivery.

## Now

- Capture a visible H.264 stall on an affected setup. Correlate presented frames, received frames and the selected route across the stall. Two foreground viewers continued playing in the [direct and Server relay controls](./research/network-lab.md#hosted-h264-with-two-viewers).

### Active work

- [ ] **Original webpage closes when a viewer joins.** On the reporting Windows
  setup, correlate the stop reason with the activity, selected page and App
  control connection. [Original-page controls](./verification-status.md#current-evidence)
- [ ] **Freeze the first public 3.0 contract.** Confirm the
  [module and connection-pool owners](./standards/engineering.md#architecture-baseline)
  and [public compatibility boundary](./standards/versioning.md#public-compatibility-promise)
  against actual readers, writers and stored samples. Keep API/Bot capabilities
  within existing actions and authority.
- [ ] **Calibrate 3.0 forwarding on independent networks.** Compare the
  [bounded probe and standby policy](./research/channel-forwarding-plan.md#route-planning-procedure)
  with on-demand routing on Browser/App combinations under matched workloads. Measure time to usable media,
  coverage, connection attempts, idle cost and disruption. Repeat the
  [file and voice recovery control](./research/network-lab.md#file-forwarding-during-a-room-call)
  on a shared physical uplink before tuning fanout and retry/standby budgets.
- [ ] **Public Demo room acceptance.** Verify invite-only discovery and entry
  on the deployed public Demo. [Local package control](./verification-status.md#current-evidence)
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
- [ ] **Whole-system sound in beta.29.** The reporter hears normal sound in
  beta.25, but beta.29 needs any process excluded before sound reaches viewers.
  Compare default-endpoint packets and queue/output progress with process
  loopback on that setup; the capture and mixing code is unchanged between the
  two builds. Keep this report distinct from the earlier process-specific noise.
- [ ] **Host UDP errors and blurry viewing.** A reported beta.25 Host repeatedly
  prints Windows network-unreachable error 10051 while a friend can view a blurry
  picture. Identify whether the errors affect the selected media path or other
  ICE candidates, and correlate receive resolution with network and encoder
  budgets. The old console line lacks that association; do not treat the newer
  removed-local-address repair as resolution without a matching control.
- [ ] **beta.25 mobile reconnect report.** Identify the actual Browser RTC setup
  error or socket-close cause on the reporting phone. The supplied recording
  shows site reconnection while waiting for a shared picture. A reproduced RTC
  constructor failure is now isolated from the site socket; confirm the reporting
  device's cause before treating this boundary repair as resolution of that report.
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
- [ ] **Windows sound only works with exclusion (#534).** Compare the affected
  application's playback endpoint with Piik's default-endpoint capture. The
  [output-routing control](./research/media-fidelity.md#windows-output-routing)
  reproduces this contrast with an alternate output device; the reported change
  after first using exclusion remains to be located.
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
- [ ] **Virtual-LAN page loading.** Investigate the UU report where only the tab
  title appears and the page never loads. Static compression reduces transfer
  size; capture the stalled document/script response to locate this failure.
- [ ] **Linux capture ends after selection (#499).** Follow
  [#499](https://github.com/TNTcraftHIM/Piik/issues/499) on niri/Wayland with
  GStreamer NVENC. The Browser report records capture ending before connection
  cleanup; obtain the native capture failure to distinguish the encoder and Portal.
- [ ] **Mouse input stops when Host Chrome is minimized (#502).** The
  [supplied v2.5.2 reports](https://github.com/TNTcraftHIM/Piik/issues/502)
  retain the grant and receive authorized mouse events, but Windows `SendInput`
  rejects a button event and subsequent release attempts. The reporter still
  sees remote control stop after returning to the desktop in v2.8.0; obtain a
  matching diagnostic and distinguish mouse from keyboard input. Capture whether local
  physical input also stops during the refusal to identify its OS trigger.
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
- [ ] **Refresh the MPD script runtime.** Follow the supported QuickJS-NG update
  in [rquickjs #793](https://github.com/DelSkayn/rquickjs/pull/793), including
  allocation-failure cleanup fixes. Verify the parser and binding behavior before
  replacing the current released pin; the proposed update still fails upstream
  compatibility checks.
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
  candidate. End separate 2.x maintenance at the accepted 3.0 cutover. Decide
  separately whether to offer a short room-code locator.
- [ ] **3.0 playable-route improvement.** Define when a sustained limit warrants
  replacing a playable upstream. Set bounded candidate attempts, a resource budget
  for overlap and strict-benefit proof through the current switch owner. Account
  for disruption on a rejected trial and delayed natural recovery.
  [Controlled switch evidence](./research/network-lab.md#playable-route-improvement)
- [ ] **Field-test same-room screen recovery.** On restricted networks,
  compare [on-demand relay](./research/channel-network-design.md#idle-room-peers-for-delivery-recovery)
  under the [layered-forwarding validation plan](./research/channel-forwarding-plan.md#review-and-validation-plan)
  after model review. Measure first picture, recovery when a peer leaves, load
  on an existing call and the cost of finding a path through two idle peers.
- [ ] **NAT field coverage.** Measure difficult physical networks and sustained
  concurrent use. [Random-mapping and linear-extension controls](./research/nat-traversal.md#random-mapping-collision-control)
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
- [ ] **Native send-consent lifetime.** Review the RTC owner's response-based
  expiry against RFC 7675, including delayed processing and its existing Chrome
  interoperability correction. Keep transport consent and Piik route recovery
  with their existing owners; validate the SDK driving contract before relying
  on an isolated timeout reproduction.
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
  and cameras. Investigate the observed WebView renderer exit during room
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
- **Virtual gamepads beyond Windows.** Verify Linux desktop permissions and
  physical game recognition. macOS virtual HID needs an entitled App and SDK/runtime
  checks. [Co-play assessment](./research/room-interactions.md#remote-co-play)
- **Platform output.** A registered receiver may act as an ordinary Viewer after
  the [platform-output gate](./research/platform-output.md) passes.
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
  justifies the [pairing and input boundary](./research/camera-and-microphone.md#phone-microphone-assessment).
- **Mobile controlled endpoints.** Separate scope from desktop keyboard/mouse
  control and desktop co-play.
