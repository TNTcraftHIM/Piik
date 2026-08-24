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
  only by the dedicated LiveKit SFU/UDP fallback. Current Browser v9 source
  checkpoint `d543f38aacad3df5ef65fde1055cc8e733972afe` and production v8 release
  `8f5b3f1` implement that two-stage model. Current source uses one short-lived
  exact-generation decoded-frame observer only for the pending candidate inside
  the existing total deadline; the periodic stats sampler still owns active-path
  diagnostics and stalls. Real external-network and SFU media evidence remains
  open. Do not run executable/native suites unless their later acceptance
  boundary specifically requires them.
- ADR-0002 owns the implemented room model: one process-memory RoomStore,
  random free four-digit codes, configurable 24-hour dormant leases, restart
  loss, local Host preference replay, an independent expiring Viewer grant, and
  open/password/disabled code entry. Current source uses the single
  `screener-v9` wire, production uses the single `screener-v8` wire, and neither
  runtime uses SQLite; exact rollback artifacts are owned by deployment.
- Exact source `d543f38aacad3df5ef65fde1055cc8e733972afe` implements the atomic Browser
  v9 batch: live audio-ceiling mutation, paused codec switching with exact Resume
  source authority and proof, typed Viewer presentation, Host-on-demand route
  diagnostics, neutral room-code denial, responsive entry controls, default
  `1080p30`, and advanced-only `854x480`. It passed 670 Web tests in 48 files,
  typecheck, client/server builds, access/privacy, dependency audit, and
  repository hygiene. Its exact 20-Viewer Chrome run passed on
  direct loopback with no SFU publication, so it is not SFU or public-network
  evidence.
- Production remains exact `8f5b3f192ddd010ca01c969008e512191312736a`,
  release `8f5b3f1`, wire `screener-v8`. Do not report v9 as deployed until one
  atomic cutover and postflight prove the exact release.
- Ordinary browser ICE owns direct reachability. Do not build port prediction,
  guessed candidates, NAT classification, TCP probes, quality scores, or
  quality-driven reparenting. Current-path quality is diagnostic; a healthy
  decoded edge remains sticky.
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

Current TODO priority is the atomic v9 deployment, then physical codec and audio
validation, controlled H.264 and Host-background diagnosis, and representative
direct/peer-relay/SFU network acceptance. Mobile lifecycle, distribution/native
packages, retained product decisions, and the read-only simplification audit stay
at their later boundaries.

Follow the current ledger in order and report each verified integration,
deployment, and physical-evidence boundary without reviving stale agent or branch
facts.
```
