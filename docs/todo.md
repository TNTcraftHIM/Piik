# Current TODO Ledger

Last reviewed: 2026-09-05

Only **Now** is executable. Observations, old branches, experiments, and parked
topics are not implementation authority.

## Now

1. **Client physical acceptance.** Physically validate macOS and Linux
   capture/audio/recovery, a decoded public-link Browser Viewer, and a NAT case
   rescued beyond ordinary STUN, plus one mixed Browser/Native Viewer relay.
2. **Client owner acceptance.** Review the localized terminal, Browser capture
   through Native fanout, live controls and Client-exit recovery before merging.
   Confirm weak-path convergence with effective media throttling; a DevTools
   command succeeding without limiting RTP is not a weak-path pass.
3. **Capture startup and controls.** Diagnose Windows 10 selecting an entire
   display failing to start while window capture succeeds; do not conflate it
   with exclusive-fullscreen game capture. Current Windows 11 checks cover
   display startup, minimized-source recovery and live presets. Verify remaining
   game HWND/device-loss behavior and physically compare the implemented Windows
   display-aspect correction with the reported stretched game, including GPU
   scaling not exposed by the active display path. Compare bitrate changes against
   same-content delivery before changing encoder settings.
4. **NAT acquisition and release acceptance.** Validate the implemented bounded
   three-attempt owner on restricted Browser/Native pairs; a new connection does
   not guarantee a different NAT mapping. The added prepare progress field is
   incompatible with old strict pages. Obtain owner approval for the coordinated
   Web/Server/Client update and its active-share impact before merging/deploying;
   do not mix the new field into an ongoing old-version share.
5. **Native codec acceptance.** Windows Native VP8 and Auto-selected H264 now
   pass real Browser playback, live presets, paused changes and source-switch
   checks while preserving the selected codec. Validate GPU-heavy Auto selection
   and the tight four-second probe/five-second startup budget on other hardware;
   do not claim throughput screening guarantees perceptual quality or later
   load. Other native platform capture encoders remain H264.

## Parked Product Work

1. **Broader quality optimization.** Same-edge connection regeneration is now
   part of the bounded local convergence path. Weighted/global optimization,
   parent-wide prediction, startup-limited inference, complete cross-clone
   source isolation, and alternative SFU policies remain unaccepted. Reopen only
   from exact path evidence; do not add a score, all-pairs probe, periodic
   rebalancer, or ordinary SFU preference. Validate whether a quality move merely
   shifts residual shared-source pressure to the new parent's siblings before
   widening it. Preserve the accepted profiles, bitrate ceilings, endpoint
   capacity, degradation preferences and LiveKit representations unless a
   measured gain is large enough to justify the quality, resilience,
   compatibility and maintenance cost through a new accepted decision.
2. **Startup codec budget.** Reconcile the bounded Auto codec probe with the
   first-frame target from measured Browser evidence; do not silently weaken
   Auto or move an unproved result into the availability path. Validate whether
   H.264 qualification can choose a slower VP8 fallback under mixed GPU/CPU load
   before adding comparative or dual-codec probing.
3. **Browser encoded reuse.** Pure Browser operation keeps normal WebRTC
   senders; users can use Client to reduce repeated encoding. Revisit Browser
   reuse only for a small mature adapter that preserves adaptation and media
   quality without an application-owned transport or layer controller.
4. **Control-plane resource fairness.** Calibrate one deployment-wide LiveKit
   control queue and simple HTTP/WebSocket ingress budgets before implementation;
   prove a self-hosted stale-token revocation boundary before independently
   releasing subscription egress; do not introduce accounts, polling, risk
   scoring, or an independent policy framework.
5. **Client ownership.** Extract media-session owners from the Host/Viewer pages
   only alongside reachable behavior work. File length alone does not authorize
   a page rewrite; Host diagnostic presentation is already coalesced without
   delaying media evidence or route control.
6. **C=3 structural intent retention.** Revisit multiple simultaneous one-shot
   Host-root convergence intents only with an exact C=3 reproduction; do not add
   periodic balancing or another topology queue for the default path.
7. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari matrices for
   autoplay, background audio, foreground recovery, lock/page reclamation,
   rotation, network migration, and relay survival.
8. **Representative network acceptance.** Complete public-network direct,
   Browser relay, SFU, recovery, Pause/Resume, screen-audio, real-game A/V,
   two-room SFU, 20-Viewer endurance, and all-UDP-blocked bounded failure.
   Validate LiveKit Server 1.13.6 simulcast retransmission under controlled loss
   and correlate any remaining SFU freezes with publisher encoding counts before
   changing Dynacast or representation policy.
9. **Client-input security review.** Audit HTTP/WebSocket schema, auth,
   authorization, rate/body/resource bounds, errors, logs, and secrets without
   adding a parallel security framework.
10. **Public-server package.** Package the exact Web/signaling, STUN/SFU, proxy,
   secrets, health, and recovery contract for a user-owned server.
11. **Native media endurance.** Exercise long-lived native P2P and Browser-
    mediated SFU recovery after the platform capture boundary passes. Preserve
    Browser/server authority and the existing LiveKit representation policy; do
    not create a second room or media policy.
12. **Platform output.** System/tab mirroring needs no product adapter, while
    Remote Playback, default Cast and AirPlay do not provide a portable live
    `MediaStream` output contract. Reopen only for a registered custom receiver
    acting as an ordinary Viewer after a named Browser and physical receiver
    pass the [platform-output gate](./research/platform-output.md).
13. **NAT inference and predictive candidates.** The deployment-gated,
    connection-local capability is accepted under
    [ADR-0009](./adr/0009-optional-nat-prediction.md). Production enables its
    self-hosted field rollout; the general configuration default stays off.
    Keep injected candidates additive and diagnostic; do not make them a
    participant-wide NAT label, hard candidate skip, route score, or SFU
    preference. Validate selected predicted paths and bounded resource impact
    plus one selected Native mapped-port path that fails with STUN alone before
    recommending either as a default for other deployments. Measure benefit of
    the implemented three-attempt budget before increasing it or claiming that
    independent connection attempts are independent NAT mappings.
14. **Unresolved route-state ownership claims.** Reopen lower-revision
    reauthentication, active SFU failure during an unrelated prepare, and
    multi-child relay-evidence ownership only from an exact current-wire
    reproduction. Do not add a second revision namespace, parallel failure
    state, or generalized evidence map from static possibility alone.
15. **Unified release and update surface.** Build Client packages, Server
    runtime, future OCI images, and deployment bundles from one intentionally
    triggered immutable application release identified by its full commit SHA.
    A validated `main` push now produces that application release and three
    native-runner Client candidates with SHA-256 metadata. The default Client
    launcher now performs a non-blocking GitHub Releases check and the tracked
    deployment tree provides an operator-invoked read-only Server check. Formal
    GitHub Release publication, future OCI images, and deployment bundles remain
    explicit distribution work; do not add automatic install, container
    self-update, Watchtower, compatibility ranges, or active-share interruption
    before distribution and rollback evidence requires them.
16. **Go server consolidation.** Revisit replacing the sole TypeScript/Node
    server owner with Go only after the Client feature and physical acceptance
    boundaries are complete. First measure package, startup, and maintenance
    gains. If accepted, migrate Hosted and Local together and delete the Node
    server in the same boundary; do not create or retain two room, signaling,
    persistence, or route-controller implementations. The
    [consolidation draft](./research/server-consolidation.md) identifies the two
    preparatory simplifications, the routing-mode product choice, and the shared
    module and concurrency model; implementation follows Client acceptance.
17. **Opt-in diagnostics.** Replace ad hoc console logging with an explicit
    Client/Server debug option and bounded diagnostic export. Include revision,
    runtime state and sanitized capture/connection events; exclude credentials,
    media and raw process memory by default. A compressed feedback bundle needs
    deliberate collection and retention, not automatic uploads.
