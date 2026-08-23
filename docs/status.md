# Current Status

Last updated: 2026-08-23

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- `screener`, LiveKit, coturn, and nginx are active; local/public health return 200, `screener` has `NRestarts=0`, and SQLite schema v3 remains protected with mode 0600.
- Production has automatic routing, bad-relay handling, peer-quality make-before-break, Viewer/Host provisional parents, selected-edge transport, stable connection details, 64/128/256 audio choices, access/privacy controls, self-check, diagnostic export, and signaling watchdog behavior.
- Exact deployed routing remains Host downstream `2`, ordinary Browser downstream `1`, deployment values `1/2`, fixed SFU roots `2`, and legacy publication/selected accounting. This is production fact only; it differs from the accepted endpoint-cap direction.

## Current Source

- Canonical source is the root `main` branch; auxiliary branches and worktrees do not own current truth. The documentation-only route/room truth and handoff checkpoint is part of this canonical state; start dependent work only from that exact root `main` commit.
- Current source implements one steady outbound media-copy cap for every non-server endpoint: default `2`, static `1/2/3`, a peer child or Host publication consumes one slot, upstream receive is free, a committed selected TURN transport replaces the same copy while hidden carry consumes another, and no Browser/UA/visibility tier exists. One shared guard owns the accounting and transition work is bounded by `min(C + 1, 3)`.
- Current source and accepted room admission support one Host plus up to `20` Viewers. Focused controller coverage includes `C=1/2/3` and a 20-Viewer graph; real Browser resource and media measurements remain release evidence.
- The single Browser `screener-v7` boundary rejects stale Browser and executable-sender wires before room authority and carries the exact deployment cap plus exact prepare candidate in the authenticated route contract.
- Current source also implements explicit no-default SFU ingress/egress capacities and exact `reserved | committed | draining` accounting. The listener owner reconciles its dedicated non-auto-create LiveKit namespace before serving, creates each generation before token issuance, releases only after delete-plus-absence proof, and reclaims Host-offline generations through bounded exact-participant checks. Selected TURN has an independent explicit no-default deployment capacity; one process-local ledger charges every exact peer-selected edge and Host-SFU ingress through reserve, commit, drain, and release.
- Current source implements automatic P2P-first routing with one active upstream, an acyclic source-reachable graph, exact Browser v7 prepare tuple, first-decoded-frame make-before-break, strict rollback revision, and bounded wait or failure.
- One event-driven controller owns the committed graph and at most one room-serial child operation. The operation owns one deterministic tuple list/cursor, one current candidate and reservations, fact version, and one total deadline. Failed tuples are operation-local; exhaustion retires invalid/overflow edges but retains healthy bootstrap media. Bounded-gap preflights resources, replans the remaining suffix, and restores a healthy retired edge through one final ordinary candidate. Admission commits synchronously before graph promotion; release uses the resource-set difference and room disposal returns all resources. One Host publication serves exact Viewer subscription handles, selected TURN changes only transport, and actual global resource release wakes registered waiting rooms.
- Parent selection is deterministic rather than random or score-based: hard eligibility filters, then shallowest result, remaining sender capacity, stable join order, and peer identity. The exact candidate child's first new decoded frame is the only application media-ready event. Moderate bitrate, FPS, or visual degradation remains with stock WebRTC/LiveKit adaptation and diagnostics; only hard connection failure or a non-paused decoded-frame stall invalidates a route edge. Viewer connection feedback and the strict-NAT emulator gate are accepted follow-up work, not deployed behavior.
- Browser initial capture and source switching already request available share audio through one shared capture boundary and visibly retain video-only sharing when no audio track is returned.
- Live 64/128/256 audio-ceiling mutation and paused-share video codec switching are accepted but not yet implemented on canonical `main`. H.264 startup blur/low-FPS reports remain an evidence-led diagnosis, not a presumed codec defect. Public-server and fully local distribution packages are later work after the functional, NAT, and real-network ledger is complete.
- The accepted room target is one process-memory RoomStore with random four-digit codes, a default 24-hour dormant lease, local Host preference replay, independent token invitations and `open | password | disabled` code entry, and no SQLite. Current source and production still use the old 12-digit/SQLite and `private-link | public-watch` surfaces; the target is documented and queued, not implemented or deployed.

## Current Milestone

1. Release the implemented generic route loop on the single Browser `screener-v7` wire after its remaining production acceptance boundary.
2. Release live audio-ceiling mutation and paused-share codec switching on the resulting generation/transition boundary.
3. Reproduce the H.264 startup report before any codec-specific repair, and build the strict-NAT emulator gate before any manually approved canary in an operator-owned test room.
4. Add first-frame-driven Viewer connection stages, then implement the accepted memory-resident room/access slice and finish the remaining accepted functional and real-network work.
5. Validate and deploy each coherent slice in this order with its focused browser/network/resource and rollback gates; distribution packaging remains outside this milestone.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current route release and are not built or run in this milestone.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Room entry, sharing controls, ID lifetime, and storage semantics are settled in the owning requirements/design/ADR and queued after the route boundary. Current source remains divergent until that complete slice replaces the old access and persistence model atomically.
- Real SFU/TURN recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

The route model and Browser source are complete and merged. Work is intentionally paused before
production release or any later TODO until the owner chooses the next action. Production therefore
remains on `9461e20` / `screener-v5`; source completion must not be reported as deployment.

If the owner resumes the route release, do not repeat the full local suite. Run one resource-limited
20-Viewer Browser smoke, then production preflight, deploy, postflight, and rollback verification.
The dedicated LiveKit instance and measured SFU/TURN capacities remain required deployment inputs.
