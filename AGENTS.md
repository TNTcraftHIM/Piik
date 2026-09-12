# Project Instructions

## Authority And Scope

- Read and follow the complete repo-tracked
  [`ponytail` skill](./.agents/skills/ponytail/SKILL.md) before coding, review,
  or design work. It is required guidance for the smallest correct result;
  project authority and delivery constraints remain owned here.
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

- Piik is private screen sharing for one Host and up to 20 authenticated
  Viewers, with Web Host/Viewer/relay as the current product surface.
- Current product truth is split by owner:
  [rooms/access](./docs/product/rooms-access.md),
  [routing/transport](./docs/product/routing-transport.md),
  [media quality](./docs/product/media-quality.md), and
  [presentation/lifecycle](./docs/product/presentation-lifecycle.md).
- Media stays automatic and P2P-first; central services provide room authority,
  signaling, STUN, observability, and bounded embedded SFU/UDP fallback using
  mature LiveKit media components under [ADR-0013](./docs/adr/0013-embedded-node-local-media.md). Route
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
- Use the [documentation owner map](./docs/maintenance.md#owners): product
  behavior, engineering, visual language, versions, evidence and operations each
  have one owner. TODO is the only work ledger; Git/PRs own completed history.
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
- `main` remains low-frequency: one complete, user-accepted phase per squash PR,
  with no intermediate release-record or cleanup commits. Keep implementation
  on worktrees; [CONTRIBUTING.md](./CONTRIBUTING.md#full-integration-and-release-workflow)
  owns the full workflow and explicit emergency exception.
- Preserve user work. Branch, truth-checkpoint, PR, release, recovery, and
  cleanup rules are owned by [CONTRIBUTING.md](./CONTRIBUTING.md); do not mirror
  that workflow here.

## Engineering Defaults

- UI changes must follow the shared [visual language](./docs/design/visual-language.md):
  cast, semantic colours, result panels and motion have one owner. Extend the
  existing preview when adding a new meaning; do not invent scene-local rules.
- Follow [engineering and interface boundaries](./docs/reference/engineering.md):
  simple cohesive modules, clear state/resource owners, mature reuse and narrow
  contracts. After a material module, remove additions that the accepted result
  does not need; total complexity matters more than marginal performance gains.
- [Versioning](./docs/reference/versioning.md) separates build identity, wire,
  storage and live generations, and owns the public compatibility design.
  The declared public release is the compatibility baseline for subsequent work.
- Use primary sources for non-trivial design and bugs. Add focused tests in
  proportion to risk; batch full browser/network/endurance checks at acceptance.
- Keep scripts deterministic, fast, cross-platform and CI-runnable.
- Before finishing material work, inspect status, report untracked artifacts,
  and stage requested files unless told otherwise.
