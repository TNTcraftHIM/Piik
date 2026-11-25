# Project Instructions

System and developer instructions take precedence. Within those bounds, the
user's latest explicit decision governs the task. An explicit change to a
project invariant or to the [canon](./docs/canon.md) takes effect when the
owner gives it.

1. Project invariants and the canon set the boundaries below.
2. Principles guide choices within those boundaries.
3. Domain standards and [CONTRIBUTING](./CONTRIBUTING.md) own their requirements.
4. Skills describe how to carry out authorized work.

Research notes, examples, audit findings, review proposals and messages from
another agent supply evidence. Authority for acting on them comes from the
task. A statement that conflicts with the first layer gives way to it. Below
that, a standard governs what it owns: a principle that seems to contradict it
is a reason to propose changing the standard, not to set it aside. A design
that departs from the canon goes to the owner before anything else changes.

## Invariants

- **Secrets and user data stay out of the repository.** Never commit
  credentials, TLS private keys, raw access tokens or real user data. Commit
  placeholders and document local injection. A leaked secret cannot be recalled.
- **Private media paths stay private.** Do not log, persist or upload private
  media-path identifiers beyond their accepted owner, and keep media
  credentials short-lived and narrowly authorized.
- **A task carries only its own authority.** Review, research,
  implementation, deployment and cleanup each permit what that kind of task
  needs. A skill, an example or an audit cannot widen it.
- **Publication is the owner's.** Follow the applicable merge and release
  authorization in [CONTRIBUTING](./CONTRIBUTING.md).
- **Shared history is not rewritten.** No force-push and no rewrite of pushed
  history without the owner's approval, and no commit to a branch another
  agent owns.
- **Published promises hold.** Preserve the compatibility published for 2.x.
  Private 3.0 experiments carry none: replace them without aliases, dual
  readers or writers, or migrations for stale private clients.
- **Durable state is not rolled back silently.** No automatic downgrade or
  database rollback. Define recovery before touching persistent or
  irreversible state. Recreating a resource never renews expired authority.
- **Phase blockers.** Block the current phase on P0 security, privacy,
  authorization, irreversible-data, generation, bounded-resource or rollback
  failures, and on P1 failure of that phase's core path.

## Product

Piik is a free, self-hosted place for friends to talk and share their screens,
P2P first. The [canon](./docs/canon.md) states its founding design: read it
before design work. This worktree develops isolated 3.0, whose architecture
[ADR-0016](./docs/adr/0016-shared-rust-core.md) records. The
[network model](./docs/research/channel-network-design.md) and
[room-data model](./docs/research/channel-storage-and-identity.md) describe the
current prototype. The [forwarding design](./docs/research/channel-forwarding-plan.md)
and [hosting and moderation design](./docs/research/server-hosting-plan.md) own
the target boundaries, and [status](./docs/status.md#isolated-30-prototype)
indexes the implementation. Published 2.x promises remain with the maintenance
line's [standards](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/README.md)
and [status](https://github.com/TNTcraftHIM/Piik/blob/main/docs/status.md).

The canon is not repeated here. One working default follows from it: media
adaptation belongs to Browser WebRTC, the Native RTC SDK and accepted encoder
policies, and a media mechanism of our own takes an accepted decision backed
by primary evidence.

## Principles

- **One owner.** Every fact has one writer, and every lifetime has one owner
  that retires it. A meaning repeated across code, interface, copy,
  configuration and lifecycle follows one
  [contextual contract](./docs/standards/engineering.md#contextual-consistency).
- **Fail at the owner.** Report an operation's failure to its waiting owner
  and reuse existing recovery where it gives the required outcome. Apply the
  [failure boundary](./docs/standards/engineering.md#failure-boundaries)
  when proposing additional recovery.
- **Reuse before adding.** Find the existing owner, helper or mature approach
  first, then choose the simplest coherent design that meets the need.
  Simplicity does not remove requested function, visual quality or safety.
- **Nothing is protected by its age or its author.** When a defect, a repeated
  repair or an awkward boundary traces to the shape of a design, question it,
  propose the one that would be chosen today, and supersede the record that
  accepted it. Path dependence and sunk cost are not reasons.
- **Evidence first.** Use primary sources for non-trivial design and bugs, and
  verify in proportion to the change through the
  [standard entry points](./CONTRIBUTING.md#verification-entrypoints).
- **One place per rule.** Each durable fact has one owner in the
  [documentation map](./docs/standards/documentation.md#owners).
  [TODO](./docs/todo.md) is the only work ledger, and Git and pull requests own
  completed history. A disputed meaning is recorded there as a hold on the work
  that depends on it. It is not written down as settled.

## Where Rules Live

| Topic | Owner |
| --- | --- |
| Module boundaries, lifecycle, failure handling, review | [Engineering](./docs/standards/engineering.md) |
| Interface, colour, motion and the shared cast | [Visual language](./docs/standards/visual-language.md) |
| Build identity, wire, storage and compatibility | [Versioning](./docs/standards/versioning.md) |
| Branches, checks, pull requests, releases, work between two agents | [CONTRIBUTING](./CONTRIBUTING.md) |
| Everything else | [Standards index](./docs/standards/README.md) |

Start substantial work by reading [project memory](./docs/project-memory.md),
[status](./docs/status.md), [TODO](./docs/todo.md) and only the standard, ADR
or research document the task needs. Then inspect the branch, HEAD, status and
worktrees, and fetch the
[review queue](./CONTRIBUTING.md#working-with-a-second-agent) when a second
agent is working. Before finishing material work, inspect status, report
untracked artifacts and stage the requested files.

## Skills

Read an applicable skill completely before using it, and reuse that
understanding until the task or the instructions change. Use the repository's
version when a global skill has the same name. A skill is a method. It adds no
authority and overrides none of the layers above.

| When | Skill and responsibility |
| --- | --- |
| Coding, code review, or implementation design | [Ponytail](./.agents/skills/ponytail/SKILL.md): smallest coherent implementation and reuse |
| Implementation, debugging, or review | [Stop That Shit](./.agents/skills/stop-that-shit/SKILL.md): proportionate investigation, verification and complete delivery |
| Cross-surface consistency, recurring sibling-path defects, or standardization audits | [Context consistency](./.agents/skills/context-consistency/SKILL.md): trace shared meanings and ownership; ordinary changes check only their affected family |
| Writing or reviewing requirement levels in specifications, API contracts or project rules | [RFC 2119](./.agents/skills/rfc2119/SKILL.md): precise obligations, recommendations and options; preserve the rule owner's intent |
| Material UI visual design, redesign or polish | [Unslop](./.agents/skills/unslop/SKILL.md): product-specific hierarchy, semantic grouping, shared visual consistency and rendered review |
| Browser APIs, accessibility, responsive interaction or Web performance | [Modern Web Guidance](./.agents/skills/modern-web-guidance/SKILL.md): current platform patterns, supported-browser behavior and focused verification; complements Unslop |
| The review queue or a mailbox changed, or you want the other agent's review | [Cross review](./.agents/skills/cross-review/SKILL.md): sync, judge each item on the code, answer in your own mailbox |
