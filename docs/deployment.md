# Minimal Deployment

Last verified against upstream documentation: 2026-08-21.

This page records exact release `9461e20` production facts and the current source
deployment contract. Product direction and pending migrations are owned by
[project memory](./project-memory.md) and [the TODO ledger](./todo.md).

This section documents the repository's UDP-only deployment candidate: one
Node.js process provides the built Web client, room API, and WebSocket signaling
behind Caddy or nginx; application ICE advertises only STUN by default; LiveKit
supplies bounded SFU-root capacity. Normal media remains distributed through
direct or peer edges whenever those paths work.

A deployment may additionally provide one single-node LiveKit process as the
current controller's automatic final media fallback. This capacity is dormant unless the complete
`LIVEKIT_URL`/key/secret tuple is configured. It does not replace the P2P path,
the peer-assisted experiment, or required STUN discovery. LiveKit remains
ICE/UDP only. Source no longer contains the rejected participant-wide Peer ICE TURN
candidate; stale `PEER_ICE_TURN_*` keys fail startup even when blank. The
selected-edge source tuple is enabled in production only for the controller's
single exceptional edge. Production ordinary peer ICE remains STUN-only and the
tracked coturn example remains `stun-only`; the shared host retains its older
authenticated-relay daemon configuration and firewall range. The application
does not pre-advertise TURN credentials to ordinary peers.

Production currently runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`
from `/opt/screener/releases/9461e20`; immediate rollback is
`/opt/screener/releases/21d5cd9f7139`. Local and public health return 200;
Screener, LiveKit, coturn, and nginx are active, and Screener reports
`NRestarts=0`.

The current release deploys the bounded pre-share health/WSS/STUN self-check,
privacy-safe click-only diagnostic JSON export, room admission default eight
with explicit limits from one through sixteen, bounded signaling-partition
recovery, and peer-quality MBB. An ordinary Viewer with a peer/SFU upstream or
the Host may own one separately budgeted provisional child. The endpoint-cap environment is unset,
so the production default yields Host two and ordinary Browser Viewer one; the
wire remains unchanged. The retained capacity-two/cap3 sixteen-Viewer
and resource runs are historical ordinary-PC experiments only and do not define
release policy or close performance gates.
The release also deploys the identity-bound relayed-detail presentation, root <=2 controller/token invariant,
Host-publication edge accounting, zero-child assignment/subscriber retention,
and `dynacast: false` with ordered active `q,h`. These are bounded control-plane
and publisher-configuration guarantees; real shaped LiveKit packet flow, BWE
downshift/recovery, and resource cost remain open.

## Topology and prerequisites

Use two DNS names, for example `share.example.com` and `stun.example.com`. They
may resolve to the same public IP: the Web ingress owns TCP 443 while the
self-hosted STUN listener owns UDP 3478.

```text
browser -- HTTPS/WSS --> Caddy or nginx :443 --> Node.js :8787
browser <------------ DTLS-SRTP P2P ------------> browser
browser -- STUN binding/UDP --> coturn :3478 (application advertises STUN only)
browser <---------- DTLS-SRTP/UDP ----------> LiveKit :7882
```

The minimum runtime is Node.js 24 LTS and coturn 4.17.2 or a newer patched
release. Provision a valid TLS certificate for the Web name. Enable operating system time
synchronization and keep the Node application port reachable only from its
reverse proxy. A single Node process is intentional. Active participants and
signaling remain in memory; an optional protected SQLite file can restore room
identity after a restart, but it does not restore live WebRTC connections.

Build and validate the exact revision on a build host before starting it:

```sh
npm ci
npm run check
npm start
```

Do not run the repository full check, typecheck, or build on the current 960 MiB
no-swap production host. An inactive-release check before the `261e980c` cutover
temporarily starved HTTP and SSH; exact `691863e` remained current and all four
services stayed at `NRestarts=0`. The retained production path uses a locally
verified dist artifact plus one `npm ci --omit=dev` in a transient unit bounded
to 30% CPU, 160 MiB memory high, 256 MiB memory max, and 120 seconds. It then
runs only runtime imports, `node:sqlite`, and artifact/inode/permission gates.

Each immutable release must own an independent dependency tree. Never hard-link
`node_modules` or another file that deployment may `chown`, `chmod`, replace, or
remove: metadata changes would also mutate the rollback release. A copy or
copy-on-write reflink is acceptable only after an inode audit confirms that the
old and new regular-file sets have zero shared inodes. Do not recursively change
permissions until that check passes.

Transport archives must preserve UTF-8 entry names. Prefer the POSIX release
archive path and verify the extracted manifest before switching. A Windows ZIP
used for the 2026-08-20 route-rescue release altered two non-runtime Chinese
documentation names on Linux. Runtime artifacts were unaffected and the
immutable upload remains evidence, but do not reuse that packaging method.

In a strict-shell deployment, expected service states are data, not command
failures. Do not call `systemctl is-active` bare under `set -e`/`ERR`: an
intentionally stopped service returns a nonzero status and can trigger a false rollback. Read
`ActiveState` with `systemctl show`, compare the returned string explicitly, and
keep stop, symlink switch, start, health check, and rollback as separate steps.
Preflight every inspection dependency before taking a backup or changing a
service. If a host lacks the `sqlite3` CLI, use the pinned Node runtime's
`node:sqlite` API or stop before the first write. After a start, poll health for
a short bounded window instead of treating one request during startup as a
failed release; retain the last failure while still enforcing the deadline.

Run `npm start` under a service supervisor that injects the environment, restarts
on failure, and applies bounded logs. For a simple untracked environment file,
the equivalent direct launch is
`node --env-file=.env.production dist/server/server/index.js`. Do not expose port
8787 to the Internet. The application default is `0.0.0.0` for LAN development
and container compatibility, while the bare-metal production baseline below
explicitly sets `LISTEN_HOST=127.0.0.1` because only the same-host reverse proxy
should connect. A container can instead use `0.0.0.0` and enforce the intended
boundary with port publishing rules or a host firewall.

The optional same-host LiveKit layout needs no additional public hostname:
`LIVEKIT_URL=wss://share.example.com` and nginx proxies only current `/rtc/v1*`
requests to LiveKit. Retired `/rtc` and `/rtc/validate` endpoints return 404
without request-target logging. LiveKit's HTTP/WebSocket listener on TCP 7880 is
private to nginx, while WebRTC media reaches LiveKit directly on UDP 7882.

