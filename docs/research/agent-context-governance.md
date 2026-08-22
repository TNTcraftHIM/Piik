# Agent Context And Repository Governance

- Reviewed: 2026-08-22
- Scope: official Codex, Claude Code, Hermes Agent, and GitHub guidance
- Status: adopted repository-maintenance evidence

## Findings

### Codex

OpenAI recommends giving Codex a map rather than a large instruction manual.
Its own agent-first repository keeps a short root `AGENTS.md` that points to a
structured documentation tree. OpenAI reports that giant instruction files
crowd out task context, become hard to verify, and accumulate stale rules. Codex
works best when the repository also provides reliable tests, clear documentation,
and project-specific navigation and commands.

Sources:

- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Introducing Codex](https://openai.com/index/introducing-codex/)

### Claude Code

Anthropic recommends specific, concise project instructions. Facts needed for
every session belong in the root memory file; multi-step procedures and
path-specific rules belong in skills or scoped rule files. The official guide
suggests keeping `CLAUDE.md` below 200 lines and periodically removing stale or
conflicting instructions. It also supports importing an existing `AGENTS.md`
instead of maintaining a second copy.

Source: [Claude Code memory](https://code.claude.com/docs/en/memory)

### Hermes Agent

Hermes separates project conventions in `AGENTS.md` from user memory,
personality, and other persistent state. Its project instructions are discovered
progressively, so nested files can own narrower rules without loading every
detail at repository startup.

Source: [Which File Does What?](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/which-file-does-what.md)

### GitHub

Git history and pull requests are the durable record for completed work. Current
documents should not duplicate a release diary or preserve rejected alternatives
solely for history.

Source: [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)

## Adopted Shape

- Root `AGENTS.md` targets roughly 50 lines and contains only cross-task hard
  constraints, product contract, truth navigation, and essential safety rules.
- `CONTRIBUTING.md` owns branch, research, validation, PR, merge, and cleanup
  procedures.
- Project memory and status are short current snapshots; `docs/todo.md` is the
  only current work ledger; requirements, design, ADRs, and research own detail.
- Rejected alternatives and explanations of their removal leave current truth.
  Git owns that history.
- Hooks verify required tracked files, links, size budgets, and deterministic
  repository hygiene. They do not replace semantic review.

This structure is intentionally below the published size ceilings. A ceiling is
not a target: additional top-level text must be necessary on every task or move
to its closest owner.
