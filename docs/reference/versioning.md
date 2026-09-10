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

Today, strict JSON objects reject unknown keys and enums, and required fields
reject omissions. Therefore even adding a field can break the other side.
For example, adding required `sfu` to `/api/capabilities` rejects both the old
strict reader and the new reader receiving the old shape. An unchanged
signaling identifier does not cover HTTP compatibility.

Before 1.0, choose extensibility at specific descriptive boundaries: capability
and discovery metadata may ignore unknown descriptive fields while validating
known types, bounds and required identity. An absent optional capability means
unavailable. Keep commands, credentials and authority checks strict. A new
message type, enum value or behavior-changing field is emitted only after the
other side advertises support; accepting unknown metadata is not permission to
execute unknown commands. Verify both readers before calling a change additive.

For an actual mismatch, report which component needs updating. Native discovery
must distinguish an incompatible Piik App from an absent App. Offer ordinary
Browser operation where it is supported. Do not reload, reinstall or interrupt
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

## First Public Release Readiness

The current private single-contract rule remains until this boundary is ready:

1. Teach existing packagers and Web/Server update readers about product versions
   plus SHA; validate artifact/descriptor identity through the same pipeline.
2. Make native incompatibility observable; establish the limited metadata and
   feature-support rules above before freezing the first public contracts.
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
