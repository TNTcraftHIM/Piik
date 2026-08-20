# Minimal Deployment

Last verified against upstream documentation: 2026-08-20.

This section documents the repository's UDP-only deployment candidate: one
Node.js process provides the built Web client, room API, and WebSocket signaling
behind Caddy or nginx; coturn runs in `stun-only` mode for address discovery;
LiveKit supplies bounded SFU-root capacity. Normal media remains distributed
through direct or peer edges whenever those paths work.

A deployment may additionally provide one single-node LiveKit process as the
current controller's automatic final media fallback. This capacity is dormant unless the complete
`LIVEKIT_URL`/key/secret tuple is configured. It does not replace the P2P path,
the peer-assisted experiment, or required STUN discovery. LiveKit remains
ICE/UDP only. Source also contains a separate default-off built-in Peer ICE
TURN/UDP canary; production and the tracked coturn example remain STUN-only.

Production `d4bc421828c4` runs this candidate for exact room `1` on the existing
shared public IP. Immediate rollback to `05f98d10ecd1` uses the current v2
database and environment. Rolling back the admission-policy cutover requires
`89e6d7649169` plus the environment backup recorded below; only deeper
pre-access `9610032fc5f5` may restore matching v1 state. Coturn relay remains
rollback-only. This is a bounded smoke, not broad-rollout acceptance.

## Topology and prerequisites

Use two DNS names, for example `share.example.com` and `stun.example.com`. They
may resolve to the same public IP: the Web ingress owns TCP 443 while the
self-hosted STUN listener owns UDP 3478.

```text
browser -- HTTPS/WSS --> Caddy or nginx :443 --> Node.js :8787
browser <------------ DTLS-SRTP P2P ------------> browser
browser -- STUN binding/UDP --> coturn stun-only :3478
browser <---------- DTLS-SRTP/UDP ----------> LiveKit :7882
```

The minimum runtime is Node.js 24 LTS and coturn 4.17.2 or a newer patched
release. Provision a valid TLS certificate for the Web name. Enable operating system time
synchronization and keep the Node application port reachable only from its
reverse proxy. A single Node process is intentional. Active participants and
signaling remain in memory; an optional protected SQLite file can restore room
identity after a restart, but it does not restore live WebRTC connections.

Build and validate the exact revision before starting it:

```sh
npm ci
npm run check
npm start
```

Each immutable release must own an independent dependency tree. Never hard-link
`node_modules` or another file that deployment may `chown`, `chmod`, replace, or
remove: metadata changes would also mutate the rollback release. A copy or
copy-on-write reflink is acceptable only after an inode audit confirms that the
old and new regular-file sets have zero shared inodes. Do not recursively change
permissions until that check passes.

In a strict-shell deployment, expected service states are data, not command
failures. Do not call `systemctl is-active` bare under `set -e`/`ERR`: an
intentionally stopped service returns a nonzero status and can trigger a false rollback. Read
`ActiveState` with `systemctl show`, compare the returned string explicitly, and
keep stop, symlink switch, start, health check, and rollback as separate steps.

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
direct/peer UDP first, then an SFU virtual parent feeding normally one or two
roots, whose peer descendants continue carrying media. Multiple exceptional viewers that cannot attach behind a healthy
root may consume additional server egress only under a separate explicit cap.

The repository requires STUN. It optionally accepts a complete
`PEER_ICE_TURN_*` tuple and issues short-lived coturn REST bearer credentials
only to capability-enabled Web sessions in an exact allowlisted room. Their
peer connections use `iceTransportPolicy: "all"`, so standard ICE candidate
priority prefers direct paths and can select TURN/UDP within the same PC. A PC
failure still owns the existing restart, rebuild, alternate-peer, then SFU
ladder. LiveKit participants receive only revision-bound `sfu-config` URL/token
messages and negotiate within LiveKit's separate ICE domain.

`PEER_ASSISTED_ROOM_IDS` is also the Peer ICE TURN boundary. An unlisted room or
a client without the explicit capability gets STUN-only ICE and keeps ordinary
P2P routing. Run candidate rooms on an isolated instance/hostname and keep
the old release unchanged for rollback. If the candidate fails, roll back the
release or instance; do not add a permanent dual-transport branch.

A shared-public-IP instance can test candidate behavior while the old TURN
service stays live, but it cannot prove the clean-port boundary or approve broad
migration. The room-1 smoke uses this shape: nginx owns 443, LiveKit 1.13.5 owns
UDP 7882, Peer ICE TURN is disabled, and LiveKit is fail-closed under a 192 MiB
high/256 MiB hard cgroup limit with restart disabled. Prefer a separate VM/IP
for the full gate and verify representative external networks and devices.

