# Session Handoff

Last updated: 2026-08-23

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
- ADR-0005 owns the accepted automatic route model. The Browser `screener-v7`
  source is implemented and deployed as release `6b87732`; real external-network
  and SFU/TURN media evidence remains open. Do not rerun broad or
  executable/native test suites unless the current acceptance boundary
  specifically requires them.
- ADR-0002 owns the newly accepted room model: one process-memory RoomStore,
  random free four-digit codes, configurable 24-hour dormant leases, restart
  loss, local Host preference replay, an independent expiring Viewer grant, and
  open/password/disabled code entry. SQLite removal and the new access/UI model
  are documented but not implemented or deployed.
- docs/maintenance.md owns the reusable mechanism-simplification review. SQLite
  is its reference case because the bounded restart-experience loss did not
  justify the persistence surface; accepting that tradeoff changed the contract,
  rather than a prior contract change causing the removal. The later repository
  audit in TODO is not permission for broad cleanup during this handoff.
- The canonical root/main checkpoint reconciles the route truth audit with this
  room decision. Use that coherent truth as the base; do not replace it with
  older documents from another worktree.
- Existing auxiliary worktrees and branches are retained candidates or audit
  material. Do not merge or delete them until their unique changes, references,
  and reparse/junction safety are checked against current main.

First report back with: current branch/HEAD, dirty-file scope, accepted versus
implemented versus deployed room/route state, and the next authorized TODO. Then
follow the latest owner instruction without reviving stale agent or branch facts.
```
