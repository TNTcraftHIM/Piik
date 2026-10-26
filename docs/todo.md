# Current TODO Ledger

Last reviewed: 2026-10-26

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **Android and touch-control release.** Finish the same-revision CI package
  rehearsal and owner review of the website, then publish the shared App/Server
  update and associate resolved issues. Android uses the existing publication
  pipeline and a dedicated signing key; iOS remains outside this release.
- [ ] **Virtual-LAN page loading.** Investigate the UU report where only the tab
  title appears and the page never loads. Static compression reduces transfer
  size; capture the stalled document/script response to locate this failure.
- [ ] **Remote-control end-to-end latency.** Measure input-to-visible-response
  on an attended target, covering OS execution, Native capture/encoding, remote
  transport and display in the same trial. The
  [input assessment](./research/room-interactions.md#window-capture-and-game-input)
  owns completed local component measurements.
- [ ] **Linux capture ends after selection (#499).** Follow
  [#499](https://github.com/TNTcraftHIM/Piik/issues/499) on niri/Wayland with
  GStreamer NVENC. The Browser report records capture ending before connection
  cleanup; obtain the native capture failure to distinguish the encoder and Portal.
- [ ] **macOS window capture with sound (#500).** Follow
  [#500](https://github.com/TNTcraftHIM/Piik/issues/500). Compare the same window
  with source sound on and off in the candidate that waits for video `active`
  before starting source audio. Obtain the App diagnostic if the window stays black.
- [ ] **Control loss when the Host browser is minimized (#502).** Follow
  [#502](https://github.com/TNTcraftHIM/Piik/issues/502). Default-policy minimized
  Chromium forwarding and the Windows input component pass local checks. Collect
  the Host App diagnostic ZIP and mobile Viewer report from the same failure;
  current diagnostics distinguish input execution from Viewer send failure.
- [ ] **Return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.

## Next

- [ ] **Release headlines in App and Server update checks.** Keep the prepared
  implementation on `archive/deferred-prototypes` for a later feature release. It consumes
  the existing [headline contract](./standards/versioning.md#release-notes).

## Held By Owner

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
