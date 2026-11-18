# Current TODO Ledger

Last reviewed: 2026-11-17

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

The first 3.0 internal test targets Windows and Android. Prioritize confirmed
blocking defects in startup, room access, conversation, media, recovery and
shutdown. UI polish, terminal presentation and alternative views follow during
the feedback period; they do not delay that delivery.

## Now

- [ ] **3.0 architecture convergence.** Trace product responsibilities through
  the [module, contract and lifecycle owners](./standards/engineering.md#module-map)
  into current functions and resource lifetimes. Use source-linked diagrams to
  identify competing writers, unnecessary coupling and replaceable private
  experiments. Converge each affected boundary before migrating its consumers;
  continue independent confirmed fixes and scoped experiments in parallel.
- [ ] **Room people responsibilities.** Resolve whether the left room list
  should show personal voice/sharing/watching activity or the broader transport
  participants it currently includes. Keep the couch's room presence and the
  directory's current-room group aligned. The proposed narrower activity list
  excludes hosting, forwarding and file-only work; leave its membership unchanged
  until this product choice is settled.
- [ ] **Video-orientation capability.** Align negotiated rotation extensions
  with the metadata actually carried through Native and pooled Browser media.
  Verify sender behavior before claiming rotated-camera interoperability.
- [ ] **Two-App connection failure.** Correlate the reported failed attempt's
  actual source/viewer endpoints, App control state, Native session generations,
  STUN observations and ordinary/enhanced ICE outcome. Two open Apps do not
  establish that their Native endpoints participated in the media route.
- [ ] **beta.33 Browser window selection stalls.** Locate the first stalled
  stage after choosing another Chrome window in the system screen picker.
  Preserve the current share on failed replacement.
- [ ] **beta.33 authenticated webpage sharing.** Reproduce the reported VIP
  video failure after the sharer has started and the viewer receives no picture.
  Use the user's authorized source. Distinguish page playback,
  source discovery, original-byte access and receiver delivery; ordinary-video
  acceptance does not establish this path.
- [ ] **beta.33 shared-screen blur and brief stalls.** Correlate capture,
  encoder input/output, requested/applied quality, selected route and receiver
  cadence during an actual episode before attributing it to conservative probing.
  Check equivalent 2.x timeout owners separately from the new webpage-player path.
- [ ] **beta.32/33: no media with a weak site and strong source.** Reproduce
  the reported topology and locate the first missing picture/audio delivery fact
  across room authority, selected source, forwarding plan and actual receiver.
  Complete the separate Server-transit candidate's authority and matched-runtime
  acceptance before considering it for this report.
- [ ] **Native performance under the reported workload.** Measure capture,
  conversion, encoding and decoded cadence on the affected machines during
  normal use and contention. Identify the limiting stage before changing quality
  policy. Explicit hardware-encoder failure recovery does not establish smooth
  playback or lower resource use while hardware encoding still succeeds.
- [ ] **Current webpage-source and playback package acceptance.** Verify the
  pending source-selection, popup/player association, provider hide/restore and
  playback-control changes on the reported accessible websites in a matching
  Windows App/Web package. Cover failed replacement retaining the active source,
  original-page closure, and independent viewer playback with and without
  explicit forwarding. Broader website/live coverage remains below.
- [ ] **Native console/terminal package acceptance.** Check the matching package's
  silent native entry, explicit Browser terminal, unavailable-WebView fallback,
  and interactive quit/update restart.
  Locate the shutdown stall observed after a controlled webpage-recovery run:
  the source App reported stopped but its main window remained unresponsive.
- [ ] **2.x periodic brief picture stalls.** With a particular Host or Viewer,
  normally clear playback pauses for less than half a second every few seconds
  or tens of seconds, skips several frames and sometimes briefly blurs. A roughly
  2% loss observation is not yet correlated with the stall. Compare existing
  sender, relay and receiver timing, frame dimensions and repair counters before
  attributing this to loss, codec adaptation or changing sender latency. Keep
  optional receive buffering separate from identifying this report's cause.
- [ ] **App connection during webpage selection.** Capture the first control
  connection failure during the reported intermittent App disconnection. Use the
  opt-in control-close diagnostic to distinguish transport closure, handshake,
  invalid events and consumer failures before changing recovery behavior.
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
  rejects a button event and subsequent release attempts. Capture whether local
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
- [ ] **Replace the official str0m Git pin with a published release.** When a
  release includes the required NACK, bandwidth-estimation and SDP-mapping repairs
  listed in Native dependency provenance, replace the immutable upstream pin
  through the existing consumer checks and
  [dependency provenance](../prototype/channel-native/README.md#rtc-dependency).
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

- [ ] **Native site-switch appearance.** Clear the previous page's dialog
  shading while the next site loads or shows an error.
- [ ] **Public 3.0 interface baseline.** Design same-major evolution around
  stable existing actions and concrete optional capabilities, keeping permission
  independent of advertised support. Apply the
  [versioning contract](./standards/versioning.md#public-compatibility-promise)
  to future API/plugin boundaries; introduce storage conversion only for a real
  representation change, without retaining obsolete private-beta interfaces.
- [ ] **App update distribution.** Configure the production signing identity and
  decide the beta-feed policy before distributing updater-capable packages;
  retain manual download. The
  [delivery proposal](./research/cross-platform-client-runtime.md#30-app-update-delivery)
  keeps authority, active sessions and data outside the download operation.
- [ ] **Managed one-click deployment.** Validate an ordinary Piik room and data
  recovery on a persistent hosting target. The
  [deployment assessment](./deployment.md#managed-one-click-hosting) distinguishes
  a full Server from a Vercel-hosted frontend that still needs an external Server.
- [ ] **Accept the unified 3.0 sharing experience.** Owner review and matched-package
  acceptance remain for the optional screen-centred view and its explicit first-share
  flow. The existing room runtime, full-workspace default and activity lifetimes
  remain shared. End the separate 2.x maintenance line only at the accepted 3.0
  cutover; fix confirmed defects during the transition. A short room-code locator
  remains a separate product decision.
- [ ] **3.0 playable-route improvement.** Resolve replacing a still-working
  but persistently limited upstream against the accepted multi-source model.
  Define evidence and resource cost before extending the current switch owner;
  2.x route-policy labels do not directly describe these 3.0 paths.
  The [controlled switch](./research/network-lab.md#playable-route-improvement)
  demonstrates benefit and independent-lease retention. Define the production
  trigger, bounded candidate attempts and strict-benefit proof before enabling
  automatic alternative-parent trials. Online sessions do not prove reusable
  physical connections; keep that fact with the transport owner.
  The controls also show delayed natural recovery and an incumbent freeze during
  a rejected trial. Distinguish sustained path limits and bound the cost of
  overlapping candidates before enabling automatic quality trials.
- [ ] **NAT field coverage.** The bounded random-mapping Native implementation
  and ordinary Native-to-Browser linear extension have controlled media and
  retirement evidence. Measure difficult physical networks and sustained
  concurrent use; these controls do not establish population success rates.
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
- [ ] **Shared-link website coverage.** Extend the implemented webpage player
  and original-media forwarding toward VideoTogether's playback coverage.
  Validate actual supported websites, source-issued media grants, commercial live
  sources within the standard PDT/64 KiB boundary, target Browser behavior and
  cross-network delivery. Live sources without a usable program-time mapping,
  larger live playlists and low-latency HLS remain outside that first boundary. The
  [verification record](./verification-status.md#current-evidence) separates the
  matched Bilibili main-player controls from broader website coverage. Trace
  observed responses through frame association before extending source discovery.
  Extend the official embedded-player coverage. Keep each viewer's account
  access in its original player. Retain the
  [shared playback owner](./research/channel-network-design.md#synchronized-video-sources):
  the sharer controls common playback; viewers own sound, participation and
  access through their own platform accounts. The supplied girigirilove player
  remains blocked by the original site's regional access restriction; retry its
  compatibility check when the original player is accessible. Broader platform
  acceptance remains separate from the local direct-media controls. Retain
  trusted source identity and necessary original-page popup/login behavior
  without building a browser.
  Explain the complete trusted-site scope and local website-login behavior before
  use; media capability still does not grant room access or arbitrary native control.
- [ ] **3.0 Native platform acceptance.** Build, install and validate the matching
  Android candidate. Complete physical microphone/camera acceptance for the
  Windows WebView entry; controlled runtime fallback, device
  permission and shutdown checks are in the
  [verification record](./verification-status.md#windows-and-android).
  Continue remaining Linux/macOS device acceptance, including
  macOS Quit, Dock/Finder return and permissions,
  and Linux hardware encoding and physical sound. Retain the accepted
  [network model](./research/channel-network-design.md)
  and [room-data model](./research/channel-storage-and-identity.md).
  Local OBS input still needs non-Windows desktop runtime coverage; its
  [Windows path](./research/room-interactions.md#local-obs-input) has media,
  retirement and matched-package evidence.
- [ ] **Enhanced microphone suppression on physical devices (#518).** Compare
  matched-level voice clarity, acoustic echo and mobile runtime cost for the
  optional RNNoise mode. The
  [microphone assessment](./research/media-fidelity.md#stronger-microphone-suppression)
  records the Browser comparison and integration boundary. Retain Browser voice
  processing as the default and keep screen/system audio unprocessed.

## Held By Owner

- [ ] **Non-Web desktop interface.** Do not integrate the graphical status-window
  proof or rewrite the room UI with native widgets. The
  [runtime assessment](./research/cross-platform-client-runtime.md#30-windows-native-entry-prototype)
  records the distinction; the system-WebView evaluation above reuses the Web UI.
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
- [ ] **Multiple remote-control screens.** Deferred on 2026-10-17. Keep one
  shared source; Viewer screen switching and simultaneous screens are later work.
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
- **Native H264 scene-change latency.** Revisit when a concrete encoder or SDK
  improvement can reduce coded-frame bursts while preserving quality and live
  recovery. The available small parameter changes were evaluated and rejected;
  keep CBR. The [encoder assessment](./research/webrtc-encoder-pool.md#h264-burst-and-recovery)
  owns those controls and the current tradeoff.
- **Virtual gamepads beyond Windows.** Linux uinput passed its isolated kernel
  gate; desktop permissions and game recognition need physical checks. macOS
  virtual HID needs an entitled App and macOS SDK/runtime checks. The
  [co-play assessment](./research/room-interactions.md#remote-co-play) owns
  platform evidence; Piik does not bundle or install optional input drivers.
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
- **Managed Demo hosting.** The [provider assessment](./operations/website.md#managed-hosting-assessment)
  establishes no cost saving; keep the existing P2P-only Demo pending a concrete option.
- **Phone as a Host microphone.** Revisit only for a concrete use case that
  justifies the [pairing and input boundary](./research/camera-and-microphone.md#phone-microphone-assessment).
- **Mobile controlled endpoints.** Separate scope from desktop keyboard/mouse
  control and desktop co-play.
