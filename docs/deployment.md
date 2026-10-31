# Server Release And Recovery

This file owns routine immutable Server releases. The Rust runtime's environment
is described in [Server startup](../prototype/channel-server/README.md#run);
[systemd](../deploy/systemd/piik.service.example) and
[container](../deploy/container/compose.yaml) examples consume that configuration. Exact production
identity is owned by the immutable release descriptor, runtime `REVISION`, and
deployment record. [Status](./status.md) owns only the compact current product
and operational snapshot; it is not a per-release ledger.

This branch packages the isolated Rust 3.0 runtime. The tracked
`release-server.sh` updates an existing Rust deployment with bare-metal nginx,
nftables, and application port 8787. The 2.x-to-3.0 cutover is a separate release
phase. Another proxy, firewall owner, application port or first installation needs its own scoped
bootstrap/updater; do not call this wrapper generic.
Its firewall check compares the nftables ruleset without traffic counters; it
does not depend on a particular table name. Coordinate other firewall writers
outside the cutover window. See [nft output options](https://netfilter.org/projects/nftables/manpage.html).

## Release Boundary

A routine Server release changes only the built Piik server binary and
its sibling `web/` bundle. It does not change infrastructure,
service units, proxy/firewall rules, secrets, media listener configuration, or
persistent room state.

Any task that touches one of those excluded surfaces must first record its exact
pre-change value and a recovery procedure for that surface. Do not complicate the
routine Server wrapper with one-off infrastructure branches.

The pre-cutover Server release is guaranteed only through bounded health
and postflight. It has no retention contract afterward and is not a maintained
backup; Git and immutable artifacts own history.

## Build Host

Start from a clean exact revision using Node from [`.node-version`](../.node-version),
npm from [`package.json`](../package.json), Rust 1.91 with the
`wasm32-unknown-unknown` target, wasm-bindgen CLI 0.2.129 and cargo-about 0.9.3:

Linux Server builds also require the matching musl Rust target, a musl C compiler
and binutils. The Server archive is static; Linux App builds use GNU/GStreamer.

```sh
npm ci
npm run check
node scripts/package-server-release.mjs <output-directory-outside-repository>
```

The packager refuses a dirty tree, builds the Browser assets and the
native server binary (or linux/arm64 with `--arch arm64`) from that exact revision, records the
full revision, emits a runtime archive plus path/size/SHA-256 manifest and release descriptor, and
extracts its own artifact to verify it. The archive contains
`piik-server`, `web/`, `LICENSE`, `THIRD-PARTY-NOTICES.txt`, and `REVISION`. Upload
the archive, manifest, and descriptor together to `/opt/piik/uploads`.
ARM64 file names include `-linux-arm64` after the revision; x64 names stay
unchanged. The deployment wrapper rejects a package for another host architecture.

`--os windows --arch amd64` packages the same Server core as
`piik-<revision>-windows-amd64-runtime.zip`, with `piik-server.exe` in place of the
Linux executable. It uses the same descriptor and checksum inventory; containers
and `release-server.sh` remain Linux-only. Windows operation follows the
[self-hosting guide](./operations/self-hosting.md).

Public Release pages expose the runnable packages and put package checksums in
the release body. Retain the original complete build output outside the checkout
for later managed deployment or mirror retries: descriptors and manifests are
available in CI artifacts for 14 days and are not public Release attachments.
Do not rebuild an existing published version to replace missing metadata or bytes.

Server and App share build identity and the frontend builder. App assembly runs
on its target platform and builds the Rust runtime with capture enabled:

```sh
node scripts/assemble-app.mjs \
  /outside/repository/piik-app \
  --target windows-amd64 \
  --tunnel /path/to/cloudflared
```

Assembly refuses a dirty or different revision and emits one directory with the
App executable, its sibling `web/`, the public-link helper, notices, and matching
`REVISION`. Its required target
is one of `windows-amd64`, `linux-amd64`, `linux-arm64`, `darwin-arm64` or `darwin-amd64`; every supplied
binary input must match it. It does not create an installer, auto-updater,
release tag, or compatibility bundle.

macOS App assembly requires its native SDK. Linux App assembly requires the
distribution's GStreamer development libraries and runtime plugins. The
forwarding-only Server builds without capture or transcoding dependencies.

The platform package also carries its native presentation metadata: Windows
embeds the existing icon resource in the Rust executable, Linux emits a freedesktop desktop entry
under `share/`, and macOS emits a self-contained `.app` with an ICNS resource.
The macOS `CFBundleExecutable` names the real Mach-O App binary in
`Contents/MacOS`; its relative `runtime/`, license notices and `REVISION` live
beside it. Moving the `.app` must retain every runtime dependency. This follows
[Apple's bundle relocation guidance](https://developer.apple.com/forums/thread/724969)
and avoids a shell entry that reaches outside the bundle. Package checks execute
the extracted entry and helpers; Finder/Gatekeeper and desktop permissions still
need macOS acceptance.

CI and local release-candidate builds use the same wrapper on the target's
native operating system:

```sh
node scripts/package-app-candidate.mjs \
  windows-amd64 \
  /outside/repository/app-candidate
```

The wrapper downloads the pinned public-link sidecar, verifies its digest,
builds the target App with its integrated capture adapter, executes every packaged
runtime from the extracted ZIP, and emits one `.zip` plus its SHA-256 file.

App ZIPs use ordinary Store/Deflate compression and relative entry names without
`.` or `..` path segments; include hidden files and preserve executable modes on
Unix. Windows packaging also checks every entry through Windows Explorer's ZIP
reader. A successful extraction by the writer's own library does not establish
compatibility with the user's default archive tool.

Retain the descriptor and successful deployment output as release metadata. Do
not create a follow-up source commit solely to duplicate their revision, asset,
or hashes.

Manual `app_checks=true` dispatch packages both Server architectures and all App
candidates after validation. Once [automatic publication](./operations/github.md)
is explicitly enabled, accepted main merges run that same pipeline and publish
the verified artifacts. Candidate artifacts are retained for 14 days. Ordinary
branch pushes stay quiet; PRs run only the read-only release-note check. No
release-record commit is written back to main.
The workflow does not deploy into a running application service.

Do not build or run the full repository check on a constrained production host.
That host runs only the packaged binary and needs no Node, npm, or dependency
install.

## Update Check

Builds carry a product version plus full source revision. Packagers use one
release plan or exact Git tag and inject its identity into Server, App and Web;
untagged local candidates use `development`. Schema-2 package descriptors carry
the same pair and artifact hashes. The [version policy](./standards/versioning.md)
owns ordering and first-public-release readiness.

The default App launcher starts immediately, then checks GitHub Releases in the
background, falling back to the Gitee mirror if GitHub is unavailable. The
[release-source policy](./standards/versioning.md#release-sources) owns selection
and provenance checks. It shows a link only when
the latest stable release is newer, the same version has a known different source
SHA, or a development build can choose the official release. These notices are
distinct; a different SHA alone is not called newer.
The request sends no current revision, credentials, room data, or media data;
network errors, private-repository responses, and missing releases are treated
as no notice. Checking does not download an archive, replace files, or interrupt
a running share; the user can follow the update link to download the App package.

The Rust Server's operator release check remains in [TODO](./todo.md).

## Atomic Cutover

The wrapper requires an already running packaged Rust release and the service
layout described above. A new installation uses the matching service or container
example. Infrastructure changes need
their own scoped recovery procedure under [CONTRIBUTING](../CONTRIBUTING.md).

Run the tracked server entry with the uploaded descriptor:

```sh
sudo env PIIK_PUBLIC_ORIGIN=https://share.example.com \
  bash /path/to/repository/deploy/release-server.sh \
  /opt/piik/uploads/piik-<revision>.release.json
```

The wrapper:

1. takes a deployment lock and validates the descriptor, revision, archive,
   manifest, current process, Piik/nginx service state, and public origin;
2. rejects unexpected archive paths, links, file types, or duplicate inodes;
3. extracts to a new release directory and verifies every file hash and size;
4. verifies the executable, bundled frontend and required runtime libraries;
5. proves the old and new releases share no regular-file inode;
6. atomically switches `/opt/piik/current`, starts the service, and polls
   bounded local/public health; and
7. restores the exact prior symlink and service when cutover or health fails.

Never hard-link release files or recursively mutate permissions before the
inode audit: metadata changes would violate both releases. Expected service
states should be read as data (`systemctl show`), not used as bare commands under
strict-shell error traps.

## Persistent State

`PIIK_CHANNEL_DATA_DIR` owns the Server's domain catalog and room databases;
the [room-data model](./research/channel-storage-and-identity.md) owns their
contents. The systemd service owns that directory and its permissions. These
files stay outside immutable runtime releases. Restart restores saved identities,
room policy and confirmed history; live participants, routes and media reconnect.

## Postflight

Verify only the surfaces relevant to the release:

- local and public `/healthz` return `piik-channel-prototype`;
- the public HTML references the new immutable main asset;
- Piik and nginx have expected active/restart state;
- the selected media path completes the release's network smoke;
- the current symlink and served revision match the descriptor;
- domain admission, room hosting and selected media complete the scoped smoke; and
- infrastructure, config, secrets, ports, and persistent state not named by the
  task are unchanged.

Representative network, mobile, audio, 20-Viewer, and endurance evidence belongs
to [verification status](./verification-status.md), not routine postflight.

## Recovery

Before cutover, the wrapper keeps the exact prior release path. On failure after
the switch begins, it stops Piik, restores that path atomically, restarts the
service, and waits for health. A failed recovery exits distinctly and requires
operator intervention; it must not silently report the new release as active.

Infrastructure or persistent-state recovery is separate and limited to the
surfaces changed by that task. Do not restore an entire server, old firewall, or
old secret set for an application-only failure.

If a task changes persistent room data, prepare and verify a separate
[SQLite backup](https://www.sqlite.org/backup.html) and recover matching data,
configuration and application together. Restoring old data can revive revoked
credentials; account for later authority changes before reopening ingress.
