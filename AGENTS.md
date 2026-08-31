# Project Instructions

## Authority And Scope

- Read and follow the complete repo-tracked
  [`stop-that-shit` skill](./.agents/skills/stop-that-shit/SKILL.md) before work.
  It is the generic authority for scope, smallest-correct-result, and clean
  delivery; installed copies must remain synchronized with it.
- Within higher-priority instructions, the latest explicit user decision defines
  the task. Review, research, implementation, deployment, and cleanup grant only
  the authority inherent in that task type.
- Model recovery from the smallest underlying authority and connection state.
  Restart, crash, timeout, and network loss do not justify parallel states or
  case-specific fallbacks when their required action is the same.
- Ordinary scoped work uses the lean path: inspect the affected owner and code,
  make the smallest coherent change, run focused checks, inspect the diff, and
  stage the requested files. Use the full integration/release path only for an
  explicitly requested release or a material contract, route/security,
  infrastructure, persistence, or irreversible change.
- Until a public release is explicitly declared, keep one current internal
  contract. Delete replaced wire/config/API surfaces; do not add compatibility
  aliases, dual readers/writers, migrations, or tests for stale private clients.

## Product Contract

- Screener is private game screen sharing for one Host and up to 20 authenticated
  Viewers, with Web Host/Viewer/relay as the current product surface.
- Current product truth is split by owner:
  [rooms/access](./docs/product/rooms-access.md),
  [routing/transport](./docs/product/routing-transport.md),
  [media quality](./docs/product/media-quality.md), and
  [presentation/lifecycle](./docs/product/presentation-lifecycle.md).
- Media stays automatic and P2P-first; central services provide room authority,
  signaling, STUN, observability, and bounded LiveKit SFU/UDP fallback. Route
  changes must preserve the single-graph, single-operation model in
  [ADR-0005](./docs/adr/0005-automatic-hybrid-media-routing.md).
- WebRTC and LiveKit own network and media adaptation. Do not add custom quality
  scores, ladders, all-pairs probes, periodic rebalancing, or hand-built SFU
  representations without a new accepted decision backed by primary evidence.

## Durable Truth

- Start substantial work by reading [project memory](./docs/project-memory.md),
  [status](./docs/status.md), [TODO](./docs/todo.md), and only the relevant
  product module, ADR, research, or operations document. Then inspect branch,
  HEAD, status, staged diff, and worktrees.
- Product modules own current behavior; ADRs own non-obvious decisions and
  consequences; research owns evidence and license boundaries; deployment owns
  operational reference. Status is the current execution/deployment index, TODO
  is the only work ledger, and Git/PRs own completed history.
- Give every durable fact one owner. Update memory or status only when its compact
  snapshot materially changes. Ordinary UI detail, protocol field listings,
  self-evident code, test inventories, routine validation, and agent process do
  not belong in long-lived product truth.
- If semantics remain disputed, record the hold in TODO and freeze only dependent
  work. Never encode a guess as accepted truth.

## Safety

- Never commit credentials, TLS private keys, raw access tokens, or real user
  data. Commit placeholders and document local secret injection.
- Keep media credentials short-lived and narrowly authorized. Do not log or
  persist private media-path identifiers beyond their accepted owner.
- Block the current phase on P0 security, privacy, authorization, irreversible-
  data, generation, bounded-resource, or rollback failure, and on P1 failure of
  that phase's core path.

## Repository And Delivery

- Canonical root must be clean current `main` at audit/integration boundaries.
  Create branches/worktrees from that exact commit; old branches and worktrees
  are never truth sources.
- Preserve user work. Branch, truth-checkpoint, PR, release, recovery, and
  cleanup rules are owned by [CONTRIBUTING.md](./CONTRIBUTING.md); do not mirror
  that workflow here.

## Engineering Defaults

- Judge a change by evidenced user value against its full implementation,
  maintenance, compatibility, and failure cost. A large measured gain may
  justify broad or breaking work; a small or speculative gain does not justify
  material complexity or risk.
- Use primary sources for non-trivial design and bugs. Add focused tests in
  proportion to risk; batch full browser/network/endurance checks at acceptance.
- Keep scripts deterministic, fast, cross-platform, and CI-runnable. Support
  Windows, macOS, and Linux; use LF and ASCII filenames for new files.
- Before finishing material work, inspect status, report untracked artifacts,
  and stage requested files unless told otherwise.
