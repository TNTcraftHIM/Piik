# GitHub Repository And Releases

[Versioning](../standards/versioning.md) owns release meaning and compatibility;
[CONTRIBUTING](../../CONTRIBUTING.md) owns review and local validation. This file
owns the one-time GitHub settings. The source repository is public; automatic
package publication has its own activation gate below.

## Main And Pull Requests

Use squash merging only, with the PR title and body as the squash commit. These
repository settings are applied. Keep automatic branch deletion off: the normal
cleanup step checks local worktrees and remaining references first.

Protect `main` with PRs required, zero mandatory peer approvals for the solo
maintainer, administrator enforcement, linear history, and no force pushes or
deletions. PRs run the read-only release-note check; ordinary branch pushes stay
quiet. Local validation and acceptance precede the squash merge, and required
check settings remain a repository-owner decision. PR/issue
templates live in `.github/`; [naming](../../CONTRIBUTING.md#commit-pr-and-branch-names)
is shared with automatic version selection.

`P4-aaaul/Silip` does not have these protections or GitHub Pages configured yet;
enabling them is the owner's decision. When enabled, the dedicated Website
workflow publishes the static site under [website operations](./website.md).

## Enable Automatic Publication Once

Before enabling, accept the release packages, compatibility baseline, public
copy and repository visibility; finish main protection. Then set repository
Actions variable `SILIP_RELEASES_ENABLED` to `true`. This is a repository setting,
not an environment variable for Silip App or Server.

Subsequent accepted PRs merged to main use the existing CI workflow. Product
changes calculate one version, validate, package Server and all App targets,
and publish the same artifacts. Standalone website/docs changes validate without
packaging or releasing; [versioning](../standards/versioning.md#automatic-publication)
owns that boundary. Runs queue rather than overlap or cancel one another. PRs
validate release notes without packaging or publication; manual `app_checks`
dispatch remains available for candidates.
Writing a new version back to main is unnecessary and prohibited.

For a complete package rehearsal, dispatch with `app_checks: true` and an
explicit `candidate_version` such as `v1.0.0`. This builds genuine Server and
native App artifacts under one revision and version without tagging or
publishing. Prepare its [release-note section](../standards/versioning.md#release-notes)
in the candidate PR and review that rendered body; branch checkpoints need no
release copy. The publishing run generates the final notes from accepted squash
commits. To preview that aggregate locally after integration, run
`node scripts/release-notes.mjs VERSION FULL_SOURCE_SHA` from the checkout with
full history and tags. Download the candidate run's artifacts and pass their
directory, version and full revision to `scripts/publish-release.mjs --dry-run`
(put the flag after the three positional arguments). This validates package
identity and checksums without publishing or aggregating branch commit messages.
An omitted candidate version keeps the usual development/exact-tag identity.

Enable GitHub's built-in release immutability for formal publication where
available. Upload all assets to the draft before publishing. A failed upload can
resume its same-source draft; a published version is never clobbered. If its
files are wrong or incomplete, publish a corrected new version. An older retry
must not replace a newer release's `latest` designation.

To stop future automatic publication, remove/set false the activation variable;
this does not alter existing releases or a currently running workflow. Inspect
the active run separately. No pipeline step changes visibility or installs an
update into a running Silip deployment.

For accepted contribution PRs that should merge without a release, set
`SILIP_RELEASES_ENABLED=false` before merging and confirm no active publishing
run will release the changes. Keep it false through subsequent merges until
the next release is authorized. Then restore `true` before that release's
integration merge. The existing release planner and notes collector include
all eligible changes since the last stable tag; no separate contribution
release or version-record commit is needed.

## Container Registry

The Server image uses `ghcr.io/p4-aaaul/silip`. The publishing job authenticates
with `GITHUB_TOKEN` and `packages: write`; no additional registry secret is needed.
The image's source label links it to this repository. GitHub's
[Container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
owns the registry permission and visibility behavior.

At first publication, set the Silip container package's visibility to **public**
in its GitHub package settings; repository visibility alone does not do this.
Verify both its version tag and `latest` with an anonymous pull before announcing
the Docker download. Keep repository Actions access enabled for later releases.
Image checks, version identity and retries follow
[container distribution](../standards/versioning.md#container-distribution).

## Platform References

- [Protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Workflow concurrency and queued runs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-queueing-multiple-pending-runs)
- [Workflow completion triggers and trust boundaries](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Downloading original artifacts from another run](https://github.com/actions/download-artifact#download-artifacts-from-other-workflow-runs-or-repositories)
- [Immutable release workflow](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
