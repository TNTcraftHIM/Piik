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
- The accepted endpoint direction is one ordinary downstream cap for every non-server endpoint: default `2`, static `1/2/3`, upstream receive free, and no Browser/UA/visibility tier.
- Automatic P2P-first routing, one active upstream, an acyclic graph, exact identity/generation authority, media-proven make-before-break, and bounded failure remain accepted.
- SFU/TURN placement and accounting are not yet accepted as a complete model. No routing runtime candidate may be merged or deployed until that model is reconciled and written to the owning truth.

## Current Milestone

1. Converge active constraints, requirements, design, ADR, memory, status, and [the TODO ledger](./todo.md) without retaining obsolete-policy commentary.
2. Report the concrete done/obsolete/decision-needed/unfinished classification and organized workspace state to the user, then stop.
3. After confirmation, write one holistic routing proposal and stop again for route-semantics confirmation.
4. Only then update and merge accepted route truth, rebuild the cap/accounting implementation from exact canonical `main`, validate, review, and deploy.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Real SFU/TURN recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Next Stop

Wait for the user's review of this convergence before starting route modeling, another TODO, candidate integration, cleanup, or deployment.