The application-side TURN slice does not change coturn or production by itself.
TURN REST authentication proves only HMAC and expiry to coturn; the temporary
credential is an App-authorized participant-session bearer and may be reused by
its holder until expiry. Coturn cannot verify a room, route, edge, or connection
generation. Never describe it as a cryptographic selected-edge restriction.
HTTPS/WSS always remains TLS/TCP independently.

## Production application environment

Keep the real values in the process secret store or an untracked, access-restricted
environment file. Node.js 24 can load such a file with `--env-file`; the tracked
`.env.example` is only a schema. Generate independent secrets with a password
manager or a cross-platform Node command such as:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use this production baseline:

```dotenv
NODE_ENV=production
LISTEN_HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://share.example.com
ALLOWED_ORIGINS=https://share.example.com
HOST_ADMISSION_PASSWORD=<INDEPENDENT_8_TO_128_BYTE_ACCESS_KEY>
ROOM_DATABASE_PATH=/var/lib/screener/rooms.sqlite
ROOM_TTL_SECONDS=14400
MAX_ROOMS=1000
MAX_VIEWERS_PER_ROOM=8

STUN_URLS=stun:stun.example.com:3478
```

To make automatic SFU fallback capacity available, add the complete tuple:

```dotenv
PEER_ASSISTED_MEDIA=true
PEER_ASSISTED_ROOM_IDS=1
LIVEKIT_URL=wss://share.example.com
LIVEKIT_API_KEY=<GENERATED_LIVEKIT_API_KEY>
LIVEKIT_API_SECRET=<INDEPENDENT_SECRET_OF_AT_LEAST_32_BYTES>
MAX_SFU_ROOTS_PER_ROOM=2
```

To make built-in Peer ICE TURN available to capability-enabled Web clients in
the same exact rooms, provision authenticated coturn separately and add the
complete independent tuple:

```dotenv
PEER_ICE_TURN_URLS=turn:turn.example.com:3478?transport=udp
PEER_ICE_TURN_SHARED_SECRET=<INDEPENDENT_SECRET_OF_32_TO_128_BYTES>
PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS=600
```

All three values must be present together, require
`PEER_ASSISTED_MEDIA=true`, and accept a TTL from 300 through 1800 seconds.
The first canary accepts exactly one explicit `turn:` UDP URI with
`transport=udp`. The secret
must not reuse Host admission or LiveKit credentials. Omitting the tuple keeps
authenticated ICE snapshots and every peer STUN-only. The Web client refreshes two minutes
before expiry with a 30-second skew floor; the server reuses a current session's
grant until that window and rate-limits refresh requests to one per five seconds.
Credentials never enter URLs, logs, browser persistence, room rows, or SQLite.

`PEER_ASSISTED_ROOM_IDS` is the required deployment canary boundary whenever
`PEER_ASSISTED_MEDIA=true`. Its non-empty value
is a comma-separated set of exact positive numeric room IDs, using the same
1-to-12-digit syntax as room authentication. Duplicate IDs, empty entries,
leading zeroes, and malformed IDs fail startup. A non-empty allowlist requires
`PEER_ASSISTED_MEDIA=true`. Only listed rooms receive peer-assisted
authentication, routing, room quality state, or optional LiveKit fallback;
every other room keeps ordinary P2P route fields and signaling behavior. The
optional Peer ICE TURN snapshot is confined to capable sessions in listed
rooms; unlisted rooms remain STUN-only. Omitting or blanking the variable fails startup rather
than enabling every room. There is no browser control, percentage rollout, or
all-room fail-open.

`ALLOWED_ORIGINS` must list exact `http` or `https` origins, never `*`.
`HOST_ADMISSION_PASSWORD` is required in production and must contain 8 through
128 visible ASCII bytes (`0x21` through `0x7e`). It must not be reused for
LiveKit, TLS, TURN, or another service. It authorizes room creation and Host
role only; it is not a Viewer password. Local development and tests may omit it.
Supplying the removed `ACCESS_PASSWORD` key, even blank, fails startup.
`ROOM_DATABASE_PATH` is optional but requires `HOST_ADMISSION_PASSWORD`.
Omit the database path to keep random temporary rooms; `ROOM_TTL_SECONDS`
applies only to those rooms.
`MAX_VIEWERS_PER_ROOM` defaults to 8 and accepts 1 through 16. It is an admission
limit, not evidence that the publisher can sustain that many streams.

