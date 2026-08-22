# Project Memory

Last updated: 2026-08-22

## Current Product Truth

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends. Public or large broadcasts belong on OBS/Twitch-class services.
- Web is the current delivery target. Viewers join from desktop or mobile browsers; a packaged or native sender is a later optimization.
- Keep routing automatic and media distributed. Direct/peer UDP is preferred; centralized media is fallback infrastructure, not the default topology.
- Every non-server endpoint uses one server-authoritative ordinary downstream capacity: default `2`, statically configurable as `1`, `2`, or `3`. Upstream receive is free, Browser role/UA/visibility does not create a separate tier, and clients cannot raise the deployment value.
- The stable routing invariants are one authoritative upstream per Viewer, an acyclic active graph, exact room/session/share/revision/generation authorization, media-proven make-before-break, and bounded success or failure.
- SFU publication/subscription, selected TURN, fallback ordering, temporary overlap, and server-resource accounting must be decided as one route model before routing code changes. No older constant, experiment, or branch is authority for that decision.
- Ordinary peer ICE is STUN-only. Credentials, room secrets, candidate details, and diagnostic data remain private and narrowly scoped.
- Screen audio offers 64/128/256 kbps sender ceilings, defaults to 128, and locks the choice during a share. These are configuration ceilings, not fidelity claims.
- Current UI, presence, route labels, and diagnostics describe observed state only; they do not create route authority.

## Current Source And Production

- Canonical source is the clean `main` branch. New branches and worktrees start from its exact current commit after accepted truth is merged.
- Production runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- Production still enforces Host downstream `2`, ordinary Browser downstream `1`, deployment values `1/2`, a fixed SFU-root limit of `2`, and legacy publication/selected accounting. This is a dated implementation divergence, not current product policy.
- Production has automatic routing, bad-relay corroboration, peer-quality make-before-break with Viewer and Host provisional parents, selected-edge transport, stable route/connection details, 64/128/256 audio choices, access controls, self-check, diagnostic export, and signaling watchdog behavior.
- `screener`, LiveKit, coturn, and nginx are healthy; local and public health return 200 and `screener` has `NRestarts=0`. Deployment detail is owned by [deployment](./deployment.md).
- Chrome loopback, cap2/cap3, short resource, recovery, MBB, and A/V fixtures are bounded evidence only. They do not establish quality, resource limits, or product policy.

## Current Priority

1. Keep this truth set and [the TODO ledger](./todo.md) concise and internally consistent.
2. Report the converged facts and TODO classification to the user and stop for confirmation.
3. After confirmation, produce one holistic routing model covering topology, transport, fallback, capacity, resource admission, and recovery; do not implement it yet.
4. After route-semantics confirmation, update the owning requirement/design/ADR and merge that truth into canonical `main`.
5. Rebuild only approved runtime changes from that exact `main`, validate cap `1/2/3` and route recovery, independently review, then deploy with rollback evidence.

## Working Rules

- Discussion and evidence are inputs, not executable TODOs. Accepted semantics are written to their owners before implementation.
- Current documents state the current model directly. Rejected alternatives and removal narratives are deleted; Git history owns them.
- Old branches may contribute scoped code or evidence only after reconciliation. Their memory, requirements, ADRs, status, and deployment snapshots never overwrite newer mainline truth.
- Preserve dirty, unique, open-stack, and evidence worktrees until their disposition is explicitly decided. Workspace counts are sampled on demand rather than stored here.

## Source Map

- Current execution: [status](./status.md)
- Executable and held work: [TODO ledger](./todo.md)
- Requirements and design: [requirements](./%E9%9C%80%E6%B1%82%E7%90%86%E8%A7%A3.md), [design](./%E6%96%B9%E6%A1%88%E8%AE%BE%E8%AE%A1.md), and [ADRs](./adr/)
- Evidence and limits: [research](./research/) and [verification status](./verification-status.md)
- Operations: [deployment](./deployment.md), [maintenance](./maintenance.md), and [contributing](../CONTRIBUTING.md)
