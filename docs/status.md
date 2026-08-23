# Current Status

Last updated: 2026-08-23

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact `d3ff9e7b7b4a8fe58db700565971aaeda638d2e9`, release `d3ff9e7`, wire `screener-v8`; `352c457` is the immediate rollback release and `/opt/screener/backups/d3ff9e7-precutover-20260823T150618Z` retains its verified environment/unit/LiveKit boundary.
- `screener`, LiveKit, coturn, and nginx are active; local/public health return 200 and all services report `NRestarts=0`. The v8 unit has no writable room `StateDirectory`, the process has no SQLite descriptor, and the old live SQLite path is absent.
- Production admits one Host plus 20 Viewers, applies endpoint capacity `2`, rejects stale v7 Browser and executable-sender wires before room authority, and runs the one-controller exact-candidate route model. Rooms use random free four-digit codes, a 24-hour dormant lease, restart loss, local Host creation preferences, independent Viewer grants, and `open | password | disabled` code entry. LiveKit remains dedicated with `room.auto_create: false`, `max_participants: 21`, global admission `1` publication ingress / `20` subscription egress; selected TURN has `2` logical allocations.
- Production still has access/privacy controls, self-check, diagnostic export, signaling watchdog behavior, 64/128/256 audio choices, and selected-edge transport. These deployment facts do not close the real heterogeneous-network, SFU/TURN media, mobile, or endurance evidence boundaries.
- SFU subscribers reconcile Host screen publications across connect, activation, participant arrival, track publication, and reconnect. A controlled production canary forced two SFU roots; both committed `route-ready`, reached active SFU assignments, and decoded 1920x1080 video. LiveKit runs at `warn`/Pion `error`, and the Screener unit waits boundedly for the same-host LiveKit control listener before startup.

## Current Source

- Canonical source is the root `main` branch; auxiliary branches and worktrees do not own current truth. Audit/integration boundaries require a clean root, and dependent work starts only from its exact commit.
- Current source implements one steady outbound media-copy cap for every non-server endpoint: default `2`, static `1/2/3`, a peer child or Host publication consumes one slot, upstream receive is free, a committed selected TURN transport replaces the same copy while hidden carry consumes another, and no Browser/UA/visibility tier exists. One shared guard owns the accounting and transition work is bounded by `min(C + 1, 3)`.
- Current source and production admission support one Host plus up to `20` Viewers. Focused controller coverage includes `C=1/2/3`, a 20-Viewer graph, and the passed local 20-Viewer Browser smoke; real external-network media and resource measurements remain open.
- The single Browser `screener-v8` boundary rejects stale Browser and executable-sender wires before room authority and carries the exact deployment cap plus exact prepare candidate in the authenticated route contract.
- Current source also implements explicit no-default SFU ingress/egress capacities and exact `reserved | committed | draining` accounting. The listener owner reconciles its dedicated non-auto-create LiveKit namespace before serving, creates each generation before token issuance, releases only after delete-plus-absence proof, and reclaims Host-offline generations through bounded exact-participant checks. Selected TURN has an independent explicit no-default deployment capacity; one process-local ledger charges every exact peer-selected edge and Host-SFU ingress through reserve, commit, drain, and release.
- Current source implements automatic P2P-first routing with one active upstream, an acyclic source-reachable graph, exact Browser v7 prepare tuple, first-decoded-frame make-before-break, strict rollback revision, and bounded wait or failure.
- One event-driven controller owns the committed graph and at most one room-serial child operation. The operation owns one deterministic tuple list/cursor, one current candidate and reservations, fact version, and one total deadline. Failed tuples are operation-local; exhaustion retires invalid/overflow edges but retains healthy bootstrap media. Bounded-gap preflights resources, replans the remaining suffix, and restores a healthy retired edge through one final ordinary candidate. Admission commits synchronously before graph promotion; release uses the resource-set difference and room disposal returns all resources. One Host publication serves exact Viewer subscription handles, selected TURN changes only transport, and actual global resource release wakes registered waiting rooms.
- Parent selection is deterministic rather than random or score-based: hard eligibility filters, then shallowest result, remaining sender capacity, stable join order, and peer identity. The exact candidate child's first new decoded frame is the only application media-ready event. Moderate bitrate, FPS, or visual degradation remains with stock WebRTC/LiveKit adaptation and diagnostics; only hard connection failure or a non-paused decoded-frame stall invalidates a route edge. Viewer connection feedback and the strict-NAT emulator gate are accepted follow-up work, not deployed behavior.
- Browser initial capture and source switching already request available share audio through one shared capture boundary and visibly retain video-only sharing when no audio track is returned.
- Live 64/128/256 audio-ceiling mutation and paused-share video codec switching are accepted but not yet implemented on canonical `main`. H.264 startup blur/low-FPS reports remain an evidence-led diagnosis, not a presumed codec defect. Public-server and fully local distribution packages are later work after the functional, NAT, and real-network ledger is complete.
- Current source and production implement one process-memory RoomStore with random four-digit codes, a default 24-hour dormant lease, exact-Host resume, restart loss, local Host preference replay, independent token invitations and `open | password | disabled` code entry, and no SQLite runtime. The Host UI separates the invitation, room-code entry policy, password, grant update, and grant revoke controls.

## Current Milestone

1. Release live audio-ceiling mutation and paused-share codec switching on the deployed generation/transition boundary.
2. Reproduce the H.264 startup report before any codec-specific repair, and build the strict-NAT emulator gate before any manually approved canary in an operator-owned test room.
3. Add first-frame-driven Viewer connection stages, then finish the remaining accepted functional and real-network work.
4. Validate and deploy each coherent slice in this order with its focused browser/network/resource and rollback gates; distribution packaging remains outside this milestone.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current Browser milestone and are not built or run.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Room entry, sharing controls, ID lifetime, storage semantics, v8 stale-client rejection, restart loss, and rollback restoration are aligned between current source and production.
- Real SFU/TURN recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

The Browser route, SFU subscription reconciliation, and memory-room slices are deployed, but room
`9403` exposed a P1 fallback-budget regression: silent direct/selected candidates can consume the
whole operation before an existing SFU publication is reused. Fix and deploy the one-timer staged
deadline invariant before resuming live-media, Native/executable, or broad cleanup work.