The three `LIVEKIT_*` values must either all be absent or all be present, and a
complete tuple requires `PEER_ASSISTED_MEDIA=true`. An empty tuple keeps the
optional SDK and server path dormant. `LIVEKIT_URL` must be a plain `ws:` or
`wss:` origin with no `/rtc` suffix; production requires `wss:`.
`LIVEKIT_API_SECRET` must contain at least 32 bytes and must not reuse
`HOST_ADMISSION_PASSWORD`. `MAX_SFU_ROOTS_PER_ROOM` defaults to
2 and accepts only 1 or 2; it is ignored when LiveKit is not configured. These
credentials authorize short-lived LiveKit room tokens and do not provide E2EE:
the LiveKit operator can access ordinary SFU media.

For the first candidate canary, use an isolated instance and a protected
persistent room whose ID is stable across restarts. Set only that ID, restart
the application, and verify
that its authenticated message contains `mediaMode: "peer-assisted"` while a
second non-allowlisted room contains none of `mediaMode`, `qualitySettings`,
`routeRevision`, `routeAssignment`, or `sfuStandbyUrl`. Exercise join, offer and
answer, stop, reconnect, and room deletion in both rooms. With the optional
tuple configured, only the capable Web session in the listed room receives a
TURN group and expiry; the other room and Native-shaped clients remain
STUN-only. Roll back by removing the complete Peer ICE TURN tuple before
restoring coturn `stun-only`, or direct traffic to the unchanged old
release. Do not treat disabling `PEER_ASSISTED_MEDIA` alone as rollback: remove
its dependent TURN tuple and exact-room allowlist together, and no removed old
TURN wire is restored. After acceptance, retire or replace the
temporary exact-room gate in a separate coherent change; never clear the value
to trigger an implicit all-room rollout.

Only `POST /api/host-admission` accepts the Host admission secret in an
`Authorization: Bearer` header from an exact allowed Origin. Success returns a
12-hour stateless HMAC-SHA256 cookie with `HttpOnly`, `SameSite=Strict`,
`Path=/`, bounded `Max-Age`, and, under production HTTPS, `Secure` plus an
`__Host-` name. The cookie contains no account or server-side session ID. There
is no account database, JWT, session map, or logout endpoint.

nginx limits this exact endpoint per source at `5r/m` with `burst=5 nodelay` and
returns 429 when exhausted. The limiter uses nginx shared memory; do not add the
secret, Authorization header, request body, or a new source-address field to
logs. `POST /api/rooms` accepts only the Host-admission cookie and strict JSON
with an explicit Viewer policy; a Bearer header is not an alternate creation
path. `/signal` still admits a cookie-free browser after Origin and capacity
checks, records the cookie state at upgrade, and requires it only when the first
v2 message requests Host role. Viewer role never uses this deployment secret.

Private rooms are the default. Their invitation is
`/r/{code}#v={room-scoped-grant}`; the fragment does not enter HTTP or WebSocket
request targets. The page validates it, writes it only to that room's
`sessionStorage`, and immediately replaces the visible URL with `/r/{code}`.
An independent tab without the fragment fails closed. `public-watch` must be an
explicit Host choice and accepts the numeric room code alone. Neither policy
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

The built-in `node:sqlite` schema v2 stores only each room ID, a SHA-256 Host
token digest, and one nullable SHA-256 Viewer-grant digest in the same `STRICT`
row. `NULL` means public-watch; a checked 32-byte BLOB means private-link. It
must not contain plaintext tokens or grants, passwords, cookies, names,
participants, SDP, ICE candidates, IP addresses, TURN credentials, or media.
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

The access release changes schema v1 to v2 and has no dual-schema runtime. For
an existing deployment, stop the service and take a named, immutable v1 copy
before installing or starting the new binary. Confirm the stopped source reports
`PRAGMA user_version = 1`, retain the backup outside the release directory, and
record its checksum. On first v2 startup, one `BEGIN IMMEDIATE` transaction adds
the checked nullable Viewer digest, writes a different fresh locked-private
digest to every old room, and advances `user_version` to `2`. Old code-only
Viewer links intentionally stop working; each existing Host must use rotate once
to produce a private invitation.

After startup, verify `PRAGMA integrity_check`, `user_version = 2`, service
health, Host reclaim, rotation, and a new Viewer join before removing the
maintenance boundary. If rollback is required, stop the v2 service, preserve the
v2 database separately for diagnosis, restore the exact v1 backup with service
ownership and mode `0600`, verify integrity and `user_version = 1`, and only then
start the old binary. Never point the old binary at the migrated v2 file.

