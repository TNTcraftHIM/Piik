# Contributing

## Normal Workflow

1. Start from an up-to-date `main` with a clean working tree.
2. Create one short-lived branch for one coherent change. Use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `spike/` followed by a short description.
3. For non-trivial design, implementation, or bug fixing, inspect the repository and research current primary sources before changing code. Record durable findings under `docs/research/`.
4. Implement the smallest complete change. Add tests and concise rationale comments in proportion to risk.
5. Update requirements, ADRs, project memory, status, and operational docs when their source facts changed. Replace stale text instead of appending a diary.
6. Run `sh scripts/check-project-state.sh` on macOS/Linux/Git Bash or `./scripts/check-project-state.ps1` on PowerShell, plus the relevant project tests.
7. Make focused commits using `type(scope): summary` where practical, then push the branch.
8. Open a pull request using the repository template. Resolve review comments and required checks before merging.
9. Prefer squash merge for a single coherent change; preserve separate commits when they carry independently useful history. Delete the merged branch.

Direct commits to `main` are reserved for an explicit user-approved exception. Never force-push shared branches or rewrite shared history without explicit approval.

## Research Standard

- Prefer specifications, official product documentation, primary source code, maintainers' design notes, and original papers.
- Use current community issues and operational reports to identify real compatibility failures, but label anecdotal evidence as such.
- Include a date and direct URLs. Separate verified facts, measurements, assumptions, and recommendations.
- Review licenses before copying implementation code. A useful reference is not automatically a compatible dependency.

## Pull Request Scope

A pull request should explain the problem, the chosen design, verification performed, user-visible or operational effects, and remaining risks. Keep unrelated refactors and generated churn out of the branch.

Changes are not complete when only code is updated. Durable changes must update the relevant documentation and current-memory snapshot in the same pull request.

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