## Candidate boundary and rollback

The accepted target for `share.bonfire.icu` remains distributed and automatic:
direct/peer UDP first, with one Host publication available to authorized SFU
subscriptions when a logical edge cannot use peer transport. An SFU-fed Viewer
may continue as a peer relay only after independent outbound proof; strict
fallback Viewers remain leaves. Server-assisted subscriptions and allocations
use independent deployment admission rather than an endpoint-cap or fixed-root
rule.

The repository requires STUN and ordinary peer connections receive STUN-only
ICE. An existing logical edge prefers direct/peer UDP and may use exact selected
TURN when configured; only an unavailable logical ingress uses the Host
publication/SFU path. A Host-SFU ingress may itself use selected TURN. LiveKit
participants receive only revision-bound `sfu-config` URL/token messages and
negotiate within LiveKit's separate ICE domain. The selected-edge TURN
config/wire is deployed in the current `9461e20` release with one UDP URL and a
120-second credential TTL. It was not exercised by a real media session during
this cutover.

`PEER_ASSISTED_MEDIA=true` is the process-wide topology/SFU switch. Every normal
room gets its own bounded controller state; ordinary peer connections remain
STUN-only and only the selected-edge source path may grant TURN to the
controller's then-current edge. Run candidate releases on an isolated
instance/hostname and keep
the old release unchanged for rollback. If the candidate fails, roll back the
release or instance; do not add a permanent dual-transport branch.

A shared-public-IP instance can test candidate behavior while the old TURN
service stays live, but it cannot prove the clean-port boundary or approve broad
migration. The room-1 smoke uses this shape: nginx owns 443, LiveKit 1.13.5 owns
UDP 7882, Peer ICE TURN is disabled, and LiveKit is fail-closed under a 192 MiB
high/256 MiB hard cgroup limit with restart disabled. Prefer a separate VM/IP
for the full gate and verify representative external networks and devices.

TURN REST authentication proves only HMAC and expiry to coturn. Coturn cannot
verify a room, route, edge, or connection generation, so the application must
bind issuance and parent/child rebuild to the current controller state, keep the
attempt one-use and short-lived, and revalidate every asynchronous boundary.
Never describe coturn itself as cryptographic selected-edge enforcement.
HTTPS/WSS always remains TLS/TCP independently.

