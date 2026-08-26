# Session Handoff

Last updated: 2026-08-25

This file is only a bootstrap pointer. Product truth lives in the linked owners.

## Resume Prompt

```text
Continue Screener from the canonical repository root:
C:\Users\TNTcraft\Documents\GitHub\Screener

Read AGENTS.md and the complete repo-tracked stop-that-shit skill first. Then
read CONTRIBUTING.md, docs/project-memory.md, docs/status.md, docs/todo.md, the
relevant requirement/design/ADR/research owner, and inspect branch/HEAD, status,
staged diff, and worktrees. Canonical main and repo truth override old branches,
worktrees, handoffs, agent memory, and chat summaries.

Current production and main identity is owned by docs/status.md. ADR-0002 owns
lightweight/stable room authority; ADR-0005 owns automatic direct/peer-to-LiveKit routing; ADR-0007
owns framework media adaptation. Current routes are sticky and quality evidence
is diagnostic only. Browser video uses the share-scoped H.264/VP8 decision with
contentHint=motion; LiveKit owns SFU representations; Screener configures no TURN
or media TCP.

Follow docs/todo.md in order. Do not run Native/executable work, broad repository
cleanup, quality-driven reparenting, or another transport unless its decision
boundary is explicitly opened. Preserve unique or dirty worktrees until merged-
head, reference, and reparse audits prove cleanup safe.
```
