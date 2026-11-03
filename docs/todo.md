# Current TODO Ledger

Last reviewed: 2026-11-03

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **Public-invitation candidate retirement.** Capture the parent and server
  reason when a candidate is retired before its first SDP offer. Keep this
  separate from candidates that actually enter ICE and fail.
- [ ] **Browser sharing falls to low source FPS during motion.** Trace raw
  capture, sender-owned track input and encoding on Windows Chrome with mixed
  direct/SFU delivery. The observed source fell to roughly 2 fps during video
  or game playback; reproduce with real window/display capture. Keep the
  separate SFU packet-loss stage distinct from source-frame production.
- [ ] **Unclassified capture termination in older Windows feedback.** Identify
  the Native failure stage and HRESULT in the original v2.4.1/v2.5.1 attempts.
  Their Browser reports show Native failure before page cleanup but do not
  identify its trigger.
- [ ] **Room voice in Native display sound.** Resolve the remaining case where
  system loopback recaptures Browser voice, while excluding the Browser process
  also removes its other audio. Browser own-document exclusion and Native
  process-tree exclusion are already implemented; acoustic echo and duplicate
  commentary retain their separate microphone owners.
- [ ] **Virtual-LAN page loading.** Investigate the UU report where only the tab
  title appears and the page never loads. Static compression reduces transfer
  size; capture the stalled document/script response to locate this failure.
- [ ] **Native H264 scene-change latency.** Reduce large-AU send-queue delay
  while preserving bitrate restoration. The
  [end-to-end control](./research/webrtc-encoder-pool.md#h264-burst-and-recovery)
  locates the delay and rejects the one-frame HRD override that prevents recovery.
- [ ] **Linux capture ends after selection (#499).** Follow
  [#499](https://github.com/TNTcraftHIM/Piik/issues/499) on niri/Wayland with
  GStreamer NVENC. The Browser report records capture ending before connection
  cleanup; obtain the native capture failure to distinguish the encoder and Portal.
- [ ] **Mouse input stops when Host Chrome is minimized (#502).** Follow
  [#502](https://github.com/TNTcraftHIM/Piik/issues/502) on the original Windows
  host. The supplied v2.5.2 reports retain the grant and receive authorized mouse
  events, but Windows `SendInput` rejects a button event and subsequent release
  attempts. Identify that OS refusal trigger and verify held-button recovery;
  the local controlled Chrome trial did not reproduce it.
- [ ] **Return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.
- [ ] **Return Pion to an upstream pin.** Follow
  [upstream #3668](https://github.com/pion/webrtc/pull/3668). Once upstream
  includes equivalent H.264 profile matching, verify the receiver and forwarding
  controls and remove the temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#pion-h264-profile-matching)
  owns the patch and removal boundary.

## Next

- [ ] **Stronger microphone noise suppression (#518).** Assess the
  [requested speech-processing option](https://github.com/TNTcraftHIM/Piik/issues/518)
  through the shared microphone input. Browser voice processing is already the
  default; keep screen and system audio unprocessed.
- [ ] **3.0 semantic reconstruction.** Continue the isolated `feat/channel-prototype`
  from the accepted domain/room/participant model. Map existing behavior and
  ownership, remove accidental constraints, then implement cohesive Rust runtimes
  with mature components. Preserve the reviewed recovery semantics, not Go
  function or module parity. The prototype's design owners and ledger govern
  its implementation; keep it outside the maintenance candidate.
- [ ] **Release headlines in App and Server update checks.** Keep the prepared
  implementation on `archive/deferred-prototypes` for a later feature release. It consumes
  the existing [headline contract](./standards/versioning.md#release-notes).

## Held By Owner

- [ ] **iOS native App.** Paused in favor of Browser use. Preserve the isolated
  implementation on `feat/ios-client`; native development and publication stay
  outside the current phase.
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
