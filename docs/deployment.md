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

## Release Boundary

A routine application release changes only the built Screener server binary and
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
`screener-server`, `LICENSE`, `THIRD-PARTY-NOTICES.txt`, and `REVISION`. Upload
the archive, manifest, and descriptor together to `/opt/screener/uploads`.

The same application descriptor is also the Client assembly input. On each
target platform, provide that platform's Go toolchain:

```sh
SCREENER_GO=/path/to/go node scripts/assemble-client.mjs \
  /outside/repository/app-release/screener-<revision>.release.json \
  /outside/repository/Screener-Client \
  --target windows-amd64 \
  --capture /path/to/platform-capture \
  --tunnel /path/to/cloudflared
```

Assembly refuses a dirty or different revision and emits one directory with the
Client executable, the Browser assets taken from that release and embedded in
it, the selected sidecars, notices, and matching `REVISION`. Its required target
is one of `windows-amd64`, `linux-amd64`, or `darwin-arm64`; every supplied
binary input must match it. It does not create an installer, auto-updater,
release tag, or compatibility bundle.

Darwin Client assembly runs on macOS with its SDK and cgo enabled: the pinned
LiveKit dependency's [Darwin CPU statistics](https://github.com/mackerelio/go-osstat/blob/v0.2.8/cpu/cpu_darwin_cgo.go)
call Mach APIs. Windows and Linux
Client builds keep cgo disabled. A core check on those hosts explicitly skips
the Darwin binaries; macOS build and package verification belong to the existing
native runner. This does not change the cgo-free linux/amd64 Server artifact.

The platform package also carries its native presentation metadata: Windows
embeds the icon in the Go executable, Linux emits a freedesktop desktop entry
under `share/`, and macOS emits a thin `.app` launcher with an ICNS resource.
The latter two are packaging metadata only and do not duplicate the Client
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
builds the target Client and available capture process, executes every packaged
runtime, and emits one `tar.gz` plus its SHA-256 file.

Retain the descriptor and successful deployment output as release metadata. Do
not create a follow-up source commit solely to duplicate their revision, asset,
or hashes.

After `validate` succeeds on an explicit workflow dispatch with
`client_checks=true`, CI packages the Server application release and the
three-platform Client candidates that consume it. The artifacts are retained
for 14 days. Ordinary `main` pushes do not run these packaging jobs. This
workflow does not create a tag, public GitHub Release, or deployment.

Do not build or run the full repository check on a constrained production host.
That host runs only the packaged binary and needs no Node, npm, or dependency
install.

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
bash deploy/check-release.sh
```

The script runs the deployed binary's release check, which reads
`/opt/screener/current/REVISION` and prints one JSON result.
Exit status `0` means the deployed revision is current, `10` means a newer
release is available, and `20` means the check could not establish a valid
release identity. For a private repository, inject a short-lived `GITHUB_TOKEN`
through the operator environment; never place it in the repository or command
line. The command does not mutate files, services, containers, or persistent
state. A different current-revision file may be supplied as its only argument.

## Permanent-Room Schema Cutover

Schema 2 / signaling `screener-v23` requires matching Web/Client/Server builds
and an accepted active-session interruption. Native control stays v9; Browser
credential keys stay unchanged. This is not an app-only release.

1. Verify the candidate; record the current release, environment, absolute DB
   path and ownership. Stop ingress and the old application; take and retain a
   SQLite backup. Require `application_id=1396920910`, `user_version=1`, expected
   columns and `PRAGMA quick_check='ok'` before touching a separate protected copy.
2. On that copy, use SQLite with `DROP COLUMN` support and stop on SQL errors:

   ```sql
   BEGIN EXCLUSIVE;
   ALTER TABLE rooms DROP COLUMN lease_expires_at_ms;
   PRAGMA user_version = 2;
   COMMIT;
   ```

3. Verify integrity, exact columns/version and equal row counts. Compare retained
   columns in both directions against the backup using `EXCEPT`; both must be
   empty. Record only counts/pass/fail, not private verifiers. The candidate must
   open this copy successfully; no room is dropped because of its former deadline.
4. Retain the absolute `ROOM_DATABASE_PATH`; remove `ROOM_LEASE_SECONDS`. Install
   the verified copy and release while stopped, retaining permissions/ownership.
   Start; check health and Host/Viewer reauthentication before reopening ingress.
5. On failure, stop and restore prior database, environment and release together.
   Once new authority mutations are accepted, restoring the backup could revive
   revoked grants: preserve those changes or make an explicit recovery decision.

The runtime reads only schema 2. SQLite's [column removal](https://www.sqlite.org/lang_altertable.html#altertabdropcol)
and [backup guidance](https://www.sqlite.org/backup.html) define this offline operation.

## Atomic Cutover

### First embedded-media cutover prerequisite

The first move from external services to embedded STUN/SFU is a coordinated
infrastructure and protocol transaction, including Node-to-Go where still
needed. Complete the [self-hosting cutover procedure](./operations/self-hosting.md#coordinated-embedded-media-cutover)
with matching Web/Server signaling and native protocol v9 Client builds,
accepted active-session interruption, released UDP ports, and exact
unit/environment/proxy/service recovery. The routine wrapper does not perform
that transaction; it requires an already running packaged Go release and cannot
restore the previous infrastructure.

Run the tracked server entry with the uploaded descriptor:

```sh
sudo env SCREENER_PUBLIC_ORIGIN=https://share.example.com \
  bash /path/to/repository/deploy/release-app.sh \
  /opt/screener/uploads/screener-<revision>.release.json
```

The wrapper:

1. takes a deployment lock and validates the descriptor, revision, archive,
   manifest, current Go process, Screener/nginx service state, and public origin;
2. rejects unexpected archive paths, links, file types, or duplicate inodes;
3. extracts to a new release directory and verifies every file hash and size;
4. validates production configuration by running the packaged binary's
   configuration check as the service user under a bounded runtime;
5. proves the old and new releases share no regular-file inode;
6. atomically switches `/opt/screener/current`, starts the service, and polls
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
- Screener and nginx have expected active/restart state;
- Screener owns each configured STUN/SFU UDP listener and public reachability
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
the switch begins, it stops Screener, restores that path atomically, restarts the
service, and waits for health. A failed recovery exits distinctly and requires
operator intervention; it must not silently report the new release as active.

Infrastructure or persistent-state recovery is separate and limited to the
surfaces changed by that task. Do not restore an entire server, old firewall, or
old secret set for an application-only failure.
