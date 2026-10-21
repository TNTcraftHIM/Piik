# Current TODO Ledger

Last reviewed: 2026-10-20

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **Room-voice candidate acceptance.** The refreshed normal App/Server/Web
  candidate is ready for owner acceptance before integration and release.
  [Status](./status.md#current-work) owns the candidate boundary; the
  [test-build guide](./guide/getting-started.md#room-voice-in-test-builds)
  explains its controls. Production and the public Demo remain unchanged.
- [ ] **Return LiveKit to an upstream pin.** Follow
  [upstream #5016](https://github.com/livekit/livekit/pull/5016). Once upstream
  supplies the allocator input Piik needs, verify recovery and remove the
  temporary replacement. [Dependency provenance](../internal/thirdparty/README.md#local-encoder-probe-demand)
  owns the patch and removal boundary.
- [ ] **New promotional film.** Refine the online Chinese/English draft as a
  standalone introduction: sharing, invitations, Host consent and playing together.
  Improve the party-game example, motion, reading time and soundtrack. Functional
  work takes priority; export only after the owner accepts the online preview.
  Depict published functionality rather than multi-controller prototypes.

## Held By Owner

- [ ] **Separate accompaniment sharing.** Deferred on 2026-10-20 and excluded
  from this candidate. Preserve the unfinished prototype on
  `spike/audio-accompaniment` (`5e385add`); it is not a working feature.
  Sharing a music application with source audio remains available.
- [ ] **Remote-control latency and responsiveness.** Scheduled after release.
  Compare input delivery, Host execution, capture/encoding and playback on the
  same endpoints and network before changing budgets or buffering.
- [ ] **Persistent-loss estimator replacement.** Deferred on 2026-10-18.
  Keep mature congestion control and accept quality reduction under sustained
  high loss; concrete accounting/recovery defects remain ordinary bug fixes.
  [Evidence](./research/node-local-media-design.md#persistent-loss-with-low-source-utilization).
- [ ] **Multiple remote-control screens.** Deferred on 2026-10-17. Keep one
  shared source; Viewer screen switching and simultaneous screens are later work.
- [ ] **32-bit Windows/Linux Apps.** Deferred on 2026-10-02. No package or
  website option is planned; preserve the isolated Windows x86 experiment in Git.
- [ ] **Windows ARM64 App.** Deferred on 2026-10-03. Keep Windows downloads x64-only.
- [ ] **Alternative public-invitation providers.** Deferred on 2026-10-16.
  Keep Cloudflare Quick Tunnel. The [provider assessment](./research/cross-platform-client-runtime.md#alternative-invitation-providers)
  owns alternatives and tradeoffs.

## Local Interaction Prototypes

- [ ] **Shared-keyboard remote co-play.** Review the isolated Host-plus-two-Viewer
  prototype before product integration. Reuse the encrypted input route and
  consent owner, with per-participant held keys and one explicit pointer owner.
  The recording-sink trial does not implement desktop injection or game support.
- [ ] **Optional virtual gamepads.** Continue the isolated input-backend
  experiment authorized on 2026-10-19. The Host supplies any optional dependency;
  do not install or bundle a kernel driver. Review maintained backends, licensing,
  privileges and device retirement before integration. The
  [input assessment](./research/room-interactions.md#remote-co-play) owns the design.

## Parked Product Work

- **Platform output.** A registered receiver may act as an ordinary Viewer after
  the [platform-output gate](./research/platform-output.md) passes.
- **Additional languages.** Review community catalogs and rendered UI through
  the [translation guide](./guide/translating.md).
- **Windows code signing.** Revisit when a trusted signing service is available;
  sign executables before archive checksums. Signing does not guarantee the end
  of antivirus cloud scanning.
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
  control and the co-play prototypes above.
- **Android App assessment.** Evaluate native phone screen sharing and source
  audio beyond the existing mobile Browser features. Start with Android's
  [MediaProjection](https://developer.android.com/media/grow/media-projection)
  permission/foreground-service lifecycle and
  [playback-capture limits](https://developer.android.com/media/platform/av-capture),
  then assess reuse of the Go room/transport core. This is separate from the
  current voice candidate; a website wrapper alone does not add screen capture.
- **Multiple simultaneous sharers.** Define publication/subscription ownership
  before prototyping. The [party-mode assessment](./research/room-interactions.md#multiple-sharers-assessment-not-implemented)
  owns the proposal; the current one-Host contract remains.
- **Windows x64 Server packaging (#485).** Review package descriptors, container
  filtering and mirror inventory. Remove the contributor's unrelated history-check
  fallback before integration; current Linux Server and Windows App support remain.
