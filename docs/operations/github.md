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

These protections are active, including conversation resolution. GitHub Pages
uses the **GitHub Actions** publishing source and the `piik.tv` custom domain;
the repository homepage points to `https://piik.tv`. The dedicated Website
workflow publishes the static site under [website operations](./website.md).

## Enable Automatic Publication Once

Before enabling, accept the release packages, compatibility baseline, public
copy and repository visibility; finish main protection. Then set repository
Actions variable `PIIK_RELEASES_ENABLED` to `true`. This is a repository setting,
not an environment variable for Piik App or Server.

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
update into a running Piik deployment.

For accepted contribution PRs that should merge without a release, set
`PIIK_RELEASES_ENABLED=false` before merging and confirm no active publishing
run will release the changes. Keep it false through subsequent merges until
the next release is authorized. Then restore `true` before that release's
integration merge. The existing release planner and notes collector include
all eligible changes since the last stable tag; no separate contribution
release or version-record commit is needed.

## Container Registry

The Server image uses `ghcr.io/tntcrafthim/piik`. The publishing job authenticates
with `GITHUB_TOKEN` and `packages: write`; no additional registry secret is needed.
The image's source label links it to this repository. GitHub's
[Container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
owns the registry permission and visibility behavior.

At first publication, set the Piik container package's visibility to **public**
in its GitHub package settings; repository visibility alone does not do this.
Verify both its version tag and `latest` with an anonymous pull before announcing
the Docker download. Keep repository Actions access enabled for later releases.
Image checks, version identity and retries follow
[container distribution](../standards/versioning.md#container-distribution).

## AtomGit Download Mirror

[AtomGit TNTcraftHIM/Piik](https://atomgit.com/TNTcraftHIM/Piik) is the public
source and Release mirror. GitHub owns development, issues and original packages.
AtomGit's configured repository synchronization handles branches, tags and commits;
the **AtomGit mirror** GitHub workflow separately copies published binary assets.
Its repository Actions secret is `ATOMGIT_TOKEN`. Never put this token in source,
a remote URL or a distributed package. GitHub publication keeps its scoped token.

After a successful main-push CI run, the workflow downloads that run's complete
original Server and App artifacts and invokes `scripts/mirror-release.mjs`.
It skips runs that did not publish the current GitHub release. GitHub publication
and **Website** do not depend on mirror success. An unfinished mirror remains a
prerelease until every package passes anonymous full-download SHA-256 validation.
This includes the original signed APK and its already-built ZIP wrapper.

For recovery, rerun **AtomGit mirror** with the original publishing CI run ID:

```sh
gh workflow run atomgit-mirror.yml --repo TNTcraftHIM/Piik --ref main -f run_id=RUN_ID
```

The source must be a completed main-push CI run matching the latest published
GitHub release. The workflow runs trusted main tooling and treats artifacts only
as data. A superseded release cannot complete a new mirror. Both publishers reject
changing published bytes; a corrected package needs a corrected new version.

For a local retry, let any active workflow finish and recover the complete original
build output, including descriptors, manifests and checksum sidecars, in one fresh
directory. Use `gh run download` for each `piik-server*` and `piik-app-*` artifact
from that publishing run, or use the retained operator output after CI expiry.
Public Release archives alone do not include all validation sidecars. Never rebuild
a published version to recover metadata. See [artifact retention](../deployment.md#build-host).

```sh
node scripts/mirror-release.mjs /path/to/original-artifacts VERSION FULL_SOURCE_SHA --dry-run
node scripts/mirror-release.mjs /path/to/original-artifacts VERSION FULL_SOURCE_SHA
```

Supply `ATOMGIT_TOKEN` only through the publisher environment. Reads retry within
a bounded deadline, including complete response bodies. Mutations are not blindly
retried: rerunning inventories existing files before uploading missing ones. Signed
upload URLs and callback headers are credentials and are never logged. A failed
upload leaves a visible failed workflow and pending prerelease.

No automatic attachment cleanup runs. Do not apply Gitee's former size/quota or
retention rules to AtomGit. This migration does not delete the old Gitee repository
or its packages. Already published software keeps its embedded old fallback until
a later software release replaces it.

## Platform References

- [Protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Workflow concurrency and queued runs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-queueing-multiple-pending-runs)
- [Workflow completion triggers and trust boundaries](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Downloading original artifacts from another run](https://github.com/actions/download-artifact#download-artifacts-from-other-workflow-runs-or-repositories)
- [Immutable release workflow](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
