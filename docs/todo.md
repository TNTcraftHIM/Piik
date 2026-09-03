# Current TODO Ledger

Last reviewed: 2026-09-04

Only **Now** is executable. Observations, old branches, experiments, and parked
topics are not implementation authority.

## Now

1. **Native Client media boundary.** Windows native Host video now runs through
   the current Browser-owned room and route contract. Local Client startup,
   hardware-H.264 capture, bounded Pion fanout, and a remote `srflx`-to-`srflx`
   video gate now pass. Process-loopback audio passes the Windows Browser gate
   on the same PeerConnection with a video-only fallback. Pion TWCC/GCC now
   supplies exact native P2P sender-quality evidence through the existing route
   windows without a custom score. A reserved local bridge also passes the
   native-source SFU gate through the existing Browser LiveKit publisher and
   its existing representation policy.
   Capture-source failure now has a physical end/restart gate through the same
   room and Viewer. Clean-revision Windows and Linux packages pass their Local
   runtime gates; Linux also passes one-link startup and shutdown. The macOS
   arm64 sidecar passes hosted compilation and a synthetic VideoToolbox hardware-
   H.264 IDR gate; physically run ScreenCaptureKit capture and recovery on macOS.
   Linux retains Browser capture. Reopen a
   Wayland-only Portal/PipeWire sidecar only with a real desktop/GPU gate and a
   decision to reuse system GStreamer without bundling it; do not add a second
   RTC, X11 capture stack, or hand-built DMA-BUF/encoder matrix.
   The system-Browser launcher now owns Local, temporary public-link, and Site
   selection, and the Host explicitly chooses Browser capture or an exact
   Client-owned screen/window without command-line target input. Its Windows
   physical gates pass window and display capture, bounded source previews,
   process/system audio, and restored Viewer delivery. The window arm also
   proves source end and same-room reselection; display-source lifecycle remains
   a separate physical gate.
   No-Site Internet mode now has one ordinary public invitation link that retains
   the Host's Local authority and passes remote control-path and independent
   Linux Pion media gates. Prove decoded one-link Browser media on a physical
   second device and a selected mapped path on a pair that public STUN alone
   cannot connect. Port mapping is implemented and physically creates/releases
   a router mapping, but it cannot replace an SFU/TURN fallback for a restricted
   pair.

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
3. **Browser encoded-frame reuse.** After the current Browser experience release,
   gate one narrow video-edge adapter that preserves signaling, routing,
   ICE/TURN, DTLS, DataChannel congestion control, upstream WebRTC playback and
   SFU fallback while reusing one encoded representation across every compatible
   P2P descendant. First determine whether current Browser APIs or a mature
   module can preserve per-edge adaptation without re-encoding; do not accept a
   standard-WebRTC weak-edge fallback as the default merely because it is easy.
   Compare one layered SVC encode with a small room-wide simulcast set before any
   per-edge encoder; select layers from current edge capacity rather than
   classifying Viewers into permanent strong/weak groups.
   A strong/weak two-child gate must keep the strong path at full quality,
   recover the weak path without globally lowering the shared representation,
   bound queues and temporary copies, and measure CPU, bytes, latency, keyframe
   recovery, A/V timing and supported mobile Browsers. Reuse existing quality
   evidence and route operations; add no custom score, global worst-viewer rule,
   periodic ladder or unproved codec representation.
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
    before recommending it as a default for other deployments. Direct
    convergence currently consumes each deferred Peer parent once; add no
    cross-generation retry budget until field evidence proves that fresh ICE
    generations expose a repeatable prediction opportunity.
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
    persistence, or route-controller implementations.

## Decision Needed

- Choose the repository and distribution license before public release or
  package distribution. GPL/AGPL implementations remain research-only until
  then.
