# Current TODO Ledger

Last reviewed: 2026-09-08

Only **Now** is executable. Observations, old branches, experiments, and parked
topics are not implementation authority.

## Now

Owner-authorized phase: [embedded STUN/SFU and node-local media](./adr/0013-embedded-node-local-media.md).
Execution priority is now explicit:

1. **Client encoding-layer pool acceptance.** Source-owned compatible groups,
   independent weak budgets and retained transport handoff are implemented.
   Real relay checks cover shared output, split/rejoin and 180p/360p delivery.
   Finish full Host/SFU, physical overload and representative network acceptance;
   packet delivery and local fixtures do not establish perceptual parity.
   Recovery repeatability remains open: one 120 kbps shaped-network run missed
   the 12-second recovery interval; another recovered without runtime changes.
   The successful trace shows the framework congestion guard clearing, but does
   not explain the earlier failure. Preserve both outcomes and isolate the
   cause before adding policy or claiming reliable recovery.
2. **Reported capture defects and retained fixes.** Finish the exact CS2
   fullscreen 4:3 stretched, Alt-Tab, advanced-setting, return reproduction and
   the independent Win10 whole-display startup investigation. Preserve this
   phase's multi-room, controls, UI, Global Link and diagnostic improvements.
3. **Integrated acceptance and release.** Build matching Client/Server/Web/
   capture artifacts, complete the scoped Windows/Browser checks, and verify
   embedded SFU/STUN cutover and recovery. Implemented services are not deployed
   or accepted merely because their local media checks passed.

Pure Browser encoding reuse is parked. Independent background source research
may continue only without delaying this mainline or its serialized hardware
acceptance; it is not an additional release prerequisite.
The owner-authorized diagnostic file/export work is an independent side task
for investigating reported Client and Server failures. Preserve it alongside
the mainline; it does not depend on Browser encoding-pool research or turn that
research into an acceptance prerequisite.

The owner restated two delivery goals: integrated STUN/SFU/runtime dependencies
or one coherent deployment entry, and controllable shared encoding/adaptation/
SFU distribution. Customizable ownership does not require custom congestion or
quality algorithms. Preserve this phase's independently useful fixes and Client
enhancements while reviewing the encoder-pool alternative: concurrent rooms,
tab/session ownership, Global Link startup, live controls, presentation,
diagnostics and stable build paths remain in scope. Media-dependent fixes must
retain their behavior in a replacement, not necessarily their old machinery.
Do not discard these changes through a wholesale branch reset or expand into
unrelated features merely because this branch is already large.
The owner authorized resuming physical acceptance after the 2026-09-08
machine-freeze report; causation remains unconfirmed. Run one bounded capture/
codec workload at a time, require cleanup before the next, and keep VM and
unrelated hardware workloads out of that interval. Start with Native SFU VP8
at 720p15, then H264, followed by controlled loss/overload checks.
The owner makes Windows Client and Browser the acceptance targets for this
phase. Keep macOS/Linux implementation and standard build/package support;
their physical matrices and the unavailable local Mac SDK build may follow user
feedback and do not block this release. Do not claim those paths were tested.
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
multi-RID metrics are implemented. Browser and Native H264/VP8 SFU paths pass
Browser decoding, live profiles, audio and cleanup. Matched Client/platform and
constrained-network acceptance remain open. The latest eight-package Linux race
run passes; the subsequent categorical-quality and assembly changes pass the
full Windows core checks using stable executable paths.
Packaged multi-output capture is not accepted.
Embedded STUN is bound by the application lifecycle and passes startup/rollback/
closure checks. Embedded SFU room signaling, exact physical retirement and Browser
adapters are implemented; real Browser decoding passes and external-service
deployment removal is prepared, not deployed. Prioritize the shared quality/encoding module and its
Native codec/transport checks, then complete embedded SFU/STUN integration.
The real-codec 120 kbps relay trace now recovers with the library's non-pausing
lowest-layer policy only while a live local encoder owns that output's bitrate.
Two constrained/released runs and received-frame decoding pass without harming
the healthy sibling. The owner accepts best-effort adaptation delays of several
seconds; do not expand the model to promise imperceptible switching. Permanent
stalls, stale generations and sibling damage remain defects. Upstream assembly-
gap recovery is implemented and checked; finish matched-package acceptance.
The owner reaffirmed shared encoding and weak-path adaptation as the core
release targets. Windows shared output workers now attach stock WebRTC
codec/resource adaptation and both H264/VP8 shrink and recover in the actual
encoded-input process check. Retain actual-dimension metadata and source
timestamps; do not replace this with another fixed ladder. Independent
incompatible weak-child demand grouping is implemented; finish capture cadence/overload and
usable delivery comparisons before accepting Browser-equivalent behavior.
Dependent release approval remains held; this is not merely packaging work.
The [pinned WebRTC trace and executed encoder-pool probe](./research/webrtc-encoder-pool.md)
show that a transparent factory cache alone loses reuse when independent
corrected rates diverge. Sharing WebRTC's existing overshoot corrector with the
physical encoder passes the narrow VP8 reuse/split/adapt/rejoin check. Keep that
evidence distinct from full quality parity: hardware/resource feedback,
pre-encoder drops for untrusted codecs, received-source bypass and real transport
remain integration gates. The research owns measured results and the replacement
map, not a second accepted architecture. A new isolated candidate is authorized;
do not merge the current candidate just to create that base. Client simplification
review should identify redundant owners and compensating mechanisms, not split
files or remove required platform adapters for appearance alone.
Cross-level reuse now has actual two-hop Pion replay evidence and a separate
two-consumer shared-derivation/retirement check. Keep `Source.WriteRTP` as the
healthy encoded bypass; integrate VSE/pool only behind required local outputs,
not a fake per-child raw pipeline or a replacement transport. The Windows
derivation process now uses the new output pipeline and grouped demand
membership; complete mixed-network acceptance. One-total-encode claims must
count Host standby outputs and exclude pure Browser intermediate re-encoding.
The delayed-codec probe exposes repeated input-drop split/rejoin in the narrow
factory cache. Evaluate sharing the complete encoding/adaptation pipeline per
compatible output before adding physical-resource proxy machinery. Neither the
cache nor the shared-pipeline control has established full overload parity.
Independent library/service audits may proceed in parallel. Do not add a custom warm pool, media clock
or congestion algorithm. These are
not bundled service executables, full LiveKit embedding or per-Viewer Host
uploads via TURN. Concrete codec parameters and release cutover remain unaccepted.

