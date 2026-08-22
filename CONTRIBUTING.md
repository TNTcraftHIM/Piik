# Contributing

## Normal Workflow

1. Start from the canonical repository root on an up-to-date `main` with a clean working tree. Do not keep `main` checked out in an auxiliary worktree; preserve any overlapping user changes explicitly before restoring the canonical root.
2. Create one short-lived branch for one coherent change. Use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `spike/` followed by a short description.
3. For non-trivial design, implementation, or bug fixing, inspect the repository and research current primary sources before changing code. Record durable findings under `docs/research/`.
4. Reconcile the requested outcome against the whole current product model and conflicting evidence. Before implementation, update every affected owning requirement/design/ADR/research document and current memory/status, replace stale current text, and checkpoint that nonvolatile truth in Git. If semantics remain disputed, record a hold and stop dependent implementation.
5. Implement the smallest complete change from that checkpoint. Add tests and concise rationale comments in proportion to risk, and keep operational/current-truth updates in the same coherent pull request when implementation changes source facts.
6. Run `sh scripts/check-project-state.sh` on macOS/Linux/Git Bash or `./scripts/check-project-state.ps1` on PowerShell, plus `npm run check` and any relevant manual browser/network checks. Record this local evidence in the pull request; GitHub Actions are reserved for `main` integration, releases, and explicit manual runs.
7. Merge an accepted truth checkpoint before dependent candidates. Rebase or rebuild a retained candidate from that main once, keeping main's owning truth on conflicts and transplanting only approved scoped code, tests, and new facts. Make focused commits using `type(scope): summary` where practical, then push the branch.
   Create any new implementation branch or parallel worktree from that exact canonical `main` commit, never from an older candidate or auxiliary worktree.
8. Open a pull request using the repository template. Resolve review comments and required local checks before merging.
9. Prefer squash merge for a single coherent change; preserve separate commits when they carry independently useful history. Delete the merged branch.

Direct commits to `main` are reserved for an explicit user-approved exception. Never force-push shared branches or rewrite shared history without explicit approval.

Clean up worktrees and branches only after semantic review and integration are complete and the normal merged-head, open-reference, clean-tree, and non-following link checks pass. Never merge an old branch wholesale after a newer truth checkpoint.

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
