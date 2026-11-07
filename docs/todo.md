# Current TODO Ledger

Last reviewed: 2026-11-07

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

The first 3.0 internal test targets Windows and Android. Prioritize confirmed
blocking defects in startup, room access, conversation, media, recovery and
shutdown. UI polish, terminal presentation and alternative views follow during
the feedback period; they do not delay that delivery.

## Now

- [ ] **3.0 iOS/iPadOS room voice feedback.** With noise processing disabled on
  the phone/tablet, a computer listener reports mono sound. Distinguish source
  capture channels, processing/mixing and negotiated Opus output in the current
  investigation. Keep the published 2.x mono contract separate.
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
  Later same-process reports clear the release backlog; the local controlled
  Chrome trial did not reproduce the failure.
- [ ] **2.x: return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.
- [ ] **Return the 3.0 RTC dependency to an upstream release.** Follow
  the submitted defect repairs in
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency).
  Once upstream provides those changes, verify the consumers and remove the fork.
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

- [ ] **Native quality preference.** Complete the detail-versus-motion preference
  after choosing its Native adaptation owner: Browser encoding already consumes
  that preference, while Native currently keeps its default. Do not expose a
  control that the selected producer cannot apply.
- [ ] **3.0 invitation controls feedback.** Distinguish domain admission from a
  room invitation in the UI. The user confirmed the existing 2.x-style controls:
  public/private access, a passphrase and resetting the invitation link. Reuse
  the current permission and settings owners; private-room settings and link
  rotation already exist, while domain invitation copying has no such controls.
- [ ] **Routing parity decisions.** Review the current domain-wide 20-endpoint
  limit, which counts Browser and App separately, against the intended user
  capacity. The current direct-source/helper trials cover fewer improvement
  opportunities than 2.x, and its central-fallback and route-preference controls
  are not equivalent. Choose required behavior with the accepted multi-source
  model before extending existing admission and switch owners.
- [ ] **3.0 Native platform acceptance.** Complete the remaining Linux/macOS
  device acceptance, including macOS Quit, Dock/Finder return and permissions,
  and Linux hardware encoding and physical sound. Retain the accepted
  [network model](./research/channel-network-design.md)
  and [room-data model](./research/channel-storage-and-identity.md).
- [ ] **Entry presentation.** Restore the App terminal's useful presentation
  and review the prepared website/help wording for joining a friend's room.
- [ ] **Native H264 scene-change latency.** Reduce encoded bursts while
  preserving low-rate startup and live bitrate restoration. Keep CBR; the
  [encoder assessment](./research/webrtc-encoder-pool.md#h264-burst-and-recovery)
  records why the low-delay VBR candidate was rejected.
- [ ] **Stronger microphone noise suppression (#518).** Assess the
  [requested speech-processing option](https://github.com/TNTcraftHIM/Piik/issues/518)
  through the shared microphone input. Browser voice processing is already the
  default; keep screen and system audio unprocessed.
- [ ] **Release headlines in App and Server update checks.** Keep the prepared
  implementation on `archive/deferred-prototypes` for a later feature release. It consumes
  the existing [headline contract](./standards/versioning.md#release-notes).

## Held By Owner

- [ ] **Participation controls.** Await the user's choice between one participation
  switch and distinct role permissions. The current member and moderator roles
  grant the same capabilities. Hold only this role-model change.

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