The 2026-08-20 exact-room canary used source `a11a73dfa79d`, inactive release
`/opt/screener/releases/a11a73dfa79d-r4`, artifact SHA-256
`C954185869A3A15CCCE642AB72A4CF90770476C117D61182D7728280C30A036F`, and
backup `/opt/screener/backups/turn-a11-20260820T065933Z`. The candidate
switch completed at 14:59:33 +08. Local authenticated coturn allocation and
application/deployment gates passed, but the real direct Host plus Pion Viewer
did not establish its peer connection. The forced-relay test was therefore not
run. Issuance was removed first, then coturn and its firewall rules returned to
the pre-canary authenticated-relay baseline: TCP/UDP 3478 and UDP 49152-49251.
Exact `7fea60ef6f2ad14a9ac1c23a89a523d91bbb97e4` was restored and advertises no
TURN credential. The final lock-free check at 15:12:40 +08 found active
services, zero allocations, and matching health, configuration, firewall, and
SQLite state.
No canary test process, browser profile, or transient firewall rule remained.
The retained release is inactive. This is a canary no-go, not TURN deployment
or media evidence. Two earlier attempts changed no durable state: one stopped
before backup/write because `sqlite3` was absent, and one rolled back after a
single health request landed in the normal startup window. The preflight and
bounded-poll rules above are the retained fixes.

## Production application environment

Keep the real values in the process secret store or an untracked, access-restricted
environment file. Node.js 24 can load such a file with `--env-file`; the tracked
`.env.example` is only a schema. Generate independent secrets with a password
manager or a cross-platform Node command such as:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use this next-release baseline for the current source candidate:

```dotenv
NODE_ENV=production
LISTEN_HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://share.example.com
ALLOWED_ORIGINS=https://share.example.com
SITE_ACCESS_PASSWORD=<INDEPENDENT_8_TO_128_BYTE_ACCESS_KEY>
ROOM_DATABASE_PATH=/var/lib/screener/rooms.sqlite
ROOM_TTL_SECONDS=14400
MAX_ROOMS=1000
MAX_VIEWERS_PER_ROOM=8
ENDPOINT_MEDIA_COPY_CAPACITY=2

STUN_URLS=stun:stun.example.com:3478
```

To make automatic SFU fallback capacity available, add the complete tuple:

```dotenv
PEER_ASSISTED_MEDIA=true
LIVEKIT_URL=wss://share.example.com
LIVEKIT_API_KEY=<GENERATED_LIVEKIT_API_KEY>
LIVEKIT_API_SECRET=<INDEPENDENT_SECRET_OF_AT_LEAST_32_BYTES>
MAX_SFU_ROOTS_PER_ROOM=2
```

The rejected `PEER_ICE_TURN_*` participant-wide tuple is removed; supplying any
stale key, even blank, fails startup. The deployed source uses the complete
`SELECTED_EDGE_TURN_URLS`, `SELECTED_EDGE_TURN_SHARED_SECRET`, and
`SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS` tuple with one explicit TURN/UDP URI,
an independent secret and bounded TTL. The current production tuple uses the
coturn UDP endpoint and a 120-second TTL; only the controller-selected edge may
receive a short-lived grant. Roll back by removing the application tuple before
changing coturn or firewall state. Credentials never enter URLs, logs, browser
persistence, room rows, or SQLite.

Before a media canary, `npm run gate:turn-udp-allocation` provides the bounded
UDP allocation check. It proves only that an authenticated relay candidate can
be allocated over UDP; it does not prove a media route, recovery, quality, or
performance. Set `CHROME_PATH` in the process environment and supply the
complete selected-edge tuple either in that environment or as newline-delimited
`KEY=value` records on stdin. Values containing `=` are preserved. The script
uses an isolated Chrome profile and loopback-only in-memory credential response,
then emits only status, relay-candidate count, transport protocol, and coarse ICE
error-code buckets. Do not echo, log, or persist raw production environment
input; never add TURN URLs, usernames, credentials, candidate addresses, or raw
errors to the result.

