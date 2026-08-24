# Session Handoff

Last updated: 2026-08-24

This file is a bootstrap prompt, not a product-truth owner. The linked documents
replace any duplicated or conflicting statement here. Update or remove this file
after the handoff boundary changes.

## Prompt

```text
Continue the Screener project from the canonical repository root:
C:\Users\TNTcraft\Documents\GitHub\Screener

Before changing code, deployment, branches, worktrees, or TODO state:

1. Read the root AGENTS.md instructions supplied for this repository, then read
   CONTRIBUTING.md, docs/project-memory.md, docs/status.md, docs/todo.md,
   docs/需求理解.md, docs/方案设计.md, docs/maintenance.md, and the relevant
   ADR/research owner.
2. Inspect git status, current branch/HEAD, worktree list, and the diff. Preserve
   every pre-existing edit. The canonical root/main owns truth; auxiliary
   worktrees, branches, agent memories, chat summaries, and old TODOs do not.
3. Distinguish accepted product truth, current source, and current production.
   Do not report an accepted design as implemented or deployed.
4. Resolve meaning and update all affected truth owners before implementation.
   Keep the model simple, use existing framework behavior, avoid case-by-case
   patches, and do not add compatibility for unpublished internal releases.

Current high-signal boundary:

- docs/status.md owns the exact source/production/hold state.
- docs/todo.md is the only executable work ledger and owns ordering.
- ADR-0005 owns the accepted automatic route model: direct/STUN peer followed
  only by the dedicated LiveKit SFU/UDP fallback. Production exact deployed
  application/runtime revision `679fe3e7af634309322bea83b316641f51ad3d09`,
  release `679fe3e`, uses strict `screener-v11`; canonical `main` contains the
  same v11 runtime code. The route uses one short-lived
  exact-generation decoded-frame observer only for the pending candidate inside
  the existing total deadline; the periodic stats sampler still owns active-path
  diagnostics and stalls. Real external-network and SFU media evidence remains
  open. Do not run executable/native suites unless their later acceptance
  boundary specifically requires them.
- ADR-0002 owns the implemented room model: one process-memory RoomStore,
  random free four-digit codes, configurable 24-hour dormant leases, restart
  loss, local Host preference replay, an independent expiring Viewer grant, and
  open/password/disabled code entry. Neither source nor production uses SQLite;
  exact release operations and change-scoped infrastructure recovery are owned
  by deployment. Routine application-only releases do not maintain a full
  rollback/configuration backup.
- Browser display video must leave `contentHint` unset; audio keeps `music`.
  Browser video is fixed VP8 across direct, browser-relay, and SFU paths; the
  current strict v11 source and production have no codec UI/state/wire or
  fallback media codec. Automated source gates and deployment postflight passed,
  but no physical direct, browser-relay, or SFU codec path has been verified.
- Ordinary browser ICE owns direct reachability. Do not build port prediction,
  guessed candidates, NAT classification, TCP probes, quality scores, or
  quality-driven reparenting. Current-path quality is diagnostic; a healthy
  decoded edge remains sticky.
- docs/maintenance.md owns the reusable mechanism-simplification review;
  ADR-0002 owns the accepted memory-room tradeoff. The later repository audit in
  TODO is not permission for broad cleanup during this handoff.
- The canonical root/main checkpoint reconciles the route truth audit with this
  room decision. Use that coherent truth as the base; do not replace it with
  older documents from another worktree.
- Existing auxiliary worktrees and branches are retained candidates or audit
  material. Do not merge or delete them until their unique changes, references,
  and reparse/junction safety are checked against current main.

Follow the current ledger in order and report each verified physical-evidence
boundary without reviving stale agent or branch facts.
```
