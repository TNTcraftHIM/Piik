# Versions And Compatibility

Reviewed 2026-09-12. Release identity, update comparisons and descriptive metadata
rules are implemented; the public compatibility promise starts with the first
declared public release. Use `v1.0.0` for it, with one product version for App,
Server and the embedded Web build, plus the full Git SHA for source provenance.
Automatic publication remains disabled until the readiness boundary below.

## Give Each Identifier One Job

| Identifier | Meaning and owner | Change rule |
| --- | --- | --- |
| `vMAJOR.MINOR.PATCH` | Public Git tag/product release | Patch: compatible fixes; minor: compatible features; major: incompatible public contract |
| Full Git SHA / `REVISION` | Exact source revision | Changes with the source commit; never use SHA inequality as release ordering or compatibility proof |
| Artifact SHA-256 | Exact packaged bytes in the release descriptor | Each artifact; one source SHA can produce different platform/toolchain binaries |
| Platform application version fields | Generated package metadata | Product version in the platform's numeric format; source SHA stays separate. XML/desktop-format versions remain specification values |
| Browser/Server signaling identifier | WS contract in `src/shared/protocol.ts` and Go protocol constants | Change for an incompatible wire contract, not UI edits or every release |
| Browser/App control identifier | `src/client/native/wire.ts` and App loopback/control | Independent compatibility boundary; installed App and Site can update separately |
| Capture probe and encoded-frame envelope | `internal/app/nativecapture` and platform adapters | Internal matched bundle; change only the affected format |
| SQLite schema, App config format, Browser storage-key format | Their storage/parser owners | Change with the actual stored representation; preserve accepted authority across a compatible upgrade |
| Release descriptor schema | Packager and descriptor readers | Describes metadata format, not the product release |
| Room authorization generation, share/route/publication/media generations, connection IDs | Current authority and resource owners | Runtime identity/freshness only; never reset or align them with release numbers |