`PEER_ASSISTED_ROOM_IDS` is retired. Supplying it, even blank, fails startup so
that a stale room-1 deployment cannot silently retain the old scope. With
`PEER_ASSISTED_MEDIA=true`, every normal room receives peer-assisted routing,
optional LiveKit fallback, and the same per-room root/fanout/failure guards.
Every ordinary peer connection remains STUN-only; selected-edge TURN is still
issued only to a current controller-selected edge. There is no browser control,
percentage rollout, or second router.

`ALLOWED_ORIGINS` must list exact `http` or `https` origins, never `*`.
`SITE_ACCESS_PASSWORD` is required in production and must contain 8 through
128 visible ASCII bytes (`0x21` through `0x7e`). It must not be reused for
LiveKit, TLS, TURN, or another service. It authorizes room creation, Host role,
and code-only Viewer attempts; it does not replace a private room grant or
password. Local development and tests may omit it. Supplying a removed access
key, even blank, fails startup.
`ROOM_DATABASE_PATH` is optional but requires `SITE_ACCESS_PASSWORD`.
Omit the database path to keep random temporary rooms; `ROOM_TTL_SECONDS`
applies only to those rooms.
`MAX_VIEWERS_PER_ROOM` defaults to 8 and accepts 1 through 16. It is an admission
limit, not evidence that the publisher can sustain that many streams.
`ENDPOINT_MEDIA_COPY_CAPACITY` defaults to 2 and accepts only 1, 2, or 3. It is
the single server-authoritative steady outbound media-copy cap for Host and
Viewer endpoints; role, browser, UA, and visibility do not create another tier.
A peer child or the Host's single SFU publication consumes one copy, upstream
receive is free, a committed selected TURN transport for the same child does not
consume a second copy, and an uncommitted selected carry does. Transition work
may reach only `min(C + 1, 3)`. A Host already sending three copies at `C=3`
must fail or wait before a fourth publication token or TURN grant is issued.
Supplying the removed `MAX_PEER_RELAY_DOWNSTREAM_EDGES`, even blank, fails
startup. The fixed per-room SFU-root and selected-lease guards remain separate
temporary server safety boundaries.

Production release `9461e20` still runs the legacy Host-2/Browser-1 policy on
wire `screener-v5`. Deploy the current source server, Web assets, and Native
sender atomically on `screener-v6`; restore the exact prior environment and
release together when rolling back.

The three `LIVEKIT_*` values must either all be absent or all be present, and a
complete tuple requires `PEER_ASSISTED_MEDIA=true`. An empty tuple keeps the
optional SDK and server path dormant. `LIVEKIT_URL` must be a plain `ws:` or
`wss:` origin with no `/rtc` suffix; production requires `wss:`.
`LIVEKIT_API_SECRET` must contain at least 32 bytes and must not reuse
`SITE_ACCESS_PASSWORD`. In that same held release, `MAX_SFU_ROOTS_PER_ROOM` defaults to
2 and accepts only 1 or 2; it is ignored when LiveKit is not configured. These
credentials authorize short-lived LiveKit room tokens and do not provide E2EE:
the LiveKit operator can access ordinary SFU media.

For the first candidate canary, use an isolated instance and a protected
persistent room whose ID is stable across restarts. Restart the application and
verify that both that room and a second normal room contain
`mediaMode: "peer-assisted"`, with independent route revisions and no shared
room state. Exercise join, offer and answer, stop, reconnect, and room deletion
in both rooms. Ordinary Web and
Native-shaped clients remain STUN-only. With the selected-edge tuple, only
the current controller-selected edge may receive a one-use grant; all other
sessions and connections remain STUN-only. Roll back by disabling application
issuance before restoring the exact recorded pre-canary coturn/firewall baseline, or direct
traffic to the unchanged old release. Do not treat disabling
`PEER_ASSISTED_MEDIA` alone as TURN rollback: disable the selected-edge tuple
independently, and no removed old
TURN wire is restored. During migration, remove the retired room-ID variable in
the same coherent change; the process flag explicitly enables the all-room
controller.

Only `POST /api/site-access` accepts the site access secret in an
`Authorization: Bearer` header from an exact allowed Origin. Success returns a
12-hour stateless HMAC-SHA256 cookie with `HttpOnly`, `SameSite=Strict`,
`Path=/`, bounded `Max-Age`, and, under production HTTPS, `Secure` plus an
`__Host-` name. The cookie contains no account or server-side session ID. There
is no account database, JWT, session map, or logout endpoint.

