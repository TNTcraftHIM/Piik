# Current TODO Ledger

Last reviewed: 2026-10-24

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **Remote-control latency and responsiveness.** Compare input delivery,
  Host execution, capture/encoding and playback on the same endpoints and
  network. Measure the remaining latency after the input scheduling and
  grant-lifecycle corrections before changing transport or buffering.
- [ ] **Windows window-sharing black screen (#495).** Investigate
  [#495](https://github.com/TNTcraftHIM/Piik/issues/495): Windows 10, Chrome 155,
  Piik v2.3.0; App window sharing is black while full-screen sharing works.
  The attachment shows the Host selecting its own Chrome window, then a black
  preview after sharing starts. This path works in local Windows 11 / Chrome 155
  checks. A same-attempt App/Web report from the affected device is needed to
  distinguish capture output from decoding. Keep this investigation separate
  from the release; it is not covered by the macOS #492 crop fix.
- [ ] **Return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.

## Next

- [ ] **Release headlines in App and Server update checks.** Read the existing
  bilingual title and explanation from the published release notes and show them
  in the App update notice and Server update output. Reuse the
  [headline contract](./standards/versioning.md#release-notes); keep GitHub and
  Gitee consistent, retain version/upgrade actions, and use the ordinary notice
  when no headline exists. Display plain text without another announcement feed.
- [ ] **QR invitations.** Generate a QR code locally from the current Viewer
  invitation, including its fragment and selected password behavior. Reuse the
  invitation controls and authority; rotation or revocation updates the displayed
  code. Invitation secrets must not go to an external QR service.
- [ ] **Android App.** Assess a first version focused on native phone screen
  sharing and source audio, reusing the existing room/transport core and product
  UI. Start with Android's
  [MediaProjection](https://developer.android.com/media/grow/media-projection)
  consent/foreground-service lifecycle and
  [playback capture](https://developer.android.com/media/platform/av-capture),
  then build a small prototype to establish the integration. Mobile controlled
  endpoints retain their separate scope.

## Held By Owner

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
- **Multiple simultaneous sharers.** Define publication/subscription ownership
  before prototyping. The [party-mode assessment](./research/room-interactions.md#multiple-sharers-assessment-not-implemented)
  owns the proposal; the current one-Host contract remains.
