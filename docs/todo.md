# Current TODO Ledger

Last reviewed: 2026-09-08

Only **Now** is executable. Observations, old branches, experiments, and parked
topics are not implementation authority.

## Now

Owner-authorized phase: [embedded STUN/SFU and node-local media](./adr/0013-embedded-node-local-media.md).
Every parent, including Host, forwards available encodings and derives missing lower
outputs only for direct children; compatible demands reuse the same output.
The agreed model and [first encoding comparison](./research/node-local-encoding-probe.md)
are recorded. The [decode comparison](./research/node-local-browser-probe.md) and
[design proposal](./research/node-local-media-design.md) narrow remaining work to
native H264 hardware cost, mature layer switching/pacing and actual RTP recovery.
Shared encoding is common to both policies; do not reopen unshared/Browser-sender
baseline comparisons. The maximum-demand model is accepted; library and runtime
integration remain under acceptance. Native uses the shared forwarding adapter,
with Pion transport and unmodified LiveKit media/BWE components behind bounded adapters.
A real three-output VP8 fixture passes two Pion connections and Chrome decode.
Bounded Native output workers and coordinated capture framing/
control are implemented; Windows compiles and the actual mailbox/pipe boundary
passes CPU-only checks. A bounded native VP8 process now proves received high
forwarding plus shared low derivation, live preference replacement, and retirement
without desktop capture. A shaped Pion virtual network proves stopped-high recovery
after bandwidth release; physical loss/recovery, codec overload and overhead remain
unverified. Linux producers compile; macOS changes still require SDK validation.
Native direct SFU publication, bounded current/candidate replacement and actual
multi-RID metrics are implemented. Browser SFU decode/live-profile acceptance
passes; matched Client/platform and network acceptance remain open. The Pion
UDP-mux initialization and candidate-fixture races are repaired; six affected
Linux packages pass the race detector.
Packaged multi-output capture is not accepted.
Embedded STUN is bound by the application lifecycle and passes startup/rollback/
closure checks. Embedded SFU room signaling, exact physical retirement and Browser
adapters are implemented; real Browser decoding is under acceptance and external-
service deployment removal remains pending. Prioritize the shared quality/encoding module and its
Native codec/transport checks, then complete embedded SFU/STUN integration.
Independent library/service audits may proceed in parallel. Do not add a custom warm pool, media clock
or congestion algorithm. These are
not bundled service executables, full LiveKit embedding or per-Viewer Host
uploads via TURN. Concrete codec parameters and release cutover remain unaccepted.

The returned Go core and frontend fixes are reconciled on the integration
candidate. The owner authorized hygiene cleanup, matched Server/Client builds,
one squash PR and a controlled deployment. Complete the existing checks and
first-Go unit/environment rollback before cutover. Device/network checks below
remain evidence gaps, not claims established by compilation or local loopback.

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
   incompatible with old strict pages. The owner authorized the coordinated
   Web/Server/Client update; check active sessions before the cutover and
   retain the previous unit/environment alongside the application rollback;
   do not mix the new field into an ongoing old-version share.
5. **Native codec acceptance.** Windows Native VP8 and Auto-selected H264 now
   pass real Browser playback, live presets, paused changes and source-switch
   checks while preserving the selected codec. Validate GPU-heavy Auto selection
   and the tight four-second probe/five-second startup budget on other hardware;
   do not claim throughput screening guarantees perceptual quality or later
   load. Other native platform capture encoders remain H264.

### Reported Follow-Ups

After the shared media integration, finish the owner's reported behaviors in
this same candidate. Global Link now reserves its IPv4 listener before creating
a tunnel; include that path in packaged acceptance.

1. **Concurrent Client rooms.** Preserve the backend's multiple rooms and one
   Host per room. Separate a tab's active Host authority from the origin-wide
   resume hint, and replace the process-wide single RPC claim with bounded
   control-session ownership. Reuse each native session and account for aggregate
   hardware resources; do not add an unbounded capture map. A friend's independent
   Browser Host already captures on their own device, not the instance owner's
   helper. Validate that path separately from multiple Native shares on one Client.
2. **Reported live-setting and package behavior.** Reconcile the unmerged
   `fix/live-quality-capture` fixes against this candidate, retaining only
   independently confirmed capture, setting, access and diagnostic behavior.
   Do not overwrite the new media/transport owners with that older branch.
   Reproduce game backgrounding,
   changing resolution/FPS/bitrate, and returning to the game against the exact
   newly built Client, not a repacked old executable. Verify failed replacement
   preserves the running source and later changes still apply. Keep preset
   highlighting tied to applied settings and make the advanced draft/apply
   boundary unambiguous. Complete the Windows display-startup and platform
   checks above; investigate Vivaldi through primary reports and actual local
   capability failures, without speculative Browser-specific fallbacks.

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
14. **Unresolved route-state ownership claims.** Reopen active SFU failure
    during an unrelated prepare and
    multi-child relay-evidence ownership only from an exact current-wire
    reproduction. Do not add a second revision namespace, parallel failure
    state, or generalized evidence map from static possibility alone.
15. **Unified release and update surface.** Build Client packages, Server
    runtime, future OCI images, and deployment bundles from one intentionally
    triggered immutable application release identified by its full commit SHA.
    A validated `main` push now produces that application release. An explicit
    `client_checks=true` workflow dispatch produces the three native-runner
    Client candidates with SHA-256 metadata. The default Client
    launcher now performs a non-blocking GitHub Releases check and the tracked
    deployment tree provides an operator-invoked read-only Server check. Formal
    GitHub Release publication, future OCI images, and deployment bundles remain
    explicit distribution work; do not add automatic install, container
    self-update, Watchtower, compatibility ranges, or active-share interruption
    before distribution and rollback evidence requires them.
16. **Go server consolidation.** Done in the candidate under
    [ADR-0012](./adr/0012-shared-go-backend-core.md): Hosted and Client share one
    Go core and the Node server, bundled runtime, and supervisor are deleted. Do
    not create or retain two room, signaling, persistence, or route-controller
    implementations. Package size, startup, and idle memory are measured in the
    [consolidation research](./research/server-consolidation.md). Remaining
    acceptance: rerun the physical Client and Browser-contract gates on this
    build, and sequence the deployment cutover, installing the updated unit,
    which replaces `NODE_ENV=production` with `SCREENER_ENV=production`, before
    the first Go release, then proving the release wrapper on a host without
    Node.
17. **Opt-in diagnostics.** Replace ad hoc console logging with an explicit
    Client/Server debug option and bounded diagnostic export. Include revision,
    runtime state and sanitized capture/connection events; exclude credentials,
    media and raw process memory by default. A compressed feedback bundle needs
    deliberate collection and retention, not automatic uploads.
18. **Remaining audit behavior.** During the owning refactor, reproduce and
    resolve optional Local-password cookies across HTTP LAN/HTTPS public origins;
    audio-process failure without stopping healthy video; natural capture EOF
    attribution; and Native prepared-bridge failure that must disable Native
    for the current Viewer session before retrying. Storage I/O failure needs
    an authority-consistent recovery policy, not catch-and-continue guards.
    The Local duplicate-launch guard is the in-process listener bind itself;
    it refuses a second Client on the same port and hands nothing over.
