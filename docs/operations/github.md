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
deletions. Do not require cloud PR checks while branch/PR CI is intentionally
quiet; local validation and acceptance precede the squash merge. PR/issue
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
owns that boundary. Runs queue rather than overlap or cancel one another. Branches/PRs
stay quiet; manual `app_checks` dispatch remains available for candidates.
Writing a new version back to main is unnecessary and prohibited.

For a complete publisher rehearsal, dispatch with `app_checks: true` and an
explicit `candidate_version` such as `v1.0.0`. This builds genuine Server and
native App artifacts under one revision and version without tagging or
publishing. Prepare its [release-note section](../standards/versioning.md#release-notes)
and inspect the generated preview in the run summary. For a local preview, run
`node scripts/release-notes.mjs v1.0.0 FULL_SOURCE_SHA` from the checkout with
full history and tags. Download that run's artifacts and pass their directory, version and
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

## Gitee Download Mirror

[TNTcraftHIM/Piik](https://gitee.com/TNTcraftHIM/Piik) is a public README/Release
mirror. Source, documentation and issues stay on GitHub. The publishing job uses
the repository Actions secret `GITEE_TOKEN`, which is configured; rotate it there
when needed. Never put it in source, a remote URL or a distributed package.
GitHub publication continues to use the workflow's scoped token.

After GitHub publication, the same job runs `scripts/mirror-release.mjs` on the
original artifacts. Upload failure leaves the Gitee release marked as a preview.
Rerun the failed publishing job to verify existing files and upload only missing
ones. GitHub's published release remains unchanged. Both publishers reject
changing a published package; use a corrected new version if its bytes are wrong.

For a local retry, use the original complete build output retained outside the
checkout. While the publishing run's artifacts are available, download all four
into one directory (replace `RUN_ID`, `FULL_SOURCE_SHA` and `VERSION`):

```sh
for artifact in piik-server piik-app-windows-amd64 piik-app-linux-amd64 piik-app-darwin-arm64; do
  gh run download RUN_ID --repo TNTcraftHIM/Piik \
    --name "$artifact-FULL_SOURCE_SHA" --dir /tmp/piik-mirror
done
node scripts/mirror-release.mjs /tmp/piik-mirror VERSION FULL_SOURCE_SHA
```

Use a fresh directory. Public Release downloads contain only runtime archives;
mirror verification also needs the original descriptors, manifest and checksum
files. If CI artifacts have expired, recover that complete output from the
operator's retained copy. Rebuilding a published version is not a metadata
recovery procedure. See [artifact retention](../deployment.md#build-host).

Use the release's actual version and full `target_commitish` SHA, with
`GITEE_TOKEN` supplied through the publisher environment. `--dry-run` after the
three arguments checks local identity, checksums and attachment sizes without
publishing. The [release-source policy](../standards/versioning.md#release-sources)
owns provenance, selection and quota limits. The first public release passed
complete matching Server and three-platform App mirror download acceptance.

## Platform References

- [Protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Workflow concurrency and queued runs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-queueing-multiple-pending-runs)
- [Immutable release workflow](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
