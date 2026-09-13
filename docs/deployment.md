# Application Release And Recovery

This file owns routine immutable application releases. Initial service setup is
in [self-hosting operations](./operations/self-hosting.md); environment and ports
are in [configuration reference](./reference/configuration.md). Exact production
identity is owned by the immutable release descriptor, runtime `REVISION`, and
deployment record. [Status](./status.md) owns only the compact current product
and operational snapshot; it is not a per-release ledger.

The tracked `release-app.sh` updates an existing Go deployment with embedded
media, bare-metal nginx, nftables, and application port 8787. It requires an
existing running Go release. Another proxy, firewall owner, application port,
first installation, or initial embedded-media cutover needs its own scoped
bootstrap/updater; do not call this wrapper generic.
Its firewall check compares the nftables ruleset without traffic counters; it
does not depend on a particular table name. Coordinate other firewall writers
outside the cutover window. See [nft output options](https://netfilter.org/projects/nftables/manpage.html).

## Release Boundary

A routine application release changes only the built Piik server binary and
the Browser assets it embeds. It does not change infrastructure,
service units, proxy/firewall rules, secrets, media listener configuration, or
persistent room state.

Any task that touches one of those excluded surfaces must first record its exact
pre-change value and a recovery procedure for that surface. Do not complicate the
routine application wrapper with one-off infrastructure branches.

The pre-cutover application release is guaranteed only through bounded health
and postflight. It has no retention contract afterward and is not a maintained
backup; Git and immutable artifacts own history.

## Build Host

Start from a clean exact revision with Node.js 24, npm 11, and Go 1.26:

```sh
npm ci
npm run check
node scripts/package-app-release.mjs <output-directory-outside-repository>
```

The packager refuses a dirty tree, builds the Browser assets and the
linux/amd64 server binary from that exact revision without cgo, records the
full revision, emits a runtime archive plus path/size/SHA-256 manifest and release descriptor, and
extracts its own artifact to verify it. The archive contains exactly
`piik-server`, `LICENSE`, `THIRD-PARTY-NOTICES.txt`, and `REVISION`. Upload
the archive, manifest, and descriptor together to `/opt/piik/uploads`.

Public Release pages expose the runnable packages and put package checksums in
the release body. Retain the original complete build output outside the checkout
for later managed deployment or mirror retries: descriptors and manifests are
available in CI artifacts for 14 days and are not public Release attachments.
Do not rebuild an existing published version to replace missing metadata or bytes.

The same application descriptor is also the App assembly input. On each
target platform, provide that platform's Go toolchain:

```sh
PIIK_GO=/path/to/go node scripts/assemble-client.mjs \
  /outside/repository/app-release/piik-<revision>.release.json \
  /outside/repository/piik-app \
  --target windows-amd64 \
  --capture /path/to/platform-capture \
  --tunnel /path/to/cloudflared
```

Assembly refuses a dirty or different revision and emits one directory with the
App executable, the Browser assets taken from that release and embedded in
it, the selected sidecars, notices, and matching `REVISION`. Its required target
is one of `windows-amd64`, `linux-amd64`, or `darwin-arm64`; every supplied
binary input must match it. It does not create an installer, auto-updater,
release tag, or compatibility bundle.

Darwin App assembly runs on macOS with its SDK and cgo enabled: the pinned
LiveKit dependency's [Darwin CPU statistics](https://github.com/mackerelio/go-osstat/blob/v0.2.8/cpu/cpu_darwin_cgo.go)
call Mach APIs. Windows and Linux
App builds keep cgo disabled. A core check on those hosts explicitly skips
the Darwin binaries; macOS build and package verification belong to the existing
native runner. This does not change the cgo-free linux/amd64 Server artifact.

The platform package also carries its native presentation metadata: Windows
embeds the icon in the Go executable, Linux emits a freedesktop desktop entry
under `share/`, and macOS emits a thin `.app` launcher with an ICNS resource.
The latter two are packaging metadata only and do not duplicate the App
executable.

CI and local release-candidate builds use the same wrapper on the target's
native operating system:

```sh
node scripts/package-client-candidate.mjs \
  /outside/repository/app-release \
  windows-amd64 \
  /outside/repository/client-candidate
```

The wrapper downloads the pinned public-link sidecar, verifies its digest,
builds the target App and available capture process, executes every packaged
runtime from the extracted ZIP, and emits one `.zip` plus its SHA-256 file.

Retain the descriptor and successful deployment output as release metadata. Do
not create a follow-up source commit solely to duplicate their revision, asset,
or hashes.

Manual `client_checks=true` dispatch packages Server and three-platform App
candidates after validation. Once [automatic publication](./operations/github.md)
is explicitly enabled, accepted main merges run that same pipeline and publish
the verified artifacts. Candidate artifacts are retained for 14 days. Branches
and PRs do not start cloud CI; no release-record commit is written back to main.
The workflow does not deploy into a running application service.

Do not build or run the full repository check on a constrained production host.
That host runs only the packaged binary and needs no Node, npm, or dependency
install.

## Update Check

Builds carry a product version plus full source revision. Packagers use one
release plan or exact Git tag and inject its identity into Server, App and Web;
untagged local candidates use `development`. Schema-2 package descriptors carry
the same pair and artifact hashes. The [version policy](./reference/versioning.md)
owns ordering and first-public-release readiness.

The default App launcher starts immediately, then checks GitHub Releases in the
background, falling back to the Gitee mirror if GitHub is unavailable. The
[release-source policy](./reference/versioning.md#release-sources) owns selection
and provenance checks. It shows a link only when
the latest stable release is newer, the same version has a known different source
SHA, or a development build can choose the official release. These notices are
distinct; a different SHA alone is not called newer.
The request sends no current revision, credentials, room data, or media data;
network errors, private-repository responses, and missing releases are treated
as no notice. Checking does not download an archive, replace files, or interrupt
a running share; the user can follow the update link to download the App ZIP.

An operator can perform the corresponding read-only Server check:

```sh
bash deploy/check-release.sh
```

The Server also checks once in the background after startup and logs an available
release with its download URL. It does not delay startup, periodically poll,
notify room participants or install anything.

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
  bash /path/to/repository/deploy/release-app.sh \
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
