# Versions And Compatibility

Reviewed 2026-09-13. `v1.0.0` is the declared public compatibility baseline.
App, Server and the embedded Web build share one product version, plus the full
Git SHA for source provenance. [Status](../status.md) owns the current publication
state; automatic publication follows the product-change boundary below.

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
The shared App launcher displays its installed version from the existing launcher
state; development builds also show their short source revision.
The Web help menu displays its bundled build version without a network lookup.
Server startup logs retain the running version and revision. The website may
display GitHub's latest stable tag and `published_at` as optional metadata, never
a manually maintained version or the installed App's identity. Publication time
is distinct from build time; an unavailable check must not block downloads.

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

Keep the 2.x baseline long-lived. Substantial new functionality can remain a
minor release when older peers retain established behavior and new behavior is
explicitly opted into. A small feature can still be breaking if it unconditionally
changes a strict message, existing semantics or durable authority. Review those
boundaries before choosing the version; neither feature count nor a desire to
avoid a major justifies mislabeling an incompatible release.

## Extending Interfaces

Command/event JSON objects still reject unknown keys, and required fields reject
omissions. Most enums remain closed; the bounded display-only reaction identifier
has an explicit [receive-side exception](./rooms-access.md#room-interactions).
Therefore even adding a field can break the other side.
The former required `sfu` addition to strict `/api/capabilities` demonstrated
both directions of this problem; an unchanged signaling identifier does not
cover HTTP compatibility.

Runtime capabilities and App discovery now ignore unknown descriptive fields
while validating known types, bounds and required identity. An absent optional
capability means unavailable. Commands, credentials and authority checks remain
strict. A new
message type, enum value or behavior-changing field is emitted only after the
other side advertises support; accepting unknown metadata is not permission to
execute unknown commands. A more tolerant reader does not update already-released
readers: do not emit a new reaction to legacy pages merely because current pages
can skip it. Verify both readers before calling a change additive.

In the 2.0 contract, numeric media descriptions and retry progress
are independent of current implementation limits and retry policy. Extending
those policies does not require another count-specific capability flag.
Representation acceptance still requires local operation/resource admission;
it is not a promise that every same-major peer can produce a new media format.

Native discovery distinguishes an incompatible Silip App from an absent App and
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

Android `versionName` uses the product version. Its `versionCode` is generated as
`major * 1000000 + minor * 1000 + patch`; minor and patch must each be at most
999, and the result must be in Android's `1..2100000000` range. Development
builds use code 1 and include the short revision in `versionName`. The shared
product version remains the only release ordering input; no Android counter is
maintained separately.

Desktop App archive names are fixed per target: `silip-app-{target}.zip`. Each published
tag owns its archive bytes; the full source SHA remains in `REVISION` and the
release descriptor. Fixed names allow GitHub's native latest-asset links;
[website operations](../operations/website.md#preview) owns download presentation.

Android uses the installable `silip-app-android-universal.apk` for both ARM64 and
x64. It follows the same release identity, checksum, complete-target and
publication rules. [Android build instructions](../../mobile/README.md#signed-release-apk)
own signing input and installation details.

Public Release attachments contain the App ZIPs/APK and Server runtime archives
for the registered package targets. Package descriptors (`.release.json`), file manifests (`.manifest.tsv`)
and standalone `.sha256` files remain build/deployment inputs in the local output
and CI artifacts; publishers validate them but do not upload them to GitHub Releases. The release body includes a collapsed full source SHA and
SHA-256 listing generated from the verified packages. GitHub's automatic source
archives are separate from Silip's uploaded packages. Retain original build
metadata with operator deployment records as described in [deployment](../deployment.md).

Silip has no in-product update check. The Browser, App and Server make no
release-metadata requests; the owner updates by pulling source changes and
rebuilding, and a published release announces itself only through GitHub.
Do not add a background release lookup or download link without a new decision.

### Major-Upgrade Guidance

Before a major release, put bilingual upgrade guidance near the top of its
release notes and on the website download entry. Name the actual incompatible
App/Site combinations, required upgrade order, interruptions and any persistent
data implications. Do not assume everyone installed the preceding minor/patch.
Verify the oldest relevant public App/page and the last preceding-major release
against the candidate: actual mismatches must fail clearly at their owning
contract. Keep historical packages available through GitHub releases. A major
preparation change does not itself authorize a wire bump, migration or release.

## Automatic Publication

Before a product-changing merge or manual run that can publish, present the
planned version and complete Chinese/English release notes to the owner and
obtain explicit authorization for that release. Implementation or UI acceptance
does not authorize publication. Each later release needs fresh confirmation;
previous release/deployment permission is not standing authority. Once a release
is authorized, its packaging, publication retries and matching deployments may proceed
within that scope without asking again. Automation executes the approved release.

After one-time activation, a complete squash PR merged to main runs the existing
CI pipeline. `scripts/release-version.mjs` filters unreleased first-parent
commits by actual changed paths. Website/film, documentation, research, agent
instructions and standalone maintenance tools do not create product versions.
Shared product UI, runtime code, public assets, licenses, dependencies and
packaging inputs remain eligible; unknown paths are treated as product inputs.
The script owns the exclusion list, shared with release-note generation.

Only eligible commit messages select the increment: `feat` selects minor,
`!` or `BREAKING CHANGE` selects major, and other accepted product changes select
patch. A website-only `feat` cannot increase the next product version. Earlier
unpublished product changes remain eligible when a later website commit reaches
main. PR/commit naming is owned by [CONTRIBUTING](../../CONTRIBUTING.md#commit-pr-and-branch-names).
Code size or an internal refactor does not itself imply a breaking release.

No version/changelog commit is written back to main. The workflow queues main
runs, uses the same source SHA for Server and all App targets, and publishes only
after all required artifacts and checks pass. The publisher verifies matching
version, source SHA and checksums, then creates/uploads/publishes one GitHub draft.
When there are no unpublished product changes, CI validates a development build
and skips packaging and publication; it never assigns an old release version to
a new source SHA. The separate Website workflow follows successful main CI independently;
retries use the original publishing artifacts.
Failed draft uploads can resume; published artifacts are never overwritten.
An older draft retried after a newer release cannot take over `latest`.

`SILIP_RELEASES_ENABLED` is a GitHub repository activation variable, not a product
setting. Until the first release is explicitly enabled,
main runs validation and manual `app_checks` dispatches create candidates only.
Accepted external contributions may merge ahead of a release with this existing
publication gate held off. Keep it off until the next authorized release;
that release includes the eligible contributions since the previous tag.
The [GitHub operations procedure](../operations/github.md#enable-automatic-publication-once)
owns pausing and resuming publication.
Ordinary branches do not run cloud CI. PRs run only a read-only release-note
check, including after edits to their body; product scope uses the same path
owner as publication and the PR's net diff. Packaging and publication remain
post-merge. [GitHub operations](../operations/github.md)
owns activation and main protection; no workflow changes repository visibility.

Updates remain explicit, outside an active share, using complete matching
packages. [Deployment](../deployment.md) owns artifact verification, cutover and
recovery. A changed storage format needs its own upgrade and rollback treatment;
restoring an old authority database after newer grants/revocations is not a safe
routine downgrade. No automatic updater or generic migration framework is
introduced by this policy.

## Container Distribution

`ghcr.io/p4-aaaul/silip` wraps the same verified linux/amd64 and linux/arm64
Server archives as the GitHub release. The packager's optional
`--container-image <tag>` builds from that architecture's extraction;
CI checks its Compose recipe on the matching native runner and transfers the verified image
between jobs as a CI artifact, outside public Release attachments.
`publish-container.mjs` requires matching published GitHub source, version and
Server digest in each image's labels. A standard multi-platform image index
selects the matching architecture; platform tags are immutable inputs to that
index. Existing version tags are retained; `latest`
moves only when that version is GitHub's latest. Manual candidates never publish.
The [release approval boundary](#automatic-publication) and
[first-publication visibility check](../operations/github.md#container-registry)
apply. Preserve the original image and packages for retries.

## Release Notes

GitHub Releases owns the published changelog. Each product-changing PR supplies reviewed
English and Chinese user-facing copy under the exact `## Release notes` heading
in its squash commit; `###` headings structure that copy. Explain benefits,
fixes and required upgrade actions, including breaking changes. Keep internal
work logs, audit handoffs and unverified claims outside this public section.

`scripts/release-notes.mjs` collects these sections from the same eligible
first-parent commits since the previous stable tag. Standalone website and
documentation phases need no product release notes. The first release uses
only its launch commit's product introduction; private development history is
not a launch changelog. Missing, empty, duplicate or visibly encoding-damaged
sections fail PR and publishing validation. GitHub Actions shows the generated
release text in its publishing run summary. Manual candidates validate and build
the requested revision without requiring release copy in branch checkpoints;
their version labels artifacts and never enables publication. The PR body remains
the review surface until integration preserves it in the squash commit.

Supply multiline PR/release copy through a UTF-8 file and read back the stored
body before integration. A terminal preview alone does not prove that Chinese
text survived the shell/API boundary. Do not repair published history by
rewriting main.

The publisher appends generated build identity and package checksums to the
reviewed text, passes it through a temporary notes file to GitHub, then removes
that file. Retrying the same
release preserves its reviewed prose; draft retries refresh only the marked
generated build/checksum section to match the uploaded bytes. Published releases
remain unchanged. An exact tag does not move
the changelog's starting point. Keep no `CHANGELOG.md`, versioned note directory
or generated history commits. PRs and Git retain editorial provenance.

Keep the Release title `Silip vX.Y.Z`. The body may open with one short bilingual
editorial headline. Its lifetime is independent of semver: keep, replace or omit
it based on what is worth telling readers, not whether the version is a patch
or minor update. An already-published feature, a verified community milestone,
thanks or an occasional light aside can lead. Keep Silip's friendly tone without
forced jokes; never turn an old feature into a claim that it is new in this
update, advertise an unfinished prototype or trivialize a serious failure.

When used, open with a short bold title followed by one plain paragraph explaining
that headline's concrete meaning. Write the complete English pair first, then the
Chinese pair. For example: **Play together. Your turn!** / Silip now supports
remote control and remote co-play; **远程同乐，轮到你啦！** / Silip 现已支持远程控制与远程同乐。
The explanation states the feature or fact, rather than adding another slogan;
it does not replace the description of this update below. Keep each title and
explanation to one authored line, using plain text inside `**...**` and the
description. The website reads these same pairs from
the published Release body and displays the current language; it does not keep
another copy, interpret arbitrary Markdown or guess a headline from older
releases. Do not add a campaign registry or automatic
version-based inheritance; review any reused headline when preparing the PR.

Then introduce **this update** in each language with one or two factual sentences:
its actual changes, who benefits and any required upgrade action. A headline is
optional; that explanation is not. An internal refactor alone does not justify
calling a release breaking or major. Urgent security, data-loss or compatibility
instructions take precedence over a playful opening.

Then group concrete changes under useful headings such as highlights, fixes,
upgrade instructions or known limitations. Omit empty categories and routine
implementation/test inventories. A small fix may need only its introduction and
a few bullets. Required upgrade steps or interruptions must be easy to find.
English and Chinese cover the same release facts with natural phrasing, with
English first. Use `###` for language sections and `####` for categories when
both are needed.

The approved final description must read as one release when several unpublished
commits are included. Preview the rendered aggregate with at most one bilingual
headline. The last included product PR owns that choice, including omission;
aggregation removes earlier headlines but retains all actual change details in
order. Do not let repeated introductions or raw commit titles become its narrative. The existing pipeline
preserves authored Markdown and appends identity/checksums; it does not infer an
editorial summary from a version number. Keep provenance and the full changelog
link after the user-facing explanation.

Silip's release scope and upgrade instructions come from its own accepted changes.
Editorial references reviewed on 2026-10-19: [Discord's update](https://discord.com/blog/discord-update-september-25-2026)
combines a friendly voice with concrete changes; [VS Code's version notes](https://code.visualstudio.com/updates/v1_95)
keep feature highlights alongside subsequent patch fixes. These inform the
presentation, not Silip's version selection or feature claims.

## Release Sources

GitHub Releases on [P4-aaaul/Silip](https://github.com/P4-aaaul/Silip) is the only
publication. Build each target once; release metadata retains the full source SHA
and artifact hashes. Tokens belong only to publishing, never the distributed
Browser/App. There is no release mirror.

## Public Release Baseline

The declared `v1.0.0` release starts the compatibility promise above. Its packages,
reviewed notes and descriptors are immutable. Subsequent releases preserve this
baseline through compatible upgrades; the remaining physical device/network
limits stay in [verification status](../verification-status.md).

## References

- [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html): release meaning follows a
  declared public API; build metadata does not determine precedence.
- [Syncthing releases](https://docs.syncthing.net/users/releases.html) and
  [BEP](https://docs.syncthing.net/specs/bep-v1.html): product versions, peer
  protocol and storage/upgrade behavior are distinct. Silip does not adopt its
  minor-release REST-breaking exception for the protected interfaces above.
- [Go compatibility](https://go.dev/doc/go1compat): name the protected contract
  and its limits instead of promising universal binary/runtime compatibility.
- [Debug Adapter Protocol evolution](https://microsoft.github.io/debug-adapter-protocol/overview.html):
  stable baseline messages and explicit optional capabilities allow independent
  endpoints to evolve. Silip uses that principle within its existing WebSocket/JSON
  contracts; it does not replace them with DAP or a generic negotiation framework.
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) provides
  the small release-intent vocabulary; standard SemVer libraries perform ordering.
- Apple's [bundle build version](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)
  and [release version](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)
  are numeric; package generation derives both from the release and keeps SHA separately.
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases): release
  endpoints and metadata used by the publisher.
