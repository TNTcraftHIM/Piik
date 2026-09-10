# Versions And Compatibility

Prepared 2026-09-10. This is the version-policy design for the first public
release, not a claim that the current private build already implements it.
Use `v1.0.0` for that release, with one product version for App, Server and the
embedded Web build. Keep the full Git SHA alongside it for exact provenance.
Public release declaration and the readiness work below remain pending.

## Give Each Identifier One Job

| Identifier | Meaning and owner | Change rule |
| --- | --- | --- |
| `vMAJOR.MINOR.PATCH` | Public Git tag/product release | Patch: compatible fixes; minor: compatible features; major: incompatible public contract |
| Full Git SHA / `REVISION` | Exact source revision | Changes with the source commit; never use SHA inequality as release ordering or compatibility proof |
| Artifact SHA-256 | Exact packaged bytes in the release descriptor | Each artifact; one source SHA can produce different platform/toolchain binaries |
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
The npm package version currently does not own release identity.

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

The accepted public tag is the product-version input to packaging; the full SHA
remains the immutable build input. Inject both into binaries, embedded Web/debug
metadata and the existing release descriptor. Do not maintain independent
hand-edited App/Server/Web version files. Keep archive naming and packaging
layout under their current owners; do not rebuild artifacts to relabel a release.

Update checks compare actual release precedence and link to the matching release.
Stable users do not receive prereleases by default. An untagged development build
is identified by SHA; it must not claim that every different stable SHA is newer.
Existing SHA-only readers need updating before publishing SemVer tags.

Updates remain explicit, outside an active share, using complete matching
packages. [Deployment](../deployment.md) owns artifact verification, cutover and
recovery. A changed storage format needs its own upgrade and rollback treatment;
restoring an old authority database after newer grants/revocations is not a safe
routine downgrade. No automatic updater or generic migration framework is
introduced by this policy.

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
The target Gitee repository is still to be configured; neither mirror publishing
nor multi-source update checking is implemented by this design.

Gitee currently documents 100 MB per attachment and 1 GB total repository
attachments for ordinary projects. Check final package size and mirror retention
before enabling uploads. Anonymous metadata and a small asset worked in read-only
checks on an official public repository; target upload/download acceptance remains.
Use API metadata in the Browser; ordinary asset-link redirects are not guaranteed
to permit cross-origin fetch, even when a normal download works.

## First Public Release Readiness

The current private single-contract rule remains until this boundary is ready:

1. Teach existing packagers and Web/Server update readers about product versions
   plus SHA and the primary/mirror release sources; validate artifact/descriptor
   identity through the same pipeline.
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
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases) and
  [Gitee's official API SDK reference](https://gitee.com/sdk/gitee5j/blob/main/docs/RepositoriesApi.md):
  provider endpoints and metadata. [Gitee Release documentation](https://help.gitee.com/repository/release/intro)
  owns its current attachment limits. Provider checks were made on 2026-09-10.
