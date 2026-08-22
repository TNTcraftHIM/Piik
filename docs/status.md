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

## Current Milestone

1. Merge the accepted route truth across requirements, design, ADR, memory, status, and [the TODO ledger](./todo.md).
2. Rebuild the cap/accounting runtime from exact canonical `main`, preserving safe identity, media-proof, and rollback behavior.
3. Validate cap `1/2/3`, child and parent quality ownership, constrained Host/SFU/TURN paths, bounded resources, and rollback before deployment.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Real SFU/TURN recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Next Stop

Complete the truth merge and canonical-workspace cleanup first. Runtime changes and
remaining TODOs start only from the resulting clean `main`.