The owner retains the smallest direct-child responsibility model: reuse suitable
encodings already received at this node; derive a missing output locally for
compatible direct-child demand. Do not add ancestor-cache discovery or extra
upstream layer subscriptions merely to avoid a local encode. That expansion's
subscription/bandwidth/lifecycle cost has no measured benefit in this phase.

Field feedback from the owner's current Client bundles is being resolved in
parallel. The Vivaldi report is resolved: a VPN extension forced off WebRTC IP
broadcasting, and correcting that setting restored Native sharing on the affected
device. [Client troubleshooting](../cmd/screener-client/README.md#vivaldi-and-vpn-extensions)
records the remedy. CS2 feedback and local reproduction confirm quiet-source
profile preparation timing out; 1440p60 capture also exposes inconsistent encoded
frame and forwarding bounds. Finish both corrections through actual Viewer
delivery. The reported Browser-setting rollback has a separate confirmed owner
defect: successful capture changes must not be rolled back only in the UI when
optional Native ingress fails. Retain pending drafts and reject stale completion
effects across signaling recovery, stop and the next share.

The returned Go core and frontend fixes are reconciled on the integration
candidate. The owner authorized hygiene cleanup, matched Server/Client builds,
one squash PR and a controlled deployment. Complete the existing checks and
embedded-service unit/environment rollback before cutover. Device/network checks below
remain evidence gaps, not claims established by compilation or local loopback.

1. **Client physical acceptance.** Validate Windows Client and Browser
   capture/audio/recovery, a separate-device public-link Browser Viewer, and a NAT case
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
   Host per room. Tab authority is now separate from the origin-wide resume hint;
   two Native control sessions have independent ownership and bounded admission.
   Browser multi-tab, concurrent Native media and independent session retirement
   checks pass. Preserve those behaviors through any media replacement; this is
   not multiple-device or endurance acceptance. Do not add an unbounded capture map.
   A friend's independent
   Browser Host already captures on their own device, not the instance owner's
   helper. Validate that path separately from multiple Native shares on one Client.
2. **Reported live-setting and package behavior.** Reconcile the unmerged
   `fix/live-quality-capture` fixes against this candidate, retaining only
   independently confirmed capture, setting, access and diagnostic behavior.
   Do not overwrite the new media/transport owners with that older branch.
   The current VP8/H264 minimize/live-update sequences pass; their scope is recorded
   in [capture research](./research/native-client-lifecycle.md). This does not
   prove game HWND replacement or device-loss recovery. Reproduce game backgrounding,
   changing resolution/FPS/bitrate, and returning to the game against the exact
   newly built Client, not a repacked old executable. Verify failed replacement
   preserves the running source and later changes still apply. Keep preset
   highlighting tied to applied settings and make the advanced draft/apply
   boundary unambiguous. Complete the Windows display-startup and platform
   checks above. The Vivaldi extension-policy case is resolved and documented in
   [Client troubleshooting](../cmd/screener-client/README.md#vivaldi-and-vpn-extensions).
   The owner narrowed the game reproduction to CS2 in fullscreen 4:3 stretched:
   Alt-Tab out, change advanced sharing settings, then return to the game;
   interruption occurs on return. Ordinary window minimization is not this
   display-mode/capture-session transition.
   The current Windows 11 candidate passes actual CS2 fullscreen 1920x1440
   Alt-Tab/pending-setting/return twice at 1080p30 and 720p30, preserving media
   and subsequent settings. This does not establish the affected machine's
   root cause, vendor panel-fit or in-match behavior. The additional prolonged
   background case did not hold its minimize precondition; verify separately.

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
3. **Browser encoded reuse (parked).** Client pool integration takes priority;
   this research must not delay it or become a release prerequisite.
   Pure Browser operation keeps normal WebRTC
   senders; users can use Client to reduce repeated encoding. The September 8
   [Chromium legacy probe](./research/advanced-peer-distribution.md#chromium-legacy-fanout-probe)
   proves clean-path VP8/H264 single encode to two PCs without Client, but late
   join fails, the secondary encoder bitrate ceiling is bypassed and its frame
   statistics do not describe the borrowed stream. Revisit
   product integration only for a small proven adapter preserving recovery,
   independent adaptation and truthful evidence; do not silently ship the shortcut
   or introduce an application-owned transport/quality controller.
4. **Control-plane resource fairness.** Reassess ingress budgets against the
   current authenticated room WebSocket and embedded SFU owner before adding
   another queue or limiter. The replaced external media-token/control service
   is not an implementation target. Do not introduce accounts, polling, risk
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
11. **Native media endurance.** Exercise long-lived Native P2P and direct Native
    SFU publication recovery after the platform capture boundary passes. Preserve
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
    An explicit `client_checks=true` workflow dispatch produces the application
    release and three native-runner Client candidates with SHA-256 metadata.
    Ordinary `main` pushes do not package release artifacts. The default Client
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
    acceptance: match the current Client and Browser artifacts and complete
    the embedded-media cutover. Production already runs the Go application,
    while its external media services have not yet been replaced.
17. **Feedback bundle.** The candidate now has bounded Client/Server diagnostic
    files, asynchronous Client `D` export, Unix Server `SIGUSR1` export and
    orderly-shutdown snapshots, documented in
    [configuration](./reference/configuration.md). Profiles describe the Go
    runtime; Browser export stays separate, and credentials, media and raw
    process memory are excluded. Exports stay local with manual archive cleanup.
    Focused file/privacy/layout checks and the Linux Server build pass;
    packaged user acceptance and deployed Unix signal/export behavior remain
    part of the existing release acceptance, not established by those checks.
18. **Remaining audit behavior.** During the owning refactor, reproduce and
    resolve optional Local-password cookies across HTTP LAN/HTTPS public origins;
    audio-process failure without stopping healthy video; natural capture EOF
    attribution; and Native prepared-bridge failure that must disable Native
    for the current Viewer session before retrying. Storage I/O failure needs
    an authority-consistent recovery policy, not catch-and-continue guards.
    The Local duplicate-launch guard is the in-process listener bind itself;
    it refuses a second Client on the same port and hands nothing over.
