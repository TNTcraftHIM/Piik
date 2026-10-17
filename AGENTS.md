# Project Instructions

## Aesthetic And Design Standard

Apply these constraints and relevant skills throughout every conversation turn,
feature and action. Piik requires a polished experience and clear engineering:
high aesthetic standards cover UI, interaction, functional boundaries, lifecycle
and code. Working behavior alone is insufficient. Preserve the product's intent,
usability, coherence, maintainability and appropriate extensibility.

Before changing behavior or presentation, establish the intended user flow,
state/resource owner, lifecycle and what would demonstrate a complete result.
Inspect existing components and mature approaches, then choose the simplest
coherent design that meets those needs. Simplicity must not discard requested
functionality, visual quality or necessary safety. Design and verify at the
scale of the change; routine design choices within an authorized task need no
separate design document or approval.
Detailed criteria stay in [visual language](./docs/standards/visual-language.md)
and [engineering](./docs/standards/engineering.md).

## Authority And Scope

- Within higher-priority instructions, the latest explicit user decision defines
  the task. Review, research, implementation, deployment, and cleanup grant only
  the authority inherent in that task type.
- This file owns project-wide constraints; linked standards own domain rules,
  CONTRIBUTING owns delivery, and skills supply task methods. A skill, reference
  example or audit suggestion cannot override those owners or authorize extra work.
- Model recovery from the smallest underlying authority and connection state.
  Restart, crash, timeout, and network loss do not justify parallel states or
  case-specific fallbacks when their required action is the same.
- Ordinary scoped work uses the lean path: inspect the affected owner and code,
  make the smallest coherent change, run focused checks, inspect the diff, and
  stage the requested files. Use the full integration/release path only for an
  explicitly requested release or a material contract, route/security,
  infrastructure, persistence, or irreversible change.

## Required Skills

Read each applicable skill completely before using it. Reuse that understanding
until the task or instructions change; adherence does not require reloading or
reciting every rule each turn. Use the repo-linked versions below when a global
skill has the same name. Other skills apply only to matching tasks or explicit
invocation; follow their relevant guidance without importing unrelated workflows.

| When | Skill and responsibility |
| --- | --- |
| Coding, code review, or implementation design | [Ponytail](./.agents/skills/ponytail/SKILL.md): smallest coherent implementation and reuse |
| Implementation, debugging, or review | [Stop That Shit](./.agents/skills/stop-that-shit/SKILL.md): proportionate investigation, verification and complete delivery |
| Cross-surface consistency, recurring sibling-path defects, or standardization audits | [Context consistency](./.agents/skills/context-consistency/SKILL.md): trace shared meanings and ownership; ordinary changes check only their affected family |

## Product Contract

- Piik is private screen sharing for one Host and up to 20 authenticated
  Viewers, with Web Host/Viewer/relay as the current product surface.
- Current product truth is split by owner:
  [rooms/access](./docs/standards/rooms-access.md),
  [routing/transport](./docs/standards/routing-transport.md),
  [media quality](./docs/standards/media-quality.md), and
  [presentation/lifecycle](./docs/standards/presentation-lifecycle.md).
- Media stays automatic and defaults to P2P-first; central services provide room authority,
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
- Use the [standards index](./docs/standards/README.md) and
  [documentation owner map](./docs/standards/documentation.md#owners): product
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

- Repeated meanings across code, UI, copy, configuration and lifecycle follow
  one owned [contextual contract](./docs/standards/engineering.md#contextual-consistency).
  Check related producers and consumers before adding another local rule;
  preserve differences justified by authority, scope or user intent.
- UI changes must follow the shared [visual language](./docs/standards/visual-language.md):
  cast, semantic colours, result panels and motion have one owner. Extend the
  existing preview when adding a new meaning; do not invent scene-local rules.
- Follow [engineering and interface boundaries](./docs/standards/engineering.md):
  simple cohesive modules, clear state/resource owners, mature reuse and narrow
  contracts. After a material module, remove additions that the accepted result
  does not need; total complexity matters more than marginal performance gains.
- [Versioning](./docs/standards/versioning.md) separates build identity, wire,
  storage and live generations, and owns the public compatibility design.
  Preserve published compatibility promises; remove replaced private experiments
  without aliases, dual readers/writers or migrations for stale private clients.
- Use primary sources for non-trivial design and bugs. Add focused tests in
  proportion to risk; batch full browser/network/endurance checks at acceptance.
- Keep scripts deterministic, fast, cross-platform and CI-runnable.
- Before finishing material work, inspect status, report untracked artifacts,
  and stage requested files unless told otherwise.