Before an access-boundary release, set `CHROME_PATH` to a local Chrome or
Chromium executable and run `npm run gate:access-privacy`. The gate creates only
a loopback room and temporary SQLite/profile state, navigates the fragment
through CDP rather than a process argument, disposes its ephemeral browser
context, and emits only fixed booleans and counts. It also checks the tracked
nginx logging shape and runs the complete signaling suite containing the strong
rotate/revoke teardown case. The room password enters only at the RoomStore
boundary, so this run proves its raw SQLite non-persistence, not its WebSocket or
log ingress. It never connects to production or accepts a production credential;
exact production request/nginx/journal/database inspection remains separate.

nginx limits this exact endpoint per source at `5r/m` with `burst=5 nodelay` and
returns 429 when exhausted. The limiter uses nginx shared memory; do not add the
secret, Authorization header, request body, or a new source-address field to
logs. `POST /api/rooms` accepts only the site-access cookie and strict JSON
with an explicit Viewer policy; a Bearer header is not an alternate creation
path. `/signal` still admits a cookie-free browser after Origin and capacity
checks and records the cookie state at upgrade. Host requires it with the room
Host token. A Viewer may omit it only when presenting a valid, unexpired grant
for that exact room; otherwise the server rejects before evaluating public-watch
or a room password.

Private rooms are the default. Their invitation is
`/r/{code}#v={room-scoped-grant}`; the fragment does not enter HTTP or WebSocket
request targets. The page validates it, writes it only to that room's
`sessionStorage`, and immediately replaces the visible URL with `/r/{code}`.
An independent tab without the fragment must first pass site access. A private
room then requires its room password, while explicit `public-watch` accepts the
numeric room code. Neither policy
lets a Viewer create a room or authenticate as Host.

Room allocation has two deliberately small policies:

- With `ROOM_DATABASE_PATH`, SQLite allocates positive decimal IDs starting at
  `1`. These rooms do not expire, while each private Viewer invitation expires
  after seven days unless rotated earlier. An explicit stop or capture
  track ending stops the current publication and leaves viewers waiting; it does
  not delete the room. A brief signaling disconnect does not stop otherwise
  healthy P2P media.
- Without `ROOM_DATABASE_PATH`, rooms use random numeric IDs and expire according
  to `ROOM_TTL_SECONDS`; a private grant cannot outlive its room. Stopping sharing
  does not immediately delete it. Public-watch remains available but explicit.

The built-in `node:sqlite` schema v3 stores each room ID, a SHA-256 Host token
digest, one nullable SHA-256 Viewer-grant digest, and optional validated Viewer
password material in the same `STRICT` row. `NULL` means public-watch or no
password; checked BLOBs mean private-link/password state. It must not contain
plaintext tokens or grants, passwords, cookies, names, participants, SDP, ICE
candidates, IP addresses, TURN credentials, or media.
Protect and back up the file as service state. The tracked
systemd unit creates `/var/lib/screener` with `StateDirectory=screener` and mode
`0700`; the production path above is writable despite `ProtectSystem=strict`.
The database is designed for one application process, not shared storage across
multiple instances.

For a simple consistent backup, stop `screener.service` before copying the
SQLite file, then start it again. Restore while the service is stopped, restore
ownership to the service account and mode `0600`, run SQLite
`PRAGMA integrity_check`, and only then start the service. An online backup must
use SQLite's [backup API](https://www.sqlite.org/backup.html) or `VACUUM INTO`;
do not copy only the live main file while it may have an active journal.

The current release migrates schema v1 or v2 to v3 and has no dual-schema
runtime. For an existing deployment, stop the service and take a named,
immutable copy before installing or starting the new binary. Confirm the
stopped source reports `PRAGMA user_version = 1` or `2`, retain the backup
outside the release directory, and record its checksum. On first v3 startup,
one `BEGIN IMMEDIATE` transaction first gives v1 rows a checked nullable Viewer
grant digest with a fresh fail-closed value, then gives v1/v2 rows the checked
nullable password material and advances `user_version` to `3`.

After startup, verify `PRAGMA integrity_check`, `user_version = 3`, service
health, Host reclaim, invitation rotation, password update/removal, and a new
Viewer join before removing the maintenance boundary. If rollback is required,
stop the v3 service, preserve the v3 database separately for diagnosis, restore
the exact pre-migration backup with service ownership and mode `0600`, verify
its integrity and original user version, and only then start the matching old
binary. Never point an old binary at the migrated v3 file.

