# Current Status

Last updated: 2026-09-12

This is the compact execution/deployment index. Product modules own behavior,
[verification status](./verification-status.md) owns unresolved physical limits,
and Git/PRs own completed history.

## Accepted Release Contract

- Browser/server v23, Native control v9 and capture v7 form one private contract.
  The coordinated brand/protocol cutover requires matching Web/App/Server
  artifacts and a reload of incompatible active pages.
- Hosted Server defaults to SQLite schema 2. Room authority has no inactivity
  expiry; explicit replacement/deletion or grant rotation/revocation ends the
  corresponding authority. Explicit memory mode and App Local end rooms at
  process exit. Site access retains its separate 24-hour idle lifetime.
- Browser/App entry lifecycle and current-edge reconnect ownership repairs
  are implemented. Browser node-local pooling and detailed local Debug export
  remain part of the accepted media surface. Product modules own their behavior;
  [configuration](./reference/configuration.md#diagnostics) owns Debug activation,
  report contents and disclosure.

## Deployment

Source, package identity, GitHub repository and local worktree paths use Piik.
Runtime code keeps only the Piik wire labels and stored keys. The coordinated
private cutover requires matching App/Server/Web packages; unavailable old
Browser credentials cannot be reconstructed from stored digests.
The immutable release descriptor, runtime `REVISION` and operator deployment
record own exact identity and postflight results. Old active pages reload at
the signaling v23 boundary.

The existing deployment uses one Go process for Web, room authority/signaling,
Binding-only STUN on UDP 3478/3479/3480 and optional SFU on UDP 7882. nginx owns
HTTPS; external LiveKit/coturn services remain disabled. Participants, routes and
media remain process-only. This private service is not a public demonstration.

[TODO](./todo.md) owns the remaining release/launch
work. The owner accepted the website, README/guides and UI presentation on
2026-09-12; final functional and release acceptance remains pending. The working
branch combines the App/UI revision, public guides, website and versioned
distribution pipeline. The Windows test
candidate is prepared for owner review; bounded two-build interoperability and
update checks passed. This is
functional test acceptance, not final public-release acceptance. The
complete publisher rehearsal is blocked by the Actions artifact-storage quota.
Main and production have not changed. Shared lessons live in
[engineering](./reference/engineering.md); [verification status](./verification-status.md#candidate-evidence-boundary)
owns the remaining evidence limits. Version-plus-SHA metadata,
release comparisons, GitHub/Gitee update fallback and the post-main publishing
pipeline are implemented with local checks. The public Gitee README mirror and
publisher secret are configured; small-file upload and anonymous download passed.
Full-package mirror acceptance, public compatibility and publishing activation remain
pending under [versioning](./reference/versioning.md).

## Media Evidence And Limits

- Compatible Native consumers share one complete stock WebRTC encoding and
  adaptation pipeline per local output. Different weak demands stay independent;
  suitable received media can be forwarded without decoding/re-encoding.
  Pion/LiveKit retain transport, estimation, pacing and forwarding ownership.
- Windows H264/VP8 have bounded encoding/adaptation evidence. Actual Native
  relay checks cover compatible sharing, weak-budget separation and rejoining,
  source retirement and large encoded-frame delivery. These results do not
  establish a universal encoder count, CPU saving or Browser-equivalent quality.
- Windows Host acceptance covers live and paused settings, quiet-source
  preparation/restore, source changes and subsequent sharing. The owner
  confirmed Windows 10 whole-display capture resolved. Specific new game/device
  failures should be reopened from new evidence.
- Native Host publication through embedded SFU retains video/audio; Browser to
  App fanout and App-exit fallback have bounded physical checks. Two
  independent Native sessions have simultaneous media/retirement evidence.
- The Linux runtime container has non-root/read-only, memory/SQLite, diagnostic
  export, STUN and listener-lifecycle evidence. This does not establish every
  operator's proxy/firewall or public-media configuration.
- The independent Browser producer in ADR-0014 is integrated.
  Bounded H264/VP8 checks cover direct and received-track sharing, weak-child
  isolation/recovery, live/quiet settings, pause, source change and ordinary
  fallback. Its native allocation and complete-frame output replace the earlier
  payload-only Worker path. Fewer full encodes are established; total CPU gains
  depend on codec/hardware. [Browser research](./research/browser-local-encoding-pool.md)
  owns these measurements and failed controls. The owner accepted this scoped
  Browser composition for release; actual deployment identity stays in the
  runtime descriptor.
- Slow adaptation recovery, the extreme CPU-overload sampling limit and missing
  broad device/network/endurance results remain explicit in
  [encoder research](./research/webrtc-encoder-pool.md) and verification status.
  macOS/Linux physical capture is deferred by the owner; Windows App and
  Browser are this phase's primary targets.
