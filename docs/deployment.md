# Server Release And Recovery

Use this runbook to update an existing Server from an immutable package.
For first installation, see [self-hosting](./operations/self-hosting.md); for
settings and ports, see [configuration](./standards/configuration.md).
Record exact deployment identity in the release descriptor, runtime `REVISION`
and operator deployment record.

The tracked `release-server.sh` updates an existing Go deployment with embedded
media, bare-metal nginx, nftables, and application port 8787. It requires an
existing running Go release. Other proxies, firewalls or application ports,
first installations and initial embedded-media cutovers need a scoped updater.
Its firewall check compares the nftables ruleset without traffic counters; it
does not depend on a particular table name. Coordinate other firewall writers
outside the cutover window. See [nft output options](https://netfilter.org/projects/nftables/manpage.html).

## Release Boundary

A routine Server release replaces the binary and its embedded Browser assets.
Keep infrastructure, service units, proxy/firewall rules, secrets, media listener
configuration and persistent room state unchanged. If the task changes any of
these, record its exact pre-change value and recovery procedure first, and use
a scoped updater rather than extending the routine wrapper with one-off branches.

Retain the pre-cutover release through bounded health and postflight checks.
Retention ends afterward; maintain any required backups separately.

## Build Host

Start from a clean exact revision using Node from [`.node-version`](../.node-version),
npm from [`package.json`](../package.json), and Go from [`go.mod`](../go.mod):

```sh
npm ci
npm run check
node scripts/package-server-release.mjs <output-directory-outside-repository>
```

The packager refuses a dirty tree, builds the Browser assets and the
linux/amd64 server binary (or linux/arm64 with `--arch arm64`) from that exact revision without cgo, records the
full revision, emits a runtime archive plus path/size/SHA-256 manifest and release descriptor, and
extracts its own artifact to verify it. The archive contains exactly
`piik-server`, `LICENSE`, `THIRD-PARTY-NOTICES.txt`, and `REVISION`. Upload
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

The same Server descriptor is also the App assembly input. On each
target platform, provide that platform's Go toolchain:

```sh
PIIK_GO=/path/to/go node scripts/assemble-app.mjs \
  /outside/repository/server-release/piik-<revision>.release.json \
  /outside/repository/piik-app \
  --target windows-amd64 \
  --capture /path/to/platform-capture \
  --tunnel /path/to/cloudflared
```

Assembly refuses a dirty or different revision and emits one directory with the
App executable, the Browser assets taken from that release and embedded in
it, the selected sidecars, notices, and matching `REVISION`. Its required target
is one of `windows-amd64`, `linux-amd64`, `linux-arm64`, `darwin-arm64` or `darwin-amd64`; every supplied
binary input must match it.

Darwin App assembly runs on macOS with its SDK and cgo enabled: the pinned
LiveKit dependency's [Darwin CPU statistics](https://github.com/mackerelio/go-osstat/blob/v0.2.8/cpu/cpu_darwin_cgo.go)
call Mach APIs. Windows and Linux
App builds keep cgo disabled. A core check on those hosts explicitly skips
the Darwin binaries; macOS build and package verification belong to the existing
native runner. Server builds for both Linux architectures remain cgo-free.

The platform package also carries its native presentation metadata: Windows
embeds the icon in the Go executable, Linux emits a freedesktop desktop entry
under `share/`, and macOS emits a self-contained `.app` with an ICNS resource.
The macOS `CFBundleExecutable` names the real Mach-O App binary in
`Contents/MacOS`; its relative `runtime/`, license notices and `REVISION` live
beside it. Keep every runtime dependency inside the relocated `.app`, following
[Apple's bundle relocation guidance](https://developer.apple.com/forums/thread/724969).
Package checks execute the extracted entry and helpers. Check Finder/Gatekeeper
and desktop permissions separately on macOS.

CI and local release-candidate builds use the same wrapper on the target's
native operating system:

```sh
node scripts/package-app-candidate.mjs \
  /outside/repository/server-release \
  windows-amd64 \
  /outside/repository/app-candidate
```

The wrapper downloads the pinned public-link sidecar, verifies its digest,
builds the target App and available capture process, executes every packaged
runtime from the extracted ZIP, and emits one `.zip` plus its SHA-256 file.

App ZIPs use ordinary Store/Deflate compression and relative entry names without
`.` or `..` path segments; include hidden files and preserve executable modes on
Unix. Windows packaging also checks every entry through Windows Explorer's ZIP
reader.

Retain the descriptor and successful deployment output as release metadata,
rather than copying revisions, asset names and hashes into source commits.

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

The App launcher starts immediately and checks GitHub Releases in the background,
using Gitee if GitHub is unavailable. It offers a download link for a newer
stable version, a known different build of the same version, or an official
release for a development build. These notices use distinct labels.
The check follows the [release-source policy](./standards/versioning.md#release-sources)
and sends no current revision, credentials, room data or media data. An unavailable
check produces no notice. Downloading and replacing the App remain manual;
checking leaves the running share active.

An operator can perform the corresponding read-only Server check:

```sh
bash deploy/check-release.sh
```

The Server checks once in the background after startup and logs any available
release and download URL. Updates remain manual; room participants receive no notice.

The script runs the deployed binary's `--check-release`, using that binary's
injected identity, and prints one JSON result with versions, available source
SHAs and the release URL. Exit `0` means no newer/different official build,
`10` means `update-available`, `different-build` or `official-release`, and `20`
means the check is unavailable. It does not accept a separate revision file.
For a private repository, inject a short-lived `GITHUB_TOKEN`
through the operator environment; never place it in the repository or command
line. The command does not mutate files, services, containers, or persistent
state.

## Atomic Cutover

The wrapper requires an already running packaged Go release and the service
layout described above. For a new installation, use the
[self-hosting guide](./operations/self-hosting.md). Infrastructure changes need
their own scoped recovery procedure under [CONTRIBUTING](../CONTRIBUTING.md).

Run the tracked server entry with the uploaded descriptor:

```sh
sudo env PIIK_PUBLIC_ORIGIN=https://share.example.com \
  bash /path/to/repository/deploy/release-server.sh \
  /opt/piik/uploads/piik-<revision>.release.json
```

The wrapper:

1. takes a deployment lock and validates the descriptor, revision, archive,
   manifest, current Go process, Piik/nginx service state, and public origin;
2. rejects unexpected archive paths, links, file types, or duplicate inodes;
3. extracts to a new release directory and verifies every file hash and size;
4. validates production configuration by running the packaged binary's
   configuration check as the service user under a bounded runtime;
5. proves the old and new releases share no regular-file inode;
6. atomically switches `/opt/piik/current`, starts the service, and polls
   bounded local/public health; and
7. restores the exact prior symlink and service when cutover or health fails.

Never hard-link release files or recursively mutate permissions before the
inode audit: metadata changes would violate both releases. Expected service
states should be read as data (`systemctl show`), not used as bare commands under
strict-shell error traps.

## Persistent State

Stable mode stores only room authority at the configured SQLite path. The
systemd service owns its state directory and file permissions. Application
restart retains room ownership, invitations, policy and password verifier;
participants, signaling, routes, SFU state and media reconnect from fresh
process state.

Lightweight mode has no persistent room state and starts empty. A release does
not add a migration or compatibility reader for either mode; current exact
schema validation fails closed before accepting signaling or media admission.

## Postflight

Verify only the surfaces relevant to the release:

- local and public `/healthz` return `{"status":"ok"}`;
- the public HTML references the new immutable main asset;
- Piik and nginx have expected active/restart state;
- Piik owns each configured STUN/SFU UDP listener and public reachability
  matches the configuration;
- the current symlink and served revision match the descriptor;
- room creation, Host authentication, one direct Viewer, and configured SFU
  fallback complete the scoped smoke; and
- infrastructure, config, secrets, ports, and persistent state not named by the
  task are unchanged.

For broader network, platform and capacity results, see [verification status](./verification-status.md).

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
