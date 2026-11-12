# Current TODO Ledger

Last reviewed: 2026-11-12

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

The first 3.0 internal test targets Windows and Android. Prioritize confirmed
blocking defects in startup, room access, conversation, media, recovery and
shutdown. UI polish, terminal presentation and alternative views follow during
the feedback period; they do not delay that delivery.

## Now

- [ ] **3.0 production external integrations.** Independent text participation and
  local OBS/WHIP interoperability are proven in isolated examples. Integrate a
  narrow adapter through the existing conversation and media owners only after
  deciding issuer, room scope, revocation, source representation and unattended
  input at the [extension boundary](./research/room-interactions.md#extension-boundaries-proposed).
- [ ] **Desktop graphical entry integration.** A small Rust-native status-window
  prototype is verified on Windows. Evaluate it against the current App's startup,
  diagnostics and normal shutdown before production integration; keep the shared
  Browser room UI and avoid a second runtime-state owner.
- [ ] **3.0 Windows shared-sound noise.** The reporter confirms electrical or
  crackling sound in beta9/10 as well as beta2, while 2.x sounds normal. Excluding
  the window titled Piik removes it; excluding a silent unrelated window does
  not. Its selected process identity remains unconfirmed. The
  [PCM continuity correction](./research/media-fidelity.md#30-pcm-continuity)
  fixes a separate reproduced defect; verify the updated candidate on the
  reported setup and whether intended sound remains after exclusion. Neither
  that correction nor the earlier local-preview fix yet explains the PID-specific report.
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
- [ ] **Replace the official RTC Git pin with a published release.** Follow
  the merged parser repair in
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency).
  Once a release includes it, verify the consumers and remove the Cargo patch entries.
- [ ] **Return portmapper to an upstream release.** Follow
  [upstream PR #268](https://github.com/n0-computer/net-tools/pull/268), then
  verify an official release containing the repair.
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency)
  owns the temporary pin and removal procedure.
- [ ] **Return str0m to an upstream pin.** Follow
  [str0m #1134](https://github.com/algesten/str0m/pull/1134) and its transmit-reset
  correction. Once upstream covers both repairs, replace the temporary pin
  through the existing consumer checks and
  [dependency provenance](../prototype/channel-native/README.md#rtc-dependency).
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
- [ ] **3.0 route improvement and fallback scope.** Resolve the remaining
  scenarios against the accepted multi-source model: replacing a still-working
  but persistently limited upstream, and a service media bridge for Browser/App
  rooms with no usable peer path. Existing Server-hosted rooms already use their
  Native root. Define evidence, authorization and resource cost before extending
  the current admission/switch owners; 2.x route-policy labels do not directly
  describe these 3.0 paths.
- [ ] **3.0 Native platform acceptance.** Validate the current Android candidate
  at runtime, then complete remaining Linux/macOS device acceptance, including
  macOS Quit, Dock/Finder return and permissions,
  and Linux hardware encoding and physical sound. Retain the accepted
  [network model](./research/channel-network-design.md)
  and [room-data model](./research/channel-storage-and-identity.md).
- [ ] **Stronger microphone noise suppression (#518).** Compare RNNoise's voice
  clarity and mobile runtime cost before deciding on an enhanced mode. The
  [microphone assessment](./research/media-fidelity.md#stronger-microphone-suppression)
  records the Browser comparison and integration boundary. Retain Browser voice
  processing as the default and keep screen/system audio unprocessed.

## Held By Owner

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

- **NDI and additional codecs (#535, #530).** Assess NDI through the proposed
  OBS/DistroAV-to-WHIP input before considering another native dependency.
  VP9/AV1/SVC support needs a concrete interoperability and resource decision.
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
