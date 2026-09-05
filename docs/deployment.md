# Application Release And Recovery

This file owns routine immutable application releases. Initial service setup is
in [self-hosting operations](./operations/self-hosting.md); environment and ports
are in [configuration reference](./reference/configuration.md). Exact production
identity is owned by the immutable release descriptor, runtime `REVISION`, and
deployment record. [Status](./status.md) owns only the compact current product
and operational snapshot; it is not a per-release ledger.

The tracked `release-app.sh` is the updater for the current bare-metal nginx,
LiveKit, coturn, nftables, and local-port-8787 deployment. It requires an
existing current release. Another proxy, optional-LiveKit shape, firewall owner,
application port, or first installation needs its own scoped bootstrap/updater;
do not call this wrapper generic.

## Release Boundary

A routine application release changes only the built Screener client/server and
its independent runtime dependency tree. It does not change infrastructure,
service units, proxy/firewall rules, secrets, LiveKit/coturn configuration, or
persistent room state.

Any task that touches one of those excluded surfaces must first record its exact
pre-change value and a recovery procedure for that surface. Do not complicate the
routine application wrapper with one-off infrastructure branches.

The pre-cutover application release is guaranteed only through bounded health
and postflight. It has no retention contract afterward and is not a maintained
backup; Git and immutable artifacts own history.

## Build Host

Start from a clean exact revision with Node.js 24 and npm 11:

```sh
npm ci
npm run check
node scripts/package-app-release.mjs <output-directory-outside-repository>
```

The packager refuses a dirty tree, builds from that exact revision, records the
full revision, emits a runtime archive plus path/size/SHA-256 manifest and release descriptor, and
extracts its own artifact to verify it. Upload the archive, manifest, and
descriptor together to `/opt/screener/uploads`.

The same application descriptor is also the Client assembly input. On each
target platform, provide that platform's Node executable and Go toolchain:

```sh
SCREENER_GO=/path/to/go node scripts/assemble-client.mjs \
  /outside/repository/app-release/screener-<revision>.release.json \
  /path/to/node \
  /outside/repository/Screener-Client \
  --target windows-amd64 \
  --capture /path/to/platform-capture \
  --tunnel /path/to/cloudflared
```

Assembly refuses a dirty or different revision and emits one directory with
the Client executable, pinned Node runtime, application release, selected
sidecars, production dependencies, and matching `REVISION`. Its required target
is one of `windows-amd64`, `linux-amd64`, or `darwin-arm64`; every supplied
runtime must match it. It does not create an installer, auto-updater, release
tag, or compatibility bundle.

The platform package also carries its native presentation metadata: Windows
embeds the icon in the Go executable, Linux emits a freedesktop desktop entry
under `share/`, and macOS emits a thin `.app` launcher with an ICNS resource.
The latter two are packaging metadata only and do not duplicate the Client or
Node runtime.

CI and local release-candidate builds use the same wrapper on the target's
native operating system:

```sh
node scripts/package-client-candidate.mjs \
  /outside/repository/app-release \
  windows-amd64 \
  /outside/repository/client-candidate
```

The wrapper downloads the pinned public-link sidecar, verifies its digest,
builds the target Client and available capture process, executes every packaged
runtime, and emits one `tar.gz` plus its SHA-256 file.

Retain the descriptor and successful deployment output as release metadata. Do
not create a follow-up source commit solely to duplicate their revision, asset,
or hashes.

After `validate` succeeds on a push to `main`, CI packages this application
release once and uses it to assemble Windows amd64, Linux amd64, and macOS arm64
Client candidates on native runners. Each Client artifact contains one native
archive and its SHA-256 file; Actions retains candidates for 14 days. This is
automatic build output, not a tag, public GitHub Release, or deployment.

Do not build or run the full repository check on a constrained production host.
The release wrapper installs only production dependencies in a transient,
CPU/memory/time-bounded unit.

## Update Check

The application, Server deployment, and platform Client all use the full Git
revision as their release identity. A formal GitHub Release must use that exact
40-character revision as its tag and keep the corresponding release URL. The
current CI workflow produces short-lived candidates but does not publish a
GitHub Release; publication remains an explicit distribution decision.

The default Client launcher starts immediately, then performs one background
request to the official Screener GitHub Releases API. It shows a link only when
the latest release has a valid full revision different from the packaged one.
The request sends no current revision, credentials, room data, or media data;
network errors, private-repository responses, and missing releases are treated
as no notice. It never downloads, replaces, or interrupts a running share.

An operator can perform the corresponding read-only Server check:

```sh
SCREENER_NODE=/usr/local/bin/node bash deploy/check-release.sh
```

The command reads `/opt/screener/current/REVISION` and prints one JSON result.
Exit status `0` means the deployed revision is current, `10` means a newer
release is available, and `20` means the check could not establish a valid
release identity. For a private repository, inject a short-lived `GITHUB_TOKEN`
through the operator environment; never place it in the repository or command
line. The command does not mutate files, services, containers, or persistent
state. A different current-revision file may be supplied as its only argument.

## Atomic Cutover

Run the tracked server entry with the uploaded descriptor:

```sh
sudo env SCREENER_PUBLIC_ORIGIN=https://share.example.com \
  bash /path/to/repository/deploy/release-app.sh \
  /opt/screener/uploads/screener-<revision>.release.json
```

The wrapper:

1. takes a deployment lock and validates the descriptor, revision, archive,
   manifest, current release, required services, and public origin;
2. rejects unexpected archive paths, links, file types, or duplicate inodes;
3. extracts to a new release directory and verifies every file hash and size;
4. installs an independent `node_modules` tree under resource limits and checks
   runtime imports plus production configuration;
5. proves the old and new releases share no regular-file inode;
6. atomically switches `/opt/screener/current`, starts the service, and polls
   bounded local/public health; and
7. restores the exact prior symlink and service when cutover or health fails.

Never hard-link dependency trees or recursively mutate permissions before the
inode audit: metadata changes would violate both releases. Expected service
states should be read as data (`systemctl show`), not used as bare commands under
strict-shell error traps.

## Persistent State

Stable mode stores only room authority at the configured SQLite path. The
systemd service owns its state directory and file permissions. Application
restart retains room ownership, invitations, policy, password verifier, and
lease; participants, signaling, routes, SFU state, and media reconnect from fresh
process state.

Lightweight mode has no persistent room state and starts empty. A release does
not add a migration or compatibility reader for either mode; current exact
schema validation fails closed before signaling or LiveKit mutation.

## Postflight

Verify only the surfaces relevant to the release:

- local and public `/healthz` return `{"status":"ok"}`;
- the public HTML references the new immutable main asset;
- Screener, nginx, coturn, and LiveKit have expected active/restart
  state;
- the current symlink and served revision match the descriptor;
- room creation, Host authentication, one direct Viewer, and configured SFU
  fallback complete the scoped smoke; and
- infrastructure, config, secrets, ports, and persistent state not named by the
  task are unchanged.

Representative network, mobile, audio, 20-Viewer, and endurance evidence belongs
to [verification status](./verification-status.md), not routine postflight.

## Recovery

Before cutover, the wrapper keeps the exact prior release path. On failure after
the switch begins, it stops Screener, restores that path atomically, restarts the
service, and waits for health. A failed recovery exits distinctly and requires
operator intervention; it must not silently report the new release as active.

Infrastructure or persistent-state recovery is separate and limited to the
surfaces changed by that task. Do not restore an entire server, old firewall, or
old secret set for an application-only failure.
