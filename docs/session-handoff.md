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
  only by the dedicated LiveKit SFU/UDP fallback. Exact Browser runtime
  `39fcf93bae057fcbb1002702c3be6b90bac9027f` is integrated and deployed as
  release `39fcf93` on the single `screener-v9` wire. It uses one short-lived
  exact-generation decoded-frame observer only for the pending candidate inside
  the existing total deadline; the periodic stats sampler still owns active-path
  diagnostics and stalls. Real external-network and SFU media evidence remains
  open. Do not run executable/native suites unless their later acceptance
  boundary specifically requires them.
- ADR-0002 owns the implemented room model: one process-memory RoomStore,
  random free four-digit codes, configurable 24-hour dormant leases, restart
  loss, local Host preference replay, an independent expiring Viewer grant, and
  open/password/disabled code entry. Current source and production use the
  single `screener-v9` wire and neither runtime uses SQLite; exact rollback
  artifacts are owned by deployment.
- Exact runtime source `d543f38aacad3df5ef65fde1055cc8e733972afe`, integrated
  without runtime changes by main `39fcf93bae057fcbb1002702c3be6b90bac9027f`, implements the Browser
  v9 batch: live audio-ceiling mutation, paused codec switching with exact Resume
  source authority and proof, typed Viewer presentation, Host-on-demand route
  diagnostics, neutral room-code denial, responsive entry controls, default
  `1080p30`, and advanced-only `854x480`. It passed 670 Web tests in 48 files,
  typecheck, client/server builds, access/privacy, dependency audit, and
  repository hygiene. Its exact 20-Viewer Chrome run passed on
  direct loopback with no SFU publication, so it is not SFU or public-network
  evidence.
- Production runs exact `39fcf93bae057fcbb1002702c3be6b90bac9027f`, release
  `39fcf93`, wire `screener-v9`. The immutable runtime ZIP SHA-256 is
  `28190c3a69ec937d39ab5d49fdbc8db6a07e6013c2ddd5f5590bf8249bf6bce6`;
  `/opt/screener/backups/39fcf93-pre-v9-20260824T004257Z` is the verified
  rollback boundary and its `SHA256SUMS` hash is
  `1f741f29022f5eb1eb311a24f87f5f48598dca7b1879b88f9033c331fa06bd37`.
  Postflight proved service health, exact public assets, v9/no-v8, release
  ownership/inode isolation, socket/firewall continuity, and rollback checksum
  without creating a media room; physical route/media evidence remains open.
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

The accepted codec contract now defaults new shares to VP8, keeps the codec
selector pre-share only, fixes the preference for the lifetime of a share, and
uses ordinary `shareGeneration`-fenced Pause/Resume. Current source and production
still run the v9 codec transaction described above. The next Browser cutover must
delete that transaction and its messages, use one new wire version, and reject v9
without compatibility aliases before this simplification is reported as implemented
or deployed.

Current TODO priority is that codec simplification and atomic deployment, followed
by physical audio validation, controlled Host-background diagnosis, and representative
direct/peer-relay/SFU network acceptance. H.264 diagnosis/default reconsideration,
mobile lifecycle, distribution/native packages, retained product decisions, and the
read-only simplification audit stay at their later boundaries.

Follow the current ledger in order and report each verified physical-evidence
boundary without reviving stale agent or branch facts.
```