Enabling persistence does not migrate rooms that existed only in memory. The
deployment restart invalidates those temporary links; the first subsequently
created persistent room receives ID `1`.

Production startup requires one to eight syntactically valid `stun:` URLs
before the server listens. This validates shape only; it does not prove DNS,
firewall, NAT mappings, or external STUN reachability. The current application
rejects `TURN_URLS`, `TURN_SHARED_SECRET`, or `TURN_CREDENTIAL_TTL_SECONDS` when
any key is present, including with an empty value. Remove those obsolete keys
from the candidate environment; startup fails instead of pretending they enable
compatibility.

The rejected candidate names `PEER_ICE_TURN_URLS`,
`PEER_ICE_TURN_SHARED_SECRET`, and
`PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS` must remain absent from production and
now fail startup even when blank. They are not aliases for the selected-edge
tuple; ordinary peer edges remain STUN-only while only the current controller
edge may use the configured selected-edge transport.

## HTTPS and WSS ingress

Terminate public TLS at Caddy or nginx and proxy every application path to the
single Node process. `/signal` must preserve the WebSocket upgrade, `Host`, and
`Origin`, and its idle/read timeout must be longer than a normal sharing session.
Do not cache `/api/*` responses. Caddy's minimal same-host form is:

```caddyfile
share.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

An equivalent nginx location is:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

The tracked
[`share.bonfire.icu.conf.example`](../deploy/nginx/share.bonfire.icu.conf.example)
follows this simple model and listens directly on public TCP 443. It does not
need an SNI transport router. Exact `/rtc` and pinned-v0 `/rtc/validate` requests
return 404 with access and request-line error logging disabled; only `/rtc/v1*`
is proxied. Current versioned requests carry a short-lived LiveKit JWT in the
query string, so no `/rtc*` target may fall through to the site's ordinary logs.

When Certbot manages the Web certificate, install the tracked
[`reload-nginx.sh`](../deploy/certbot/reload-nginx.sh) as an executable under
`/etc/letsencrypt/renewal-hooks/deploy/`. Run `certbot renew --dry-run` after
the first certificate is installed. This hook reloads only the Web ingress.

Keep the proxy's access-log retention bounded and access controlled. Requests to
`/r/{code}` put the room code in the path, so access logs can contain room codes
as well as network metadata. They must not be treated as public artifacts. For
a private room, the grant remains in the fragment and is not part of that
request target. A public-watch code still requires prior site access.

For a process-level liveness probe, send `GET /healthz`. A running process
returns HTTP 200 with `{"status":"ok"}` and `Cache-Control: no-store`; other
methods return 405 with `Allow: GET`. The endpoint does not inspect room state,
STUN/SFU reachability, or any external dependency, so use it only to decide whether
the Node process can accept HTTP requests. It is not a deployment-readiness or
end-to-end media check.

## Optional single-node LiveKit fallback

Use the tracked
[`livekit.yaml.example`](../deploy/livekit/livekit.yaml.example) and
[`livekit.service.example`](../deploy/systemd/livekit.service.example) as the
minimal single-node baseline. Install a reviewed, pinned LiveKit Server release
from its official release assets, generate an independent key pair with
`livekit-server generate-keys`, and place only the YAML key mapping in
`/etc/livekit/keys.yaml`. Keep that file owned by the `livekit` service account
with mode `0600`; put the same values in Screener's untracked process secrets.

The example deliberately omits Redis and every recording, ingress, egress,
webhook, external-TURN, and embedded-TURN service. It explicitly sets
`tcp_port: 0` and `allow_tcp_fallback: false`, and points `stun_servers` at the
deployment's self-hosted STUN listener so pinned LiveKit cannot inherit its
default public Google STUN servers. Do not add Redis for this one-node workload.
The service journal is the diagnostic log; keep its retention finite and access
restricted. Never enable debug/Pion packet logging continuously or persist JWTs,
SDP, ICE candidates, API secrets, or full `/rtc` and `/rtc/*` request targets.

Configure both the host firewall and the provider firewall independently:

| Destination | Protocol | Exposure | Purpose |
| --- | --- | --- | --- |
| `127.0.0.1:7880` | TCP | Private | nginx to LiveKit signaling/API |
| public host `:7882` | UDP | Public | WebRTC ICE/UDP mux |

LiveKit may listen beyond loopback while it discovers and advertises public
media addresses, so the public-firewall denial of TCP 7880 is mandatory; nginx
must be its only ingress. UDP 7882 is a direct media listener and must not be
placed behind the HTTP reverse proxy. If the host is behind NAT, forward it
without port translation and verify the advertised candidate from an external
network. UDP-blocked networks are expected to fail clearly in this candidate;
do not set `rtc.tcp_port` above zero, enable TCP fallback, or add TURN to make a
canary pass silently.

## Self-hosted STUN

This subsection describes the temporary STUN-only deployment template, not the
enabled selected-edge production environment or the current shared-host coturn
state. That host retains an older authenticated-relay configuration and TCP/UDP
3478 plus UDP 49152-49251 firewall range. In this template Screener advertises
no TURN credential and the canary audit found zero allocations; production
selected-edge issuance remains limited to the controller's one configured edge
and has one active Host-ingress forced-relay functional acceptance. Initial
Host ingress and `peer-selected` last mile remain open.

Copy [`deploy/coturn/turnserver.conf.example`](../deploy/coturn/turnserver.conf.example)
to an untracked service-owned location and use the tracked
[`coturn.service.example`](../deploy/systemd/coturn.service.example). The config
uses coturn's documented `stun-only` mode, ignores every TURN allocation request,
and disables TCP and TLS client listeners. It has no auth secret, user database,
relay port range, certificate, quota, or TURN REST credential. Pinned coturn
4.17.2 deprecates `no-dtls`, so the tracked config does not use that obsolete
switch or claim a separate DTLS listener gate.

On a single-homed public host, automatic listener selection is sufficient. On a
multi-homed host, set `listening-ip` to the intended public interface. Open only
UDP 3478 and keep TCP 3478/5349 plus every old relay range closed. The same public
IP may serve HTTPS/WSS on TCP 443 and LiveKit media on UDP 7882.

The example writes informational logs to stdout. Apply finite supervisor
retention and restrict access because STUN sees client IP addresses. Do not
enable `verbose` or `log-binding` continuously. `stun-only` is a hard candidate
boundary, not a hidden unauthenticated TURN service.

Open only these public listeners:

| Destination | Protocol | Purpose |
| --- | --- | --- |
| `share.example.com:443` | TCP | HTTPS and WSS |
| `stun.example.com:3478` | UDP | STUN binding only |
| host public address `:7882` | UDP | LiveKit WebRTC ICE/UDP mux |

## Verification

Run these checks from real external networks before calling the deployment usable:

1. Open the official [Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   and test the configured STUN URL. It must produce an `srflx` candidate over
   UDP and no `relay` candidate. Confirm TCP 3478/5349 and the old relay range
   are closed externally.
2. Create a normal Screener room on two different networks. Confirm media flows
   and the selected-pair stats report a non-relay path when direct ICE succeeds.
3. On a normal room, exhaust a peer route and verify the host plus at
   most two necessary roots select LiveKit UDP 7882. Peer descendants stay on
   ordinary direct UDP and Host/ordinary Browser Viewer downstream caps remain
   two/one.
4. Force one controller-eligible edge past SFU/UDP and verify only that edge gets
   the short-lived TURN server plus relay policy and selects TURN/UDP. Ordinary
   peer PCs must stay STUN-only. Then block all UDP and verify bounded recovery
   ends clearly without ICE/TCP, TURN/TCP, or a long pseudo-connected path.
5. Exercise root departure, reconnect, SFU unavailable, route prepare rollback,
   stop, and source/profile changes. Unaffected subtrees must not migrate.
6. Repeat at 1, 3, 5, and 8 viewers across representative consumer networks.
   Record selected protocol, RTT, bitrate, frame rate, packet loss, publisher
   upload/encode load, LiveKit ingress/egress, and final decoded quality. A real
   1:8 session remains unverified until this matrix passes.

References: [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2),
[pinned turnserver documentation](https://github.com/coturn/coturn/blob/4.17.2/README.turnserver),
the [pinned example configuration](https://github.com/coturn/coturn/blob/4.17.2/examples/etc/turnserver.conf),
[RFC6265bis](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/),
[LiveKit firewall guidance](https://docs.livekit.io/deploy/admin/firewall/), and
the [pinned LiveKit configuration sample](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml).
