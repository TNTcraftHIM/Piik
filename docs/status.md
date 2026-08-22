# Current Status

Last updated: 2026-08-22

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- `screener`, LiveKit, coturn, and nginx are active; local/public health return 200, `screener` has `NRestarts=0`, and SQLite schema v3 remains protected with mode 0600.
- Production has automatic routing, bad-relay handling, peer-quality make-before-break, Viewer/Host provisional parents, selected-edge transport, stable connection details, 64/128/256 audio choices, access/privacy controls, self-check, diagnostic export, and signaling watchdog behavior.
- Exact deployed routing remains Host downstream `2`, ordinary Browser downstream `1`, deployment values `1/2`, fixed SFU roots `2`, and legacy publication/selected accounting. This is production fact only; it differs from the accepted endpoint-cap direction.

## Current Source

- Canonical source is the clean `main` branch; auxiliary branches and worktrees do not own current truth.
- The accepted endpoint direction is one steady outbound media-copy cap for every non-server endpoint: default `2`, static `1/2/3`, a peer child or Host publication consumes one slot, upstream receive is free, selected TURN replaces the same copy's transport, and no Browser/UA/visibility tier exists.
- Automatic P2P-first routing, one active upstream, an acyclic graph, exact identity/generation authority, media-proven make-before-break, and bounded failure remain accepted.
- The holistic assisted-route model is accepted: one controller performs allocation, child reparenting, and relay abdication/drain. One Host publication serves SFU subscriptions; TURN is an exact edge transport, not a topology node. Endpoint cap, transition overlap, media-binding generations, and independent SFU/TURN admission are governed by one bounded transaction and remain runtime validation work.
- Parent selection is deterministic rather than random or score-based: hard eligibility filters, then shallowest result, remaining sender capacity, stable join order, and peer identity; one provisional edge uses standard ICE and media proof at a time. Viewer connection feedback and the strict-NAT emulator gate are accepted follow-up work, not deployed behavior.
- Live 64/128/256 audio-ceiling mutation, a source-checkout LAN one-command launcher, and paused-share video codec switching are accepted but not yet implemented on canonical `main`. H.264 startup blur/low-FPS reports remain an evidence-led diagnosis, not a presumed codec defect.

## Current Milestone

1. Rebuild and release route waves A-D from exact canonical `main`, including cap/accounting, bounded server admission, deterministic local parent selection, quality ownership, and one controller.
2. Release live audio-ceiling mutation and paused-share codec switching on the resulting generation/transition boundary.
3. Reproduce the H.264 startup report before any codec-specific repair, and build the strict-NAT emulator gate before any manually approved canary in an operator-owned test room.
4. Add first-frame-driven Viewer connection stages, then integrate the scoped LAN launcher and remaining accepted tools.
5. Validate and deploy each coherent slice in this order with its focused browser/network/resource and rollback gates.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- `feat/local-oneclick-bundle` is a stale-base donor only. Transplant its launcher logic and tests selectively; never import its old requirements, memory, status, access variable, or generated local state.
- Open PR #192 and the Native stack are evidence/research, not pending product releases.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Real SFU/TURN recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Next Stop

Create each runtime change from the resulting clean `main`; remaining TODOs stay
scoped to their owner and do not revive superseded branches.
