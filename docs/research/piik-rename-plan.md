# Piik rename plan

Status: active planning document for the pre-publication rename.

## Goal

Rename the active product, repository-facing code, documentation and release
surface from Screener to Piik while keeping the product mascot-only. The Piik
wordmark and the Piik-to-mascot animation remain website and brand-study
material, not runtime UI.

## Recovery point

Before this phase, the complete local Git refs were exported to:

`C:\Users\TNTcraft\Documents\Screener-builds\piik-rename-backup-a8c4df6f98db\repository.bundle`

The same directory contains `refs.txt`, `worktrees.txt`, `status.txt` and
`head.txt`. The bundle is the recovery source for this phase; no history rewrite
is allowed without creating and validating a second bundle first.

## Rename classes

1. **Display and documentation:** product name, README, guides, website copy,
   screenshots, release notes and public asset labels. These are safe to change
   together.
2. **Repository and package identity:** repository URL, Go module path, package
   names, executable names, client folders and release asset names. These are
   coordinated release changes.
3. **Operational contracts:** environment variables, systemd unit/user/path,
   deployment directories, service names and release API URLs. These require one
   cutover and a tested upgrade path.
4. **Wire and persisted contracts:** signaling protocol labels, browser storage
   keys and database metadata. Rename only with an explicit version boundary;
   do not add dual readers or compatibility aliases.
5. **Git history:** keep existing commits, tags, audit evidence and revision
   identifiers unchanged. Rewriting all commit messages changes every descendant
   SHA and invalidates external audit and deployment references for no product
   benefit. A separate archival rewrite would be a different project.

## Order

1. Inventory every active reference and classify it before editing.
2. Rename display, docs, assets and source identifiers on this branch.
3. Rename executable, service and release paths in one deployable cutover.
4. Decide the protocol/storage version boundary from the current production
   client set; update tests and deployment checks together.
5. Build and run focused checks, then package server and client artifacts.
6. Deploy a canary, verify old room links, new client/server interop, releases,
   debug export and rollback from the saved bundle.
7. Rename the GitHub repository only after the code cutover is accepted. Update
   local remotes, workflow references, release URLs and the custom Pages domain.

## Risks and gates

- Existing production pages and clients may still speak the current signaling
  label. A protocol rename is a deliberate breaking boundary, not a cosmetic
  replacement.
- Existing deployments may depend on `SCREENER_*`, `/opt/screener`,
  `screener.service` and `screener-server`. The release must replace these
  atomically or the deployment gate fails.
- GitHub repository renames redirect most repository traffic, but GitHub does not
  redirect Actions hosted by a renamed repository; project Pages URLs are also a
  separate case. Use `piik.tv` as the stable public Pages origin.
- `Piik` is already used by unrelated software, including `piik.me` and a mobile
  app. Do a basic name/domain collision review before public publication.

## Acceptance

The phase is complete only when a clean checkout contains no active Screener
product identity outside explicitly retained historical/protocol evidence,
server and client packages build, the production canary works, rollback is
rehearsed, and the repository rename can be performed without a code change.
