# Current TODO Ledger

Last reviewed: 2026-10-31

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **3.0 Native platforms and integration.** Complete capture/input on the
  remaining platforms and packaging over the shared UI and Native participant,
  retaining the accepted [network model](./research/channel-network-design.md)
  and [room-data model](./research/channel-storage-and-identity.md).
  Resolve the recorded GNOME cancellation cleanup defect before Linux packaging.
  Keep the selected public-API str0m transport private while resolving the
  inconsistent Original-quality restoration after a sustained bandwidth drop.
  Preserve the existing SDK controller; the probe-clock experiment did not
  demonstrate a recovery benefit. Promote the
  [combined Native candidate](../prototype/channel-native/README.md#rtc-dependency)
  after that acceptance and the held dependency decision. Complete the current
  Android build/device check, then retire the unused Go backend and its
  acceptance callers from this branch. Keep the first version's accepted scope
  and the prototype isolated.
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
- [ ] **Return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.
- [ ] **Return the 3.0 RTC dependency to an upstream release.** Follow
  [upstream #296](https://github.com/webrtc-rs/rtc/pull/296) and
  [#298](https://github.com/webrtc-rs/rtc/pull/298). Native and Server use
  the same fixed 0.21.1 fork; [Native dependency provenance](../prototype/channel-native/README.md#rtc-dependency)
  owns the repair and removal criteria.
- [ ] **Return Pion to an upstream pin.** Follow
  [upstream #3668](https://github.com/pion/webrtc/pull/3668). Once upstream
  includes equivalent H.264 profile matching, verify the receiver and forwarding
  controls and remove the temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#pion-h264-profile-matching)
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
- [ ] **3.0 media-library submissions.** The retained H264 parser, complete samples
  and packet metadata repairs await external-publication approval. The selected
  str0m transport replaces the proposed controller, async-runtime and socket
  extensions; do not publish that superseded batch as Piik requirements. Submit
  only the approved retained scope and verify the integrated Native adapter
  before updating its fixed dependency. Local implementation continues.
- [ ] **Portmapper gateway scheduling.** The verified async gateway-lookup
  repair awaits upstream-submission and patched-dependency approval. The
  [Native dependency owner](../prototype/channel-native/README.md#rtc-dependency)
  records its scope. Continue local integration without changing the formal pin.
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
