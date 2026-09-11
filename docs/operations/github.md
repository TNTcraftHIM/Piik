# GitHub Repository And Releases

[Versioning](../reference/versioning.md) owns release meaning and compatibility;
[CONTRIBUTING](../../CONTRIBUTING.md) owns review and local validation. This file
owns the one-time GitHub settings. The source remains private and automatic
publication is not enabled.

## Main And Pull Requests

Use squash merging only, with the PR title and body as the squash commit. These
repository settings are applied. Keep automatic branch deletion off: the normal
cleanup step checks local worktrees and remaining references first.

Protect `main` with PRs required, zero mandatory peer approvals for the solo
maintainer, administrator enforcement, linear history, and no force pushes or
deletions. Do not require cloud PR checks while branch/PR CI is intentionally
quiet; local validation and acceptance precede the squash merge. PR/issue
templates live in `.github/`; [naming](../../CONTRIBUTING.md#commit-pr-and-branch-names)
is shared with automatic version selection.

GitHub currently rejects protection/ruleset requests for this private repository
with a plan-required 403. Protection is therefore **not active**. GitHub Free
supports it for public repositories; a private repository needs an eligible paid
plan. Once eligible, configure it in Settings → Branches/Rules and verify the
result. Do not substitute a local hook or change visibility implicitly.

## Enable Automatic Publication Once

Before enabling, accept the release packages, compatibility baseline, public
copy and repository visibility; finish main protection. Then set repository
Actions variable `PIIK_RELEASES_ENABLED` to `true`. This is a repository setting,
not an environment variable for Piik App or Server.

Subsequent accepted PRs merged to main use the existing CI workflow: calculate
one version, validate, package Server and all App targets, and publish the same
artifacts. Runs queue rather than overlap or cancel one another. Branches/PRs
stay quiet; manual `client_checks` dispatch remains available for candidates.
Writing a new version back to main is unnecessary and prohibited.

For a complete publisher rehearsal, dispatch with `client_checks: true` and an
explicit `candidate_version` such as `v1.0.0`. This builds genuine Server and
native App artifacts under one revision and version without tagging or
publishing. Download that run's artifacts and pass their directory, version and
full revision to `scripts/publish-release.mjs --dry-run` (put the flag after
the three positional arguments). An omitted candidate version keeps the usual
development/exact-tag identity.

Enable GitHub's built-in release immutability for formal publication where
available. Upload all assets to the draft before publishing. A failed upload can
resume its same-source draft; a published version is never clobbered. If its
files are wrong or incomplete, publish a corrected new version. An older retry
must not replace a newer release's `latest` designation.

To stop future automatic publication, remove/set false the activation variable;
this does not alter existing releases or a currently running workflow. Inspect
the active run separately. No pipeline step changes visibility or installs an
update into a running Piik deployment.

Gitee is an optional download mirror with a README linking here, not a second
source repository. Its target, quota and upload acceptance remain to be configured;
the [release-source policy](../reference/versioning.md#release-sources) owns this
boundary. GitHub authentication for publication stays in the workflow's scoped
token, not in distributed packages.

## Platform References

- [Protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Workflow concurrency and queued runs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-queueing-multiple-pending-runs)
- [Immutable release workflow](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
