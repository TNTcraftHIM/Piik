# Current TODO Ledger

Last reviewed: 2026-11-21

This ledger contains unfinished work and explicit owner holds. Product modules
own behavior; research and Git/PRs own evidence and completed history.

## Now

- [ ] **Sharing-sound switch is disabled.** Trace the reported grey switch
  through source selection, Browser/App capability and approval state. The
  reporter's platform and capture source are unknown; distinguish unsupported
  capture from a stale capability result.
- [ ] **Mobile sharing stops unexpectedly.** The recording shows
  `app/control/disconnected` on returning to Chrome, followed by App ready.
  Capture the existing opt-in control-close diagnostic during a reproduction
  to identify the failing transition before changing capture or service lifetime.
- [ ] **Release mirror platform integration.** Verify a supported way to create
  the platform's Release tag or trigger its immediate synchronization during
  publication. [Mirror operations](./operations/github.md#atomgit-download-mirror) owns setup.
- [ ] **Public invitation timeout feedback (#557).** Verify the App timeout
  title and fixed public address guide link in the maintenance candidate, then
  confirm both in the published build.
  [#557](https://github.com/TNTcraftHIM/Piik/issues/557)
- [ ] **Windows H.264 output negotiation (#452).** Verify the format-change
  handling on the reporter's Intel device, including startup and bitrate changes.
  The App diagnostic identifies `MF_E_TRANSFORM_STREAM_CHANGE`; preserve the
  configured output and SPS requirements when accepting an updated media type.
- [ ] **Windows sound only works with exclusion (#534).** Compare the affected
  application's playback endpoint with Piik's default-endpoint capture. The
  [audio scope control](./research/native-client-media.md#windows-audio-exclusion)
  reproduces the contrast with another output device; locate the reporter's
  first failing transition before changing the capture owner.
- [ ] **Blue-tinted sharing (#529).** Identify the source and affected receive
  path from [#529](https://github.com/TNTcraftHIM/Piik/issues/529): Piik version,
  platform, capture choice and matching source/Viewer screenshots. Compare
  those pixels with the existing colour controls; increased bitrate did not
  resolve the reported tint.
- [ ] **Browser sharing falls to low source FPS during motion.** Capture original
  track, isolated capture-input and sender counters during the same low-FPS
  episode on Windows Chrome with mixed direct/SFU delivery. The observed sender
  input fell to roughly 2 fps during video or game playback. Keep source cadence
  and the separate SFU packet-loss stage distinct.
- [ ] **Unclassified capture termination in older Windows feedback.** Identify
  the Native failure stage and HRESULT in the original v2.4.1/v2.5.1 attempts.
  Their Browser reports show Native failure before page cleanup but do not
  identify its trigger.
- [ ] **Room voice in Native display sound.** Resolve the remaining case where
  system loopback recaptures Browser voice, while excluding the Browser process
  also removes its other audio. Browser own-document exclusion and Native
  process-tree exclusion are already implemented; acoustic echo and duplicate
  commentary retain their separate microphone owners.
- [ ] **iOS share and room-voice echo.** Confirm the reporting iOS/browser version,
  display-capture audio track and share-microphone setting. The reported echo
  returns through the shared picture. Compare with the share microphone disabled
  while keeping room voice active before attributing it to source-audio capture.
- [ ] **Virtual-LAN page loading.** Identify where the affected invitation stalls
  by comparing document and script results on the affected path and a working
  path. Controlled tests reproduce size-dependent HTTP stalls and fresh HTTPS
  timeouts with path-MTU feedback blocked.
  [Startup resource transfer](./research/nat-traversal.md#startup-resource-transfer).
- [ ] **Native H264 scene-change latency.** Reduce large-AU send-queue delay
  while preserving bitrate restoration. The
  [end-to-end control](./research/webrtc-encoder-pool.md#h264-burst-and-recovery)
  locates the delay and rejects the one-frame HRD override that prevents recovery.
- [ ] **Linux capture ends after selection (#499).** Follow
  [#499](https://github.com/TNTcraftHIM/Piik/issues/499) on niri/Wayland with
  GStreamer NVENC. The Browser report records capture ending before connection
  cleanup; obtain the native capture failure to distinguish the encoder and Portal.
- [ ] **Linux Cinnamon/X11 capture without a ScreenCast portal backend (#552).**
  Verify the App source picker and Browser sharing on the affected setup before
  deciding the native capture support scope.
  [#552](https://github.com/TNTcraftHIM/Piik/issues/552)
- [ ] **Mouse input stops when Host Chrome is minimized (#502).** Follow
  [#502](https://github.com/TNTcraftHIM/Piik/issues/502) on the original Windows
  host. The supplied v2.5.2 reports retain the grant and receive authorized mouse
  events, but Windows `SendInput` rejects a button event and subsequent release
  attempts. The reporter still loses control after returning to the desktop in
  v2.8.0. Capture whether local physical input also stops during the refusal
  to identify its OS trigger. Later same-process reports clear the release
  backlog; the local controlled Chrome trial did not reproduce the failure.
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

- [ ] **2.x optional SFU provider.** Implement and verify the
  [deployment-owned Cloudflare SFU adapter](./research/embedded-media.md#cloudflare-realtime-sfu).

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
