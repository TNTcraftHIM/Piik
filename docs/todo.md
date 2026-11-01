# Current TODO Ledger

Last reviewed: 2026-11-01

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **3.0 Native platforms and integration.** Complete capture/input on the
  remaining platforms and packaging over the shared UI and Native participant,
  retaining the accepted [network model](./research/channel-network-design.md)
  and [room-data model](./research/channel-storage-and-identity.md).
  Resolve the recorded GNOME cancellation cleanup defect before Linux packaging.
  Preserve the selected public-API str0m transport and its SDK controller;
  finish the incoming-source adapter's platform acceptance without the
  feature-patched sample builder.
  The probe-clock experiment did not demonstrate a recovery benefit. Promote the
  [combined Native candidate](../prototype/channel-native/README.md#rtc-dependency)
  after adapter/platform acceptance. Keep the first
  version's accepted scope and the prototype isolated.
- [ ] **Native H264 visual recovery.** Trace the observed unshaped startup budget
  shortfall and complete the healthy/constrained decoded-picture comparison.
  The latest observation stopped before its network profile. The saved slow run
  recovered picture dimensions and cadence while retaining a lower-bitrate
  independent encoder; image detail and frame age still need comparison.
  Evaluate delivered media and budget-funded handoff rather than treating the
  internal `Original` feed label as a quality deadline. Keep the earlier result
  and the stock controller; do not add another probe-policy matrix.
- [ ] **Virtual-LAN page loading.** Investigate the UU report where only the tab
  title appears and the page never loads. Static compression reduces transfer
  size; capture the stalled document/script response to locate this failure.
- [ ] **Linux capture ends after selection (#499).** Follow
  [#499](https://github.com/TNTcraftHIM/Piik/issues/499) on niri/Wayland with
  GStreamer NVENC. The Browser report records capture ending before connection
  cleanup; obtain the native capture failure to distinguish the encoder and Portal.
- [ ] **macOS source-picker previews (#500).** The reporter confirmed that sharing
  works in [#500](https://github.com/TNTcraftHIM/Piik/issues/500); the remaining
  report concerns missing source thumbnails. The maintenance branch implements
  the macOS helper's missing preview entry. Verify its build and thumbnails on macOS.
- [ ] **Control loss when the Host browser is minimized (#502).** Follow
  [#502](https://github.com/TNTcraftHIM/Piik/issues/502) on the original Windows
  host with the maintenance line's input-recovery candidate. Its v2.5.0 report
  shows rejected input and failed release cleanup; the candidate repairs a
  reproduced thread-desktop mismatch and records the native rejection context.
  Confirm the original host's trigger before closing the issue.
- [ ] **2.x: return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.
- [ ] **Return the 3.0 RTC dependency to an upstream release.** Follow
  the submitted defect repairs in
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency).
  Once upstream provides those changes, verify the consumers and remove the fork.
  The separately offered API extension is not required by Piik's dependency pin.
- [ ] **Return portmapper to an upstream release.** Follow
  [upstream #266](https://github.com/n0-computer/net-tools/issues/266), submit the
  repair when the maintainer marks it ready, then verify an official release.
  [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency)
  owns the temporary pin and removal procedure.
- [ ] **2.x: return Pion to an upstream pin.** Follow
  [upstream #3668](https://github.com/pion/webrtc/pull/3668). Once upstream
  includes equivalent H.264 profile matching, verify the receiver and forwarding
  controls and remove the temporary replacement. [Dependency provenance](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md#pion-h264-profile-matching)
  owns the patch and removal boundary.

## Next

- [ ] **Release headlines in App and Server update checks.** Keep the prepared
  implementation on `archive/deferred-prototypes` for a later feature release. It consumes
  the existing [headline contract](./standards/versioning.md#release-notes).

## Held By Owner

- [ ] **GNOME cancellation cleanup submission.** The prepared Mutter repair
  awaits approval for an upstream issue and patch. The
  [network design](./research/channel-network-design.md#implementation-boundary)
  owns its cause and isolated validation; Piik does not bundle a compositor fork.
- [ ] **iOS App publication.** Held on 2026-10-25. Keep the system-browser
  implementation on `feat/ios-client`, outside the Android release candidate.
  Apple SDK builds pass; signed-device acceptance still needs continued-session
  admission/expiry, recording consent, background capture and hosted-site linkage.
- [ ] **QR invitations.** Deferred from the maintenance release on 2026-10-24.
  Keep the local QR implementation on `archive/deferred-prototypes` for later acceptance.
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
- **Gitee download-source warning.** Paused by the owner. Keep GitHub primary
  and retain Gitee; do not add a self-hosted mirror. Reopen for new provider evidence.
- **Automatic local chat history.** Manual TXT export already exists. Automatic
  storage needs a stable room-incarnation identity, bounded retention and deletion;
  reusable room codes must not combine conversations.
- **Managed Demo hosting.** The [provider assessment](./operations/website.md#managed-hosting-assessment)
  establishes no cost saving; keep the existing P2P-only Demo pending a concrete option.
- **Phone as a Host microphone.** Revisit only for a concrete use case that
  justifies the [pairing and input boundary](./research/camera-and-microphone.md#phone-microphone-assessment).
- **Mobile controlled endpoints.** Separate scope from desktop keyboard/mouse
  control and desktop co-play.
