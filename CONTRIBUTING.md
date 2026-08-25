# Contributing

## Lean Workflow

This is the default for an ordinary scoped implementation or bug fix.

1. Start from the canonical repository root on a clean, current `main`; preserve unrelated user work.
2. Inspect the affected code, current owner, and reachable evidence. Research primary sources only when the issue is non-trivial or component behavior is uncertain.
3. Make the smallest coherent change under the repo-tracked [`stop-that-shit` skill](./.agents/skills/stop-that-shit/SKILL.md).
4. Run the focused tests or checks that exercise the changed behavior, inspect the pending diff, stage requested files, and report the result and evidence.

Do not automatically create a truth checkpoint, edit status/memory, run `npm run check`, request independent reviews, open or merge a pull request, deploy, or clean branches/worktrees for every small change. Do not record ordinary UI details, self-evident implementation, one-off fixes, routine test output, or completed history in long-lived truth documents.

## Full Integration And Release Workflow

Use this path only when the owner explicitly requests it or when closing a major phase or changing a public contract, route/security model, infrastructure, persistent/irreversible state, or release boundary.

1. Create one short-lived branch/worktree from exact canonical `main`; use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `spike/` followed by a short description.
2. Update only the single durable owner for changed semantics and any materially changed current snapshot. If semantics remain disputed, record a hold and stop dependent work.
3. Implement and run repository hygiene, `npm run check`, the relevant browser/network gates, and review in proportion to the whole acceptance boundary.
4. Merge an accepted truth checkpoint before dependent candidates. Rebase or rebuild a retained candidate from that exact `main` once, preserving main's owning truth on conflicts and transplanting only approved scoped code, tests, and new facts.
5. Open the pull request, resolve required review/checks, merge, deploy when authorized, perform scoped postflight, then audit references and reparse safety before cleanup.

Prefer squash merge for one coherent change and preserve separate commits only when they carry independently useful history.

Direct commits to `main` are reserved for an explicit user-approved exception. Never force-push shared branches or rewrite shared history without explicit approval.

For deployment work, a routine application-only release verifies a new immutable artifact, switches to it atomically, and guarantees the pre-cutover application release only through bounded health and postflight checks; it has no retention contract afterward and is not a maintained backup. Define recovery only for the infrastructure, configuration, secrets, persistent state, or irreversible surfaces the task actually touches, before changing them.

Clean up worktrees and branches only after semantic review and integration are complete and the normal merged-head, open-reference, clean-tree, and non-following link checks pass. Never merge an old branch wholesale after a newer truth checkpoint.

## Research Standard

- Prefer specifications, official product documentation, primary source code, maintainers' design notes, and original papers.
- Use current community issues and operational reports to identify real compatibility failures, but label anecdotal evidence as such.
- Include a date and direct URLs. Separate verified facts, measurements, assumptions, and recommendations.
- Review licenses before copying implementation code. A useful reference is not automatically a compatible dependency.
- Until the project license and distribution model are decided, treat GPL/AGPL implementation sources as study-only.

## Pull Request Scope

A pull request should explain the problem, the chosen design, verification performed, user-visible or operational effects, and remaining risks.

Durable semantic or current-snapshot changes must update their single owner in the same integration boundary. Ordinary implementation and bug fixes may be complete with code plus focused evidence.

## Local Hooks

Install the tracked Git hooks once per clone:

```sh
sh scripts/install-hooks.sh
```

On native PowerShell, this equivalent is available:

```powershell
./scripts/install-hooks.ps1
```

The pre-commit hook runs the POSIX repository hygiene check. The PowerShell entry implements the same checks for native Windows use, and CI runs the POSIX entry. Both read the tracked path manifest in `scripts/required-project-paths.txt`; changes to checker behavior must update and verify both in the same pull request.
