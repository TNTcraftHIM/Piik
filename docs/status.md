# Current Status

Last updated: 2026-08-23

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- `screener`, LiveKit, coturn, and nginx are active; local/public health return 200, `screener` has `NRestarts=0`, and SQLite schema v3 remains protected with mode 0600.
- Production has automatic routing, bad-relay handling, peer-quality make-before-break, Viewer/Host provisional parents, selected-edge transport, stable connection details, 64/128/256 audio choices, access/privacy controls, self-check, diagnostic export, and signaling watchdog behavior.
- Exact deployed routing remains Host downstream `2`, ordinary Browser downstream `1`, deployment values `1/2`, fixed SFU roots `2`, and legacy publication/selected accounting. This is production fact only; it differs from the accepted endpoint-cap direction.

## Current Source

- Canonical source is the clean `main` branch; auxiliary branches and worktrees do not own current truth.
- Current source implements one steady outbound media-copy cap for every non-server endpoint: default `2`, static `1/2/3`, a peer child or Host publication consumes one slot, upstream receive is free, a committed selected TURN transport replaces the same copy while hidden carry consumes another, and no Browser/UA/visibility tier exists. One shared guard owns the accounting and transition work is bounded by `min(C + 1, 3)`.
- The v6 release boundary rejects v5 before room authority and carries the exact deployment cap in every authenticated snapshot so ordinary Host authorization, Native admission, peer-assisted child assignments, and sender slots share the server authority. It leaves an SFU-fed Viewer childless without independent outbound proof and keeps quality events child-scoped without a fixed two-child parent drain.
- Current source also implements explicit no-default SFU ingress/egress capacities and exact `reserved | committed | draining` accounting. The listener owner reconciles its dedicated non-auto-create LiveKit namespace before serving, creates each generation before token issuance, releases only after delete-plus-absence proof, and reclaims Host-offline generations through bounded exact-participant checks. Selected TURN has an independent explicit no-default deployment capacity; one process-local ledger charges every exact peer-selected edge and Host-SFU ingress through reserve, commit, drain, and release.
- Automatic P2P-first routing, one active upstream, an acyclic graph, exact identity/generation authority, media-proven make-before-break, and bounded failure remain accepted.
- The holistic assisted-route model is accepted: one controller performs allocation, child reparenting, and relay abdication/drain. One Host publication serves SFU subscriptions; TURN is an exact edge transport, not a topology node. Endpoint accounting, the wire boundary, SFU lifecycle, and TURN admission are implemented; controller convergence remains pending.
- Parent selection is deterministic rather than random or score-based: hard eligibility filters, then shallowest result, remaining sender capacity, stable join order, and peer identity; one provisional edge uses standard ICE and media proof at a time. Viewer connection feedback and the strict-NAT emulator gate are accepted follow-up work, not deployed behavior.
- Live 64/128/256 audio-ceiling mutation and paused-share video codec switching are accepted but not yet implemented on canonical `main`. H.264 startup blur/low-FPS reports remain an evidence-led diagnosis, not a presumed codec defect. Public-server and fully local distribution packages are later work after the functional, NAT, and real-network ledger is complete.

## Current Milestone

1. Complete and release the remaining route-controller convergence with deterministic local parent selection and quality ownership.
2. Release live audio-ceiling mutation and paused-share codec switching on the resulting generation/transition boundary.
3. Reproduce the H.264 startup report before any codec-specific repair, and build the strict-NAT emulator gate before any manually approved canary in an operator-owned test room.
4. Add first-frame-driven Viewer connection stages and finish the remaining accepted functional and real-network work.
5. Validate and deploy each coherent slice in this order with its focused browser/network/resource and rollback gates; distribution packaging remains outside this milestone.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Real SFU/TURN recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Next Stop

Implement the independent TURN-admission and controller-convergence waves from
this source. The route release still requires measured SFU capacities, a
dedicated LiveKit instance with the documented private control-plane contract,
and the focused real-network and Native `C=1/2/3` acceptance matrix.
