# Session Handoff

Last updated: 2026-08-25

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
  only by the dedicated LiveKit SFU/UDP fallback. Browser SFU publisher and
  subscriber PCs explicitly use no external ICE server and check the dedicated
  public SFU candidate directly; ordinary peers and LiveKit server-side public
  IP discovery retain deployment STUN. Production exact deployed
  application/runtime revision `bf328590b3de5dfa509fcc70f6316286af3eae7e`,
  release `bf32859`, uses strict `screener-v12` and includes exact Browser SFU
  ICE-server-isolation implementation
  `ae09c760adec76fd26da611d4928486d105c6d3b`. Owner physical SFU fallback proof
  remains bounded to predecessor release `c4962f5`. The route uses one short-lived
  exact-generation decoded-frame observer only for the pending candidate inside
  the existing total deadline; the periodic stats sampler still owns active-path
  diagnostics and stalls. Broader external-network and SFU lifecycle evidence
  remains open. Do not run executable/native suites unless their later acceptance
  boundary specifically requires them.
- ADR-0002 owns the room model. Current source and production use strict v12 with
  exactly `open | private` code entry and the room-lived 22-character Viewer
  grant. Neither source nor production uses SQLite; exact release operations and
  change-scoped infrastructure recovery are owned by deployment.
- Browser display video must leave `contentHint` unset; audio keeps `music`.
  Browser video is fixed VP8 across direct, browser-relay, and SFU paths; strict
  v12 source and production have no codec UI/state/wire or fallback media codec.
  Automated source gates and the exact deployment postflight passed. Chrome 151
  physically verified direct/browser-relay/SFU screen-audio continuity and all
  three sender ceilings. An exact-production VP8 gate sustained about 59.5 fps
  on direct and Browser-relay paths and rejected the current SFU `q,h`
  publication because active `LOW` reduced `HIGH`. ADR-0007 accepts one Browser
  SFU `HIGH`; current source implements that single representation, while
  production remains `q,h` until the next application cutover and physical gate.
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
