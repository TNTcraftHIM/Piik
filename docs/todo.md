# Current TODO Ledger

Last reviewed: 2026-10-25

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **Remote-control end-to-end latency.** Measure input-to-visible-response
  on an attended target, covering OS execution, Native capture/encoding, remote
  transport and display in the same trial. The
  [input assessment](./research/room-interactions.md#window-capture-and-game-input)
  owns completed local component measurements.
- [ ] **Windows window-sharing black screen (#495).** Investigate
  [#495](https://github.com/TNTcraftHIM/Piik/issues/495): Windows 10, Chrome 155,
  Piik v2.3.0; native Chrome/Edge window sharing fails while QQ and Browser
  capture work. The latest report selects VP8 and connects the preview transport.
  Obtain the App capture status and encode counters, or compare
  the existing Intel/NVIDIA adapter choices with VP8 fixed on that device.
- [ ] **Intel native H.264 startup (#452).** Follow the
  [new v2.4.0 report](https://github.com/TNTcraftHIM/Piik/issues/452): explicit H.264
  fails while VP8 works on Intel Arc B580 / Intel Graphics. The Browser report
  records App startup rejection. Compare v2.4.1, which removes the mandatory
  low-latency encoder property, and obtain the App diagnostic if rejection persists.
- [ ] **Return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.

## Next

- [ ] **Release headlines in App and Server update checks.** Keep the prepared
  implementation on the feature branch for a later feature release. It consumes
  the existing [headline contract](./standards/versioning.md#release-notes).
- [ ] **Android App release scope.** Complete phone/tablet/TV hardware acceptance
  and stationary-screen late join/keyframe
  recovery, then prepare release packaging. The system-browser companion is the
  primary candidate; keep the embedded build for comparison until acceptance.
- [ ] **iOS browser companion.** Connect the [Swift capture producer](../mobile/ios/README.md#integration-boundary)
  to the shared mobile bridge. Verify Safari-to-App control and background Host
  operation with the Apple SDK and a device before preparing an iOS test package.

## Held By Owner

- [ ] **QR invitations.** Deferred from the maintenance release on 2026-10-24.
  Keep the local QR implementation on the feature branch for later acceptance.
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

- **Piik 3.0 scope.** Explore independent room, chat, voice and screen-share
  lifecycles, with optional image/file exchange, retaining the current topology
  and route controller. Compare continued Go with scoped Rust components before
  choosing implementation scope. The [hosting and subscription assessment](./research/room-interactions.md#multi-room-and-distributed-hosting-assessment)
  distinguishes per-room hosting, federation and replicated room authority.
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