Current numeric values are in source and [status](../status.md#accepted-release-contract).
Keep those internal values at the first public release: resetting schema or
authorization counters for visual consistency can invalidate data or stale-work
fences. A room number is a user-facing address, not a software version.
The private tooling-only npm package carries no independent product version.

## Public Compatibility Promise

The protected surface is documented App/Server startup and configuration, room
and invitation behavior, persisted authority, and the Browser/Server/App
interfaces needed for established sharing and viewing. Internal Go/TypeScript
symbols, capture sidecar details within a matched bundle, and undocumented
diagnostic fields are not separately supported public APIs.

- Within a public major, newer releases preserve established workflows and
  accepted configuration/data for older public releases in that major. New features
  require support at the receiving end; they are not sent speculatively.
- A Site serves its own Web build, but an already-open page or installed App
  can be older. Compatibility is checked at their actual contracts, not by
  requiring identical product versions or SHAs. New App with older Site keeps
  established compatible functionality; newly added features may be unavailable.
- A patch/minor cannot remove a documented command, require a new field from an
  old peer, change an existing field's meaning, revoke valid room authority, or
  turn an incompatible HTTP response into a supposedly compatible WS release.
  Deliberate public breakage needs a major and clear upgrade instructions.
- Same-major forward upgrades preserve existing durable authority. Arbitrary
  binary/database downgrades, cross-major interoperability, process restart
  without media interruption, and identical performance on every OS/browser
  are not promised. A security repair may restrict previously unsafe behavior;
  explain the impact rather than silently redefining compatibility.

This does not require retaining every historical implementation. Keep one stable
baseline contract; introduce a small optional capability only for a concrete
new feature. Do not add a version-range solver, general adapter framework,
parallel authority writers or blanket old-client fallback paths.

## Extending Interfaces

Command/event JSON objects still reject unknown keys and enums, and required
fields reject omissions. Therefore even adding a field can break the other side.
The former required `sfu` addition to strict `/api/capabilities` demonstrated
both directions of this problem; an unchanged signaling identifier does not
cover HTTP compatibility.

Runtime capabilities and App discovery now ignore unknown descriptive fields
while validating known types, bounds and required identity. An absent optional
capability means unavailable. Commands, credentials and authority checks remain
strict. A new
message type, enum value or behavior-changing field is emitted only after the
other side advertises support; accepting unknown metadata is not permission to
execute unknown commands. Verify both readers before calling a change additive.

Native discovery distinguishes an incompatible Piik App from an absent App and
reports protocol numbers to local diagnostics; the source picker offers update/
refresh guidance and Browser operation. Do not reload, reinstall or interrupt
an active share just because an unrelated product/build label changed.

## Release And Recovery

A single release plan computes the next tag and full source SHA. Packagers inject
both into binaries, embedded Web/debug metadata and the schema-2 release descriptors.
Local candidates use an exact release tag, `development` or an explicit candidate
version. An explicit version labels an unpublished test artifact; it does not
declare or freeze a public release. It cannot reuse a tag owned by another source
revision. Do not maintain independent hand-edited App/Server/Web version files.
Archive layout and checks stay in the
existing packagers; a new build never replaces an already-published package.

Update checks compare actual release precedence and link to the matching release.
Newer version wins even when the source SHA is unchanged. Same version with a
different known SHA reports a different official build, not a newer one. A
development build with a known differing SHA offers the official release as a
manual choice; it makes no ordering claim. Older releases never cause an update
notice. Unknown SHA is not inferred from a branch name in GitHub metadata.
The publisher records a full SHA in `target_commitish` and verifies actual tag
identity separately. Stable update notices ignore prereleases.

## Automatic Publication

After one-time activation, a complete squash PR merged to main runs the existing
CI and packaging pipeline. `scripts/release-version.mjs` examines unreleased
first-parent commit messages: `feat` selects minor, `!` or `BREAKING CHANGE`
selects major, and other accepted changes select patch. The first release is
`v1.0.0`. PR/commit naming is owned by [CONTRIBUTING](../../CONTRIBUTING.md#commit-pr-and-branch-names).
Code size or an internal refactor does not itself imply a breaking release.

No version/changelog commit is written back to main. The workflow queues main
runs, uses the same source SHA for Server and all App targets, and publishes only
after all required artifacts and checks pass. The publisher verifies matching
version, source SHA and checksums, then creates/uploads/publishes one GitHub draft.
Failed draft uploads can resume; published artifacts are never overwritten.
An older draft retried after a newer release cannot take over `latest`.

`PIIK_RELEASES_ENABLED` is a GitHub repository activation variable, not a product
setting. Until the first release is explicitly enabled,
main runs validation and manual `client_checks` dispatches create candidates only.
Ordinary branches and PRs do not run cloud CI. [GitHub operations](../operations/github.md)
owns activation and main protection; no workflow changes repository visibility.

Updates remain explicit, outside an active share, using complete matching
packages. [Deployment](../deployment.md) owns artifact verification, cutover and
recovery. A changed storage format needs its own upgrade and rollback treatment;
restoring an old authority database after newer grants/revocations is not a safe
routine downgrade. No automatic updater or generic migration framework is
introduced by this policy.

## Release Notes

GitHub Releases owns the published changelog. Each accepted PR supplies reviewed
Chinese and English user-facing copy under the exact `## Release notes` heading
in its squash commit; `###` headings structure that copy. Explain benefits,
fixes and required upgrade actions, including breaking changes. Keep internal
work logs, audit handoffs and unverified claims outside this public section.

`scripts/release-notes.mjs` collects these sections from all unreleased
first-parent commits since the previous stable tag. The first release uses
only its launch commit's product introduction; private development history is
not a launch changelog. Missing, empty or duplicate sections fail validation
before packaging/publication. GitHub Actions shows the generated text in its
run summary. A manual candidate with an explicit version also previews it, so
prepare its commit text before dispatching a release rehearsal.

The publisher passes the same text through a temporary notes file to GitHub,
then removes that file. Gitee copies the GitHub description. Retrying the same
release preserves its draft/published description; an exact tag does not move
the changelog's starting point. Keep no `CHANGELOG.md`, versioned note directory
or generated history commits. PRs and Git retain editorial provenance.

## Release Sources

GitHub Releases is the primary publication; Gitee is an optional official mirror
for domestic access, with a minimal README pointing development and documentation
back to GitHub. The Gitee repository need not copy the source tree. Its README/tag
commit is not the Piik source revision; release metadata retains the original
GitHub SHA. Build each target once and copy the same archives, notices,
version, full source SHA and artifact hashes to both. A Git repository mirror
alone does not synchronize Release attachments. Keep one release description and
machine-readable metadata, generated by the existing packaging pipeline.

The two providers only adapt API fields and download locations into the same
release model. Share version comparison, channel filtering and package validation.
The normal background check tries GitHub, then Gitee if the primary is unavailable;
download links may expose both verified locations. A lagging mirror must not
cause a downgrade or a version/hash disagreement to be silently accepted.
Gitee's documented latest endpoint means last updated, so provider normalization
must select stable release precedence explicitly, not equate provider ordering.

Synchronize only an explicitly published release; branch pushes stay quiet.
Retrying a failed mirror upload reuses the original package. Advertise a mirrored
package as available only after its required attachments and matching metadata
are present. Tokens belong only to publishing, never the distributed Browser/App.
The public mirror is [TNTcraftHIM/Piik](https://gitee.com/TNTcraftHIM/Piik).
The publisher reuses the shared artifact validator, checks every local file
against GitHub's published asset digest, then uploads and verifies anonymous
Gitee downloads. Gitee has no draft API: an incomplete mirror remains a preview
release, and becomes stable only after every file passes. A source marker in
the release body (`<!-- piik-source: <full-SHA> -->`) preserves the GitHub revision;
the mirror's `target_commitish` identifies only its own README commit.
App notices and the operator check share their existing version comparison
across providers. Each provider has its own deadline; the mirror checks at most
ten pages of 100 releases and rejects an incomplete listing. An explicit operator
`--api-url` override checks that endpoint alone. A valid primary result, including
an up-to-date result, does not consult the mirror.

Gitee currently documents 100 MB per attachment and 1 GB total repository
attachments for ordinary projects. The mirror rejects files above 100,000,000
bytes before writing. Check aggregate capacity before each release; exhausted
storage leaves a pending preview rather than deleting older downloads.
Target authentication, uploads, anonymous metadata/CORS and a small download's
SHA-256 have been verified. Acceptance of the full matching release packages
remains pending with the first public release.
Use API metadata in the Browser; ordinary asset-link redirects are not guaranteed
to permit cross-origin fetch, even when a normal download works.

## First Public Release Readiness

The current private single-contract rule remains until this boundary is ready:

1. Accept real target packages and the queued GitHub publication path before
   enabling automatic releases. Current local checks exercise planning, identity
   injection, update decisions and publisher failure/retry paths without publishing.
2. Freeze the first public baseline and explicit feature-support rules after
   checking the implemented discovery and descriptive-metadata behavior above.
3. Exercise the first supported old/new App-Site pair in both directions,
   a stale open page, incompatible-contract recovery and retained room/config
   authority. Bundled capture checks remain within their existing package gate.
4. Freeze the supported baseline and release notes, then explicitly declare
   `v1.0.0`. Do not manufacture compatibility by merely renumbering private builds.

These implementation tasks are tracked in [TODO](../todo.md). Their absence is
a public-release gap, not evidence that the current matched private build fails.

## References

- [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html): release meaning follows a
  declared public API; build metadata does not determine precedence.
- [Syncthing releases](https://docs.syncthing.net/users/releases.html) and
  [BEP](https://docs.syncthing.net/specs/bep-v1.html): product versions, peer
  protocol and storage/upgrade behavior are distinct. Piik does not adopt its
  minor-release REST-breaking exception for the protected interfaces above.
- [Go compatibility](https://go.dev/doc/go1compat): name the protected contract
  and its limits instead of promising universal binary/runtime compatibility.
- [Debug Adapter Protocol evolution](https://microsoft.github.io/debug-adapter-protocol/overview.html):
  stable baseline messages and explicit optional capabilities allow independent
  endpoints to evolve. Piik uses that principle within its existing WebSocket/JSON
  contracts; it does not replace them with DAP or a generic negotiation framework.
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) provides
  the small release-intent vocabulary; standard SemVer libraries perform ordering.
- Apple's [bundle build version](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)
  and [release version](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)
  are numeric; package generation derives both from the release and keeps SHA separately.
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases) and
  [Gitee's official API SDK reference](https://gitee.com/sdk/gitee5j/blob/main/docs/RepositoriesApi.md):
  provider endpoints and metadata. [Gitee Release documentation](https://help.gitee.com/repository/release/intro)
  owns its current attachment limits. Provider checks were made on 2026-09-12.
