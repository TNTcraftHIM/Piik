# Current TODO Ledger

Last reviewed: 2026-09-09

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

Owner-authorized phase: [embedded STUN/SFU and node-local media](./adr/0013-embedded-node-local-media.md).
Finish this phase as one integration, preserving the completed mainline checkpoint.

1. **Release integration.** One complete PR must contain the Native/embedded
   media work, retained Client fixes, final corrections, current documentation
   and research outcomes. Build matching Web/Server/Client/capture artifacts
   from the accepted revision; main remains a low-frequency integration branch.
2. **Coordinated production cutover.** Recheck active sessions, preserve the
   exact old release/unit/environment/proxy/media-service state and SQLite
   recovery material, then replace external LiveKit/coturn with the embedded
   process. Verify HTTP/assets, STUN, SFU media, listener retirement and rollback
   using [self-hosting operations](./operations/self-hosting.md).
   The routine application updater alone cannot perform this first cutover.
3. **Matched delivery.** Provide the current Windows Client package and Server
   descriptor/archive with matching hashes and notices. Production pages and
   old Clients cannot be mixed across the private protocol change. Formal
   public GitHub Release/image publication remains a separate explicit action.

Current evidence and limits:

- Windows/Browser are the primary targets. Native Host, Native embedded SFU and
  Browser-to-Client fanout pass profile, audio, pause/recovery and cleanup checks.
  Local container checks cover non-root/read-only operation, memory/SQLite,
  diagnostics, STUN and media listener lifecycle; they do not prove target-network
  media. macOS/Linux physical matrices may follow user feedback.
- Compatible Native consumers share one complete encoding/adaptation pipeline;
  incompatible direct-child demands remain independent. Reuse suitable received
  encodings and derive missing outputs locally. No ancestor-cache discovery,
  extra upstream layer subscription, custom BWE or resource controller is accepted.
- Extended weak-network recovery passes. Preserve the earlier missed twelve-second
  observation and extreme single-core sampling-reset limitation in
  [encoder research](./research/webrtc-encoder-pool.md); neither establishes a
  universal recovery deadline or a missing callback.
- The owner closed Win10 whole-display sharing. Quiet-source settings pass real
  WGC/Browser acceptance. Reopen distinct game/display failures only from new
  evidence, not a failed automation focus precondition.
- [Browser encoded reuse](./research/advanced-peer-distribution.md#september-9-results-and-decision)
  completed after the mainline checkpoint. Late join can recover with one keyframe
  request, but legacy fanout fails independent quality and sender accounting.
  Standard Transform rejects cross-source frames. No product adapter is accepted.
  Keep normal Browser senders and the verified optional Client fanout.
- Run one bounded capture/codec workload at a time, with cleanup before the next.
  Keep VM workloads out of that interval and use stable executable build paths.

## Parked Product Work

1. **Comprehensive Debug feedback.** Authorized as follow-up on 2026-09-09 for
   Client and Server. Use mature projects' feedback-bundle practice. A first
   report should contain enough context to diagnose without another build just
   to add missing logging: operation start/end and identity, requested/applied
   settings, capture/codec/ICE/transport transitions, resource and queue pressure,
   and precise failed checks with safe expected/actual values.
   Debug-on completeness takes priority over minimal log volume; keep explicit
   resource bounds without silently removing essential context. Exclude
   credentials, access/media tokens and private keys. Do not promise complete
   anonymization; document residual identifiers, network/system information and
   export contents clearly. Keep local opt-in collection and user-controlled
   sharing. Design one observability surface, not incident-specific patches.
   Assess stack and memory snapshots by diagnostic value and document their
   contents; do not silently include raw media or secret-bearing memory.
   Existing exports are owned by [configuration](./reference/configuration.md).
2. **Public distribution and updates.** Candidate packagers, immutable descriptors,
   notices, the runtime-only OCI recipe and release checks exist. Choose the
   public asset set and release notes before publishing a full-SHA GitHub Release
   or image. Do not add automatic installation, container self-update, Watchtower,
   compatibility ranges or active-share interruption without distribution and
   recovery evidence. Ordinary branch pushes must not run expensive CI packaging.
3. **Representative device/network acceptance.** Exercise public-network direct
   and relay paths, two-room SFU, real-game A/V, twenty-Viewer endurance,
   sustained loss/recovery and all-UDP-blocked bounded failure. Correlate freezes
   with publisher/receiver evidence before changing representation policy.
   Physical Android/iOS work includes autoplay, background/lock, rotation,
   network migration and relay survival. Secondary desktop platform matrices
   remain explicitly deferred; compilation does not prove capture.
4. **Browser encoded-input API.** Reopen reuse only when a supported API supplies
   usable injection, feedback and timing ownership. Chromium's experimental
   RTCEncodedSource is a lead, not current M152 availability or automatic
   adaptation. An adapter must pass independent quality, recovery and truthful
   statistics before product integration.
5. **Broader quality work.** Reopen from measured benefit at acceptable complexity.
   Preserve chosen profiles, bitrate ceilings, endpoint capacity and P2P-first
   routing unless a new accepted decision supports changing them. No weighted
   score, all-pairs probes, periodic rebalancing, parent-wide prediction or
   room-wide minimum. Check whether a quality move merely shifts pressure to
   another parent's siblings before widening policy.
6. **Startup codec budget.** Compare bounded Auto and first-frame behavior on
   representative hardware. Throughput qualification does not guarantee perceptual
   quality or later GPU load. Do not silently weaken Auto or introduce
   comparative/dual probing without evidence.
7. **NAT field evidence.** Preserve [ADR-0009](./adr/0009-optional-nat-prediction.md).
   Validate selected predicted/mapped paths and bounded resource cost, including
   a Native case rescued beyond ordinary STUN. Measure the three-attempt budget
   before expanding it; new connections do not guarantee independent mappings.
   Candidates remain connection-local and diagnostic, not participant labels,
   hard skips, route scores or SFU preference.
8. **Control/resource fairness and input review.** Reassess the authenticated
   WebSocket/SFU owner, HTTP/body/resource bounds, authorization and error/log
   handling before adding a queue or limiter. No parallel security framework,
   accounts, risk score or speculative policy layer.
9. **Reachable ownership/refactor work.** Extract page media-session owners only
   alongside behavior changes; file size alone is not a rewrite reason. Reopen
   C=3 structural-intent retention, SFU failure during unrelated prepare and
   multi-child evidence ownership only with current-contract reproductions.
   No new revision namespace, failure-state mirror or topology queue by default.
10. **Storage fault recovery.** Ordinary transactions persist before memory
    changes; failures must preserve authority. Message-handler panics must unwind
    locks. Damaged-disk/COMMIT/ROLLBACK recovery is not established; choose its
    policy explicitly rather than adding catch-and-continue or retries.
11. **Platform output.** System/tab mirroring needs no adapter. Remote Playback,
    Cast and AirPlay do not provide a portable live MediaStream receiver.
    Reopen for a registered receiver acting as an ordinary Viewer after the
    [platform-output gate](./research/platform-output.md) passes.
