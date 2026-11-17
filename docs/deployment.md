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

## Managed One-click Hosting

Reviewed 2026-11-17. Vercel can serve Web assets, and its
[WebSocket support is now generally available](https://vercel.com/changelog/websocket-support-is-now-generally-available).
That does not make the current Piik Server a stateless Function: it owns a live
site authority, durable SQLite files and Native UDP transport. Its fixed UDP
media entry must be reachable separately from HTTP/WebSocket; an accessible
HTTP tunnel or an offered forwarding capability does not prove media
connectivity. The [Server startup reference](../prototype/channel-server/README.md#public-origin-and-udp)
owns these listener settings. Functions have
[bounded invocation lifetimes](https://vercel.com/docs/functions/limitations)
and a [read-only filesystem with temporary scratch space](https://vercel.com/docs/functions/runtimes).
The newer [Daemons beta](https://vercel.com/docs/daemons#what-does-the-daemons-beta-support)
also has ephemeral storage.

A Vercel-hosted frontend would still need an externally running Piik Server
with matching assets, origin admission and persistent data. A static copy of the
marketing website is not a Piik deployment. Do not expose a one-click Server
button until its ordinary room, restart and peer-transfer flows run on the
chosen hosting model. The existing Server archive and Compose service remain
the supported starting points; use a persistent host rather than changing the
room model to fit a hosting badge.

### Fly.io Candidate

The [Fly configuration](../deploy/fly/fly.toml.example) reuses the existing Server
image with one always-running Machine and one persistent data volume. It remains
an acceptance candidate: no Fly deployment, public UDP path or recovery on Fly
has been verified. The initial CPU, memory and disk sizes are starting values,
not a capacity guarantee.

[Fly UDP](https://docs.fly.io/networking/udp-and-tcp) requires a dedicated IPv4,
the `fly-global-services` bind address and equal internal/external ports. The
template keeps HTTP on `0.0.0.0:8787` and UDP on that alias at port 8787. Server's
public UDP address is the allocated IPv4 and the same port. HTTPS/WebSocket
traffic uses Fly's HTTP service; media uses the separate UDP service.

For an authorized isolated trial, copy the template outside the checkout as
`fly.toml` and configure it using the [Fly reference](https://docs.fly.io/reference/configuration):

1. Choose the app name and region, and pin a matching 3.0 image containing UDP
   hostname binding support. Keep its digest for recovery; `latest` may still
   select 2.x. Image publication remains a separate release action.
2. Create the app with `fly apps create <app-name>`, then allocate its dedicated
   IPv4 with `fly ips allocate-v4 --app <app-name>`. These create paid resources;
   account for compute, volume, address and transfer charges for the chosen region.
   Replace the template's documentation-only IP with that address.
3. Set the exact public HTTPS origin, normally `https://<app-name>.fly.dev`.
   Import a private owner seed as `PIIK_CHANNEL_OWNER_KEY` using
   [`fly secrets import --stage --app <app-name>`](https://docs.fly.io/flyctl/cmd/fly_secrets_import)
   from private stdin; keep credentials out of the template and shell history.
4. Run `fly deploy --config /path/to/fly.toml --ha=false`. This uses the chosen
   image and creates the configured volume on first deployment. Verify that
   exactly one Machine has the volume attached. Keep that single authority;
   extra independent volumes do not replicate a site. Updates use the ordinary
   rolling strategy and briefly disconnect the single Machine's participants.

The persistent mount retains the image's `/home/nonroot` data location and
UID/GID 65532. Fly's writable ephemeral root supplies `/tmp` for backup and
restore staging; durable data never belongs there. Verify a room backup/restore
to establish both directories' actual permissions before acceptance.
[Fly Volumes](https://docs.fly.io/volumes/overview) survive restarts and deployments
but remain tied to their physical host. Keep private independent backups; provider
snapshots alone do not establish recovery.

Acceptance requires public health and matching Web assets, an ordinary room with
conversation and picture/sound or file transfer through the Server's UDP path,
and retained identity, room policy and history after Machine restart and image
replacement. Exercise backup/restore as well as reopening the same volume.
Record the image digest, volume and configuration before replacement; application
recovery redeploys that image with the same volume and secrets. Data recovery uses
the separately verified backup procedure below. Local Server checks do not prove
the provider's mount permissions, UDP ingress or room lifecycle.

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
[Rust Server startup reference](../prototype/channel-server/README.md#run).

Public Release pages expose the runnable packages and put package checksums in
the release body. Updater-capable releases also expose the signed metadata defined
by [versioning](./standards/versioning.md#app-download-and-installation).
Retain the original complete build output outside the checkout
for later managed deployment or mirror retries: descriptors and manifests are
available in CI artifacts for 14 days and are not public Release attachments.
Do not rebuild an existing published version to replace missing metadata or bytes.

Server and App share build identity and the frontend builder.

To reuse one frontend across matched targets, build it once with
`npm run build:web` from the clean revision and chosen `PIIK_BUILD_VERSION`.
The builder writes `build/channel-web.build.json` beside the Web directory,
containing that version, revision and every file's path, size and SHA-256.
Copy the directory and its adjacent receipt together. App assembly, App candidate
packaging, Server packaging and `build-android.mjs` accept
`--web /path/to/channel-web`; all use the same complete-tree and linked-asset
validation. A mismatched or incomplete input fails instead of rebuilding.
Inputs overlapping that entry point's replaced build directories are rejected
before cleanup, including paths reached through links.
Without `--web`, each entry retains its ordinary build path. Dirty development
builds remain usable locally but do not receive a reusable receipt. Reusing Web
bytes does not satisfy the separate Native or package runtime checks.

App assembly runs on its target platform and builds the Rust runtime with
capture enabled:

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
binary input must match it. Windows assembly embeds the bundle layout and the
configured update public key; the [signing procedure](./operations/github.md#app-update-signing)
owns publisher inputs. Assembly does not create an installer, release tag or
compatibility bundle.

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

Existing assembled or extracted App directories can be inspected independently:

```sh
node scripts/check-app-package.mjs static windows-amd64 /path/to/package <version> <full-revision>
node scripts/check-app-package.mjs runtime windows-amd64 /path/to/package <version> <full-revision>
```

The static check verifies package contents, executable architecture, notices and
Web source identity without launching bundled binaries. Its result explicitly
reports runtime as `not-run`; compiled build identity still needs the runtime
check. Runtime checking uses an isolated data directory and the same native
startup/shutdown checks as candidate packaging. Neither independent check writes
release metadata. The candidate wrapper always requires both before emitting
its release descriptor; restricted environments may inspect assembly output
without claiming runtime acceptance.

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

The App launcher and site App control check the installed App's identity in the
background, using GitHub and the AtomGit fallback under the
[release-source policy](./standards/versioning.md#release-sources). That policy
owns provenance, version comparison and the distinction between a newer release
and a different build.

The Rust Server provides a [one-shot operator check](../prototype/channel-server/README.md#run)
and one non-blocking startup notice for released builds. Checks fetch metadata
only; they do not install an update, replace files or interrupt a running share.

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
- site identity, room admission/hosting and selected media complete the scoped smoke; and
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
