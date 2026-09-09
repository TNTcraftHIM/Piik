# Current TODO Ledger

Last reviewed: 2026-09-09

Only **Now** is executable. Product modules own behavior, research owns evidence,
and Git/PRs own completed history. A parked idea is not implementation authority.

## Now

2026-09-09 owner-requested research continuation: independently test a Browser
node-local producer and two dummy/carrier egress senders. The earlier experiment
borrowed a real child's encoded output and does not decide this architecture.
Compare ordinary senders, quiet placeholders, live tiny carriers and standard
own-frame payload replacement. Count all encoding/local-loopback work; verify
source freshness, ordering, independent weak-path behavior, recovery and sender
accounting before proposing product integration. Keep the completed Debug
supplement on its separate branch; no main merge or production switch is implied.

The first [independent-producer experiments](./research/browser-local-encoding-pool.md)
are complete and support continuing this candidate. Before any product adapter,
resolve weak-entry latency, safe recovery/membership, carrier versus actual-media
statistics, A/V synchronization and representative whole-process/GPU cost.
The experimental budget bridge is not an accepted routing/media policy. Reuse
existing Browser statistics owners in a proposed adapter; do not add a second
congestion estimator, whole-tree cache, or periodic topology controller.

The owner now authorizes product integration after refinement. Match ordinary
WebRTC viewing quality and recovery under the same constraints; reasonable
adaptation time is acceptable, perfect seamlessness is not required. First
finish weak-entry/recovery and A/V evidence, then record the accepted adapter
boundary in the media ADR before connecting it to product senders. Keep the
pool source-owned, consider direct children only, and reuse existing connection,
capture, settings and statistics owners. Receiver details must remain measured
inbound data. Sender details and quality evidence must describe real transmitted
media and its assigned encoder, never the dummy carrier's encoder statistics.
Check lifecycle/pause/source replacement, mixed ordinary/pool receivers and
whole-process cost before integration acceptance. Do not deploy a partial adapter.

Use one Browser pool path from the first eligible consumer, as requested after
the singleton overhead comparison. Do not add an audience-count threshold or
switch back and forth as the audience crosses it. Ordinary encoding remains
the capability/failure fallback. Native already uses one required-output model
for singleton and shared consumers.

Current integration hold: the standard payload-only carrier still has intermittent
VP8 startup/dependency stalls at 1080p. Do not deploy that path or fix it with
another keyframe timer. A scoped Chromium encoded-stream comparison now keeps
the producer frame's complete metadata, retimes it to the local carrier, and
uses a natively scaled source clone. It passes initial healthy/weak A/V checks
for both codecs and may remove the canvas and key-type rendezvous. Validate the
complete replacement, record its supported API boundary, and delete the
superseded implementation in the same phase if selected. The current product
adapter is not yet accepted for release.

The embedded-media phase is already integrated and deployed. The detailed Debug
supplement and matched review package are complete on their separate branch,
held for owner acceptance. Do not re-merge or redeploy either checkpoint merely
to continue this research. Public release and piik branding/site work remain
separate product stages.

The owner-confirmed phase order is:

1. Finish Browser pooling and the completed-but-unmerged detailed Debug
   supplement, including truthful viewing details and their combined acceptance.
   Then apply the same ablation to the current Native Client encoding path:
   inspect duplicate state/budget calculations, unnecessary encoder recreation,
   and responsibilities already owned by mature media components. Transfer
   Browser findings only when their ownership and measurements also apply to
   Native; do not force identical adapters or reopen a broad rewrite. Preserve
   each direct child's quality, independent adaptation and existing forwarding.
2. Prepare publication: simplify English-first/bilingual README and quick start,
   reuse the existing logo and add useful small diagrams, improve deployment
   scripts and Docker packaging, and keep advanced configuration in developer
   documentation. Reconcile the release-docs branch rather than recreating it.
   Include update/replacement guidance, release artifacts/workflows, dependency
   notices and the diagnostic export disclosure; keep Actions storage/CI cost
   controlled. No public demo of the private production service is planned.
3. Discuss the complete **piik** rename with the owner before implementing it.
   The owner has acquired **piik.tv**. Decide casing, logo/wordmark treatment,
   repository-owned names and identifiers, release migration and a GitHub Pages
   website together. The website should provide concise tutorials and lively
   demonstrations consistent with the product. Existing piik sketches are input,
   not an accepted visual identity. Do not rename code, move domains, configure
   DNS/Pages or publish the new brand during the preceding media/debug work.

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
4. **Browser encoded-input API.** RTCEncodedSource is a future simplification
   lead, not current M152 availability or automatic adaptation. It does not block
   the active same-frame carrier research above. Either adapter must pass
   independent quality, recovery and truthful statistics before product use.
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