Production completed this migration at 2026-08-20 03:06 +08 on exact
`bbe4654a7a9b`; its artifact SHA-256 is
`3C09AF81BCE68B51DD9E36E1C253A880D8D6F24BB498A090CF815AB196C392AA`.
A stopped, read-only-verified v1 backup retained all four rooms;
the v2 integrity/schema and locked-private digest checks passed, including room
`1`. Host admission and a cookie-free private Viewer denial also passed. An
earlier artifact attempt was rolled back after hard-linked dependencies let a
permission change make the rollback release unreadable for 3m11s; the final release has an
independent dependency tree and zero shared regular-file inodes.

The code-only initial-connect recovery deployed at 2026-08-20 09:40 +08 on
exact `89e6d7649169`; its artifact SHA-256 is
`39B62039FCFB05281F78FCF85C964C520E2BB2FE5661ADA4758D598A7DF6CEC1`.
Health returned in 1.09 seconds, the v2 database still contained four rooms and
room `1`, and environment, nginx, and LiveKit state were unchanged. At 09:37 a
bare `systemctl is-active` treated the expected stopped state as an error under
strict shell and caused an immediate healthy rollback; no new application had
failed. The later explicit `ActiveState` sequence completed successfully.

The admission-policy and anonymous-entry cutover deployed between
2026-08-20 11:13:42 and 11:13:43 +08 on exact
`05f98d10ecd174427fc969f3ba2d510f12c74eb3`; its artifact SHA-256 is
`FF938E8D59428F08B3F162DEA6DCF842A4705A94D3153967814CCE9AD6CBD94D`.
The full gate passed 25 test files/369 tests before the atomic code/environment
switch. Health and the built asset returned 200; SQLite v2 with four rooms
including room `1` and zero Screener/LiveKit restarts were preserved. Chrome
kept all four anonymous entry routes neutral until authorization; the current admission key returned 200,
while the former and an incorrect key returned 401. Rolling this cutover back
requires exact `89e6d7649169` together with its environment backup at
`/etc/screener/backups/05f98d10-precutover-20260820T110654+0800`.

One failed validation assertion printed the stateless admission cookie only in
the operator's private test output. It did not enter the repository, service
logs, shell history, release artifact, browser profile, or temporary files. No
value is retained here; the cookie has no server-side state and expires within
12 hours.

Local quality reparenting deployed between 2026-08-20 11:41:22 and 11:41:23
+08 on exact `d4bc421828c4b74f55195723aace290ffc0e5f9d`; its artifact SHA-256 is
`3F8CF25F8D989CBDF38DBBCAC4A261C349E44B72D274A944B877540056171A08`.
The immutable release is `/opt/screener/releases/d4bc421828c4`, its upload is
`/opt/screener/uploads/screener-d4bc421828c4.tar.gz`, and the pre-switch target
record is `/opt/screener/backups/current-before-d4bc421828c4.txt`.
The gate passed 25 test files/378 tests, typecheck and both builds. The 760ms
code-only switch kept health and `index-YdNLg2E8.js` at 200, SQLite integrity
and four rooms including room `1`, Screener/LiveKit restarts at 0/0, and
environment/nginx/LiveKit hashes unchanged. Its immediate rollback is
`05f98d10ecd1` with the same environment and SQLite v2. A pre-cutover inode gate
caught two internal esbuild hard links; hash-equal copy replacement broke them
before the switch, so no running or rollback release was affected.
At 11:44:15 +08 Screener and LiveKit were still active/running with zero restarts,
used 39,198,720 and 79,269,888 bytes, and had no error-priority journal entries
or cgroup high/max/OOM events; host available memory was 373,469,184 bytes.
No quality/reparent log or real-room trigger appeared, so this verifies the
deployed code and containment, not reparenting behavior.

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

The replacement names `PEER_ICE_TURN_URLS`,
`PEER_ICE_TURN_SHARED_SECRET`, and
`PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS` form a distinct complete tuple; the old
keys above remain rejected and are not aliases.

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
request target; for public-watch, the current code is intentionally sufficient.

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
3. On an exact allowlisted room, exhaust a peer route and verify the host plus at
   most two necessary roots select LiveKit UDP 7882. Peer descendants stay on
   ordinary direct UDP and host/relay downstream caps remain two/one.
4. Block all UDP on one test client. Verify bounded ICE recovery ends in a clear
   connection failure, without an ICE/TCP, TURN/TCP, or long pseudo-connected
   path. No force-relay product branch exists in this candidate.
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
