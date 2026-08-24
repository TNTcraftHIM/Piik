# Minimal Deployment

Last verified against upstream documentation: 2026-08-24.

This page records production running exact deployed application/runtime revision
`1d8761528d0dba43fb6d818df3934483ba2f5340`, release `1d87615`, and the single
Browser `screener-v12` contract. Product direction and pending work are owned by
[project memory](./project-memory.md) and [the TODO ledger](./todo.md).

This section documents the accepted UDP-only deployment contract: one Node.js
process provides the built Web client, room API, and WebSocket signaling behind
Caddy or nginx; ordinary peer ICE advertises only STUN, while Browser LiveKit
PCs configure no external ICE server and retain LiveKit-signaled UDP candidates.
LiveKit supplies bounded SFU fallback capacity. Normal media remains distributed
through direct or peer edges whenever those paths work. Production includes
implementation `ae09c760adec76fd26da611d4928486d105c6d3b`. Chrome 151 physically
verified its exact single-representation SFU publisher and subscriber.

A deployment may additionally provide one dedicated single-node LiveKit process
as the current controller's automatic final media fallback. This capacity is
dormant unless the complete public URL, private API URL, key, secret, and capacity
tuple is configured. It does not replace the P2P path,
the peer-assisted experiment, or required STUN discovery. LiveKit remains
ICE/UDP only. Ordinary peer ICE remains STUN-only and production coturn uses the
tracked STUN-only configuration with TCP/TLS disabled. The source and production
configure no TURN, ICE/TCP, media TCP, or TLS-relayed media.

Production runs exact `1d8761528d0dba43fb6d818df3934483ba2f5340`, release
`1d87615`, from `/opt/screener/releases/1d87615`. The immutable runtime ZIP
SHA-256 is
`715480487059bf83516a34e0d1083b52437619838c46bdc26ca5967529a1cf05`.
Its 38-file path/size/hash manifest SHA-256 is
`96845789560394ca20b16c37a8e7ddadc7b488876e32241709d0f7a577fdca26`.
Local and public `/healthz` return 200; Screener, LiveKit, coturn, and nginx are
active with `NRestarts=0`. The public main Browser asset is
`assets/index-DfMqhOXY.js` with SHA-256
`cf6dd1c46cc9414a87331a9312eec315ddce8fce565741284998aa0141b18d47`.

The release deploys the single Browser `screener-v12` wire, fixed VP8 for Browser
direct, browser-relay, and SFU video, one SFU `HIGH` encoding without simulcast
or a subscriber layer selector, disabled Dynacast, no video `contentHint`, no
codec UI/state/wire, random four-digit memory rooms with a 24-hour dormant lease,
a room-lived 22-character grant,
orthogonal `open | private` grant/code admission,
20-Viewer room admission, the uniform endpoint media-copy cap `2`, and the
one-controller exact-candidate route runtime. Exact predecessor release
`b68c471` production postflight verified open code entry, private invitation-only
and password entry, grant rotation/revocation, typed missing-room failure, and
stale `screener-v11` rejection with
`INVALID_MESSAGE` and WebSocket close 1008 before room authority. The service unit
has no writable room StateDirectory; all room authority is process-memory-only.
LiveKit is dedicated, has `room.auto_create: false` and
`max_participants: 21`, and is admitted to one global publication ingress plus
twenty subscription egress handles. Coturn listens only on UDP 3478 for STUN;
LiveKit media listens on UDP 7882. The stable application firewall table
`inet bonfire_filter` has SHA-256
`afaf9d066e9f292d8bd19032b38c0978ccf60dd01c2fe7f210968ff751f90534`,
and `/etc/nftables.conf` has SHA-256
`d57cab70b455e6ddd5cd4688c354b9af5e1d4fb9e9b67c6b85ade0da347cb1d0`;
the whole live ruleset is not a stable identity because fail2ban owns a dynamic
address set.
These bounds are fail-safe admissions, not throughput or quality claims.
The retained local 20-Viewer Browser smoke and open real-network boundaries are
owned by [verification status](./verification-status.md).

## Topology and prerequisites

Use two DNS names, for example `share.example.com` and `stun.example.com`. They
may resolve to the same public IP: the Web ingress owns TCP 443 while the
self-hosted STUN listener owns UDP 3478.

```text
browser -- HTTPS/WSS --> Caddy or nginx :443 --> Node.js :8787
browser <------------ DTLS-SRTP P2P ------------> browser
browser -- ordinary-peer STUN/UDP --> coturn :3478
browser <---------- DTLS-SRTP/UDP ----------> LiveKit :7882
```

The minimum runtime is Node.js 24 LTS and coturn 4.17.2 or a newer patched
release. Provision a valid TLS certificate for the Web name. Enable operating system time
synchronization and keep the Node application port reachable only from its
reverse proxy. A single Node process is intentional. Rooms, participants, and
signaling remain in process memory; a restart intentionally invalidates every
room and does not restore live WebRTC connections.

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
verified dist artifact plus one `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`
in a transient unit bounded to 30% CPU, 160 MiB memory high, 256 MiB memory max,
no swap, and 120 seconds. It then runs only runtime imports and the
artifact/inode/permission gates.

Each immutable release must own an independent dependency tree. Never hard-link
`node_modules` or another file that deployment may `chown`, `chmod`, replace, or
remove: metadata changes would also mutate another immutable release. A copy or
copy-on-write reflink is acceptable only after an inode audit confirms that the
old and new regular-file sets have zero shared inodes. Do not recursively change
permissions until that check passes.

Either a POSIX archive or ZIP is acceptable transport. Build an explicit runtime
manifest before upload, normalize every relative entry path, and reject absolute
paths, `..` traversal, unexpected top-level entries, and unapproved links. Verify
the uploaded archive hash, extract only into a new release directory, then compare
the exact path set, file types, sizes, and per-file hashes with the manifest before
switching. Archive format alone is neither integrity nor recovery evidence.

A routine application-only cutover leaves infrastructure, configuration, secrets,
and persistent state untouched. Verify a new immutable artifact, switch to it
atomically, and guarantee the pre-cutover application release only through
bounded health and postflight checks. It has no retention contract afterward and
is not a maintained backup. When a task actually changes infrastructure,
configuration, secrets, persistent state, or an irreversible surface, define and
verify recovery only for the touched surfaces before changing them.

In a strict-shell deployment, expected service states are data, not command
failures. Do not call `systemctl is-active` bare under `set -e`/`ERR`: an
intentionally stopped service returns a nonzero status and can trigger a false failure path. Read
`ActiveState` with `systemctl show`, compare the returned string explicitly, and
keep stop, symlink switch, start, health check, and any release restoration as
separate steps. Preflight every inspection dependency before changing a
service. After a start, poll health for a short bounded window instead of treating
one request during startup as a
failed release; retain the last failure while still enforcing the deadline.
After starting coturn, likewise wait boundedly for its UDP 3478 socket before
asserting STUN readiness; `ActiveState=active` can precede socket readiness.

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
private to nginx and the Screener process uses
`LIVEKIT_API_URL=http://127.0.0.1:7880` for `RoomService`; WebRTC media reaches
LiveKit directly on UDP 7882. No unrelated application may create rooms on this
instance, and its tracked configuration sets `room.auto_create: false`.
Install
[`screener-livekit-readiness.conf.example`](../deploy/systemd/screener-livekit-readiness.conf.example)
as a `screener.service.d` drop-in on this layout. `After=` orders the services,
while the bounded `ExecStartPre` waits for TCP 7880 readiness; ActiveState alone
does not prove the LiveKit control listener is accepting connections.

## Candidate boundary and recovery

The accepted target for `share.bonfire.icu` remains distributed and automatic:
direct/peer UDP first, with one Host publication available to authorized SFU
subscriptions when a logical edge cannot use peer transport. SFU-fed and
peer-fed endpoints use the same provisional-child transaction, and the exact
candidate child's first newly decoded frame commits that edge. Server-assisted
subscriptions and allocations use independent deployment admission rather than
an endpoint-cap or fixed-root rule.

The repository requires STUN and ordinary peer connections receive STUN-only
ICE. An existing logical edge prefers direct/peer UDP; the only application
suffix is the Host publication/SFU path. LiveKit participants receive only
revision-bound `sfu-config` URL/token messages and negotiate within LiveKit's
separate UDP-only ICE domain. The accepted Browser publisher and subscriber
connect contract provides an explicit empty ICE-server list, retains the UDP
candidates delivered through LiveKit signaling, and lets standard ICE select a
nominated non-relay pair. Candidate type, count, address family, and Browser
socket allocation remain implementation observations. This does not remove
ordinary-peer STUN or the deployment STUN used by LiveKit to discover its own
public address.

`PEER_ASSISTED_MEDIA=true` is the process-wide topology/SFU switch. Every normal
room gets its own bounded controller state and ordinary peer connections remain
STUN-only. Run route or infrastructure candidates on an isolated
instance/hostname and keep the current release unchanged. If the candidate fails,
stop it and restore only the recovery boundary defined for its changed surfaces;
do not add a permanent dual-transport branch.

A memory-room release starts with empty process authority. Starting the candidate
invalidates every current production room, Host token, invitation, password
verifier, and route; open pages must refresh or explicitly create a replacement
room. No room state crosses a release boundary in either direction. Guarantee the
pre-cutover immutable application release only through the bounded postflight; it
has no retention contract afterward and is not a maintained backup. An
application-only cutover leaves the environment, unit, LiveKit, coturn, firewall,
and reverse proxy unchanged; any task that changes one of those surfaces must
establish its scoped recovery before the change.

A shared-public-IP instance can test candidate behavior, but it cannot prove the
clean-port boundary or approve broad migration. The room-1 smoke uses this
shape: nginx owns 443, LiveKit 1.13.5 owns UDP 7882, and LiveKit is fail-closed under a 192 MiB
high/256 MiB hard cgroup limit with restart disabled. Prefer a separate VM/IP
for the full gate and verify representative external networks and devices.

Coturn provides STUN binding only and must reject allocation requests.
HTTPS/WSS always remains TLS/TCP independently of the UDP-only media ladder.

## Production application environment

Keep the real values in the process secret store or an untracked, access-restricted
environment file. Node.js 24 can load such a file with `--env-file`; the tracked
`.env.example` is only a schema. Generate independent secrets with a password
manager or a cross-platform Node command such as:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use this production baseline template:

```dotenv
NODE_ENV=production
LISTEN_HOST=127.0.0.1
PORT=8787
PUBLIC_BASE_URL=https://share.example.com
ALLOWED_ORIGINS=https://share.example.com
SITE_ACCESS_PASSWORD=<INDEPENDENT_8_TO_128_BYTE_ACCESS_KEY>
ROOM_LEASE_SECONDS=86400
MAX_ROOMS=1000
MAX_VIEWERS_PER_ROOM=20
ENDPOINT_MEDIA_COPY_CAPACITY=2

STUN_URLS=stun:stun.example.com:3478
```

To make automatic SFU fallback capacity available, add the complete tuple:

```dotenv
PEER_ASSISTED_MEDIA=true
LIVEKIT_URL=wss://share.example.com
LIVEKIT_API_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=<GENERATED_LIVEKIT_API_KEY>
LIVEKIT_API_SECRET=<INDEPENDENT_SECRET_OF_AT_LEAST_32_BYTES>
SFU_INGRESS_CAPACITY=<MEASURED_DEPLOYMENT_INGRESS_COPIES>
SFU_EGRESS_CAPACITY=<MEASURED_DEPLOYMENT_EGRESS_COPIES>
```

Supplying any stale `PEER_ICE_TURN_*` or `SELECTED_EDGE_TURN_*` key, even blank,
fails startup. Production contains none of those keys, uses the tracked
STUN-only coturn configuration, and keeps TCP 3478/5349 plus every relay range
closed. An application-only release leaves the environment, coturn configuration,
and firewall unchanged; a task that changes any of them must define recovery for
that exact set before modification.

`PEER_ASSISTED_ROOM_IDS` is retired. Supplying it, even blank, fails startup so
that a stale room-1 deployment cannot silently retain the old scope. With
`PEER_ASSISTED_MEDIA=true`, every normal room receives peer-assisted routing,
optional LiveKit fallback, and the same deployment resource/fanout/failure guards.
Every ordinary peer connection remains STUN-only. There is no browser control,
percentage rollout, or second router.

`ALLOWED_ORIGINS` must list exact `http` or `https` origins, never `*`.
`SITE_ACCESS_PASSWORD` is required in production and must contain 8 through
128 visible ASCII bytes (`0x21` through `0x7e`). It must not be reused for
LiveKit, TLS, or another service. It authorizes room creation, Host role,
and code-only Viewer attempts; it does not replace a private room grant or
password. Local development and tests may omit it. Supplying a removed access
key, even blank, fails startup.
`ROOM_LEASE_SECONDS` defaults to 86,400 seconds and owns the dormant room
lifetime. An actively connected Host prevents expiry; explicit stop or Host
disconnect starts the lease, and only the exact Host token renews it before
expiry. Viewer activity never renews ownership. `ROOM_DATABASE_PATH` and
`ROOM_TTL_SECONDS` fail startup even when blank.
Production `1d87615` accepts 1 through 20 and explicitly selects 20. This is an
admission limit, not evidence that every publisher, network, or quality profile
can sustain that many streams.
`ENDPOINT_MEDIA_COPY_CAPACITY` defaults to 2 and accepts only 1, 2, or 3. It is
the single server-authoritative steady outbound media-copy cap for Host and
Viewer endpoints; role, browser, UA, and visibility do not create another tier.
A peer child or the Host's single SFU publication consumes one copy and upstream
receive is free. Transition work
may reach only `min(C + 1, 3)`. A Host already sending three copies at `C=3`
must fail or wait before a fourth endpoint copy is issued.
Supplying the removed `MAX_PEER_RELAY_DOWNSTREAM_EDGES`, even blank, fails
startup.

Production release `1d87615` runs the deployed server and Browser assets
atomically on `screener-v12`; every stale Browser or executable-sender wire fails
before room authority. Native senders and helpers are outside this release.

The four `LIVEKIT_*` values must either all be absent or all be present, and a
complete tuple requires `PEER_ASSISTED_MEDIA=true` plus explicit positive
safe-integer `SFU_INGRESS_CAPACITY` and `SFU_EGRESS_CAPACITY` values. The two
capacities have no defaults and must be selected from the instance's measured
publisher/subscriber/bitrate and accepted concurrency matrix. Supplying either
capacity without the complete fallback configuration fails startup rather than
silently enabling or ignoring a partial policy. An empty tuple with neither
capacity keeps the optional SDK and server path dormant. `LIVEKIT_URL` must be a
plain `ws:` or `wss:` origin with no `/rtc` suffix; production requires `wss:`.
`LIVEKIT_API_URL` must be a plain `http:` or `https:` origin with no path;
production permits plaintext only on loopback and otherwise requires `https:`.
`LIVEKIT_API_SECRET` must contain at least 32 bytes and must not reuse
`SITE_ACCESS_PASSWORD`. These credentials authorize short-lived LiveKit room
tokens and do not provide E2EE: the LiveKit operator can access ordinary SFU
media. The LiveKit instance is dedicated to this Screener process and has
`room.auto_create: false`. Screener first binds the configured application
listener exclusively; a competing process that cannot bind makes no LiveKit
call. While bound but not initialized it returns `503` and has no signaling
upgrade handler. It then rejects any foreign room name, deletes every stale
managed room, confirms the namespace empty, and begins serving. Each
exact-generation room is then created before its token is issued. Reserved,
committed, and draining generations remain charged until
`DeleteRoom` succeeds and a follow-up lookup proves absence. Run only one
application process until a shared atomic admission and lifecycle owner exists.

For the first candidate canary, use an isolated instance and one recorded room.
Restart the application, verify startup removes the now-stale managed LiveKit
room before serving traffic, and create a fresh application room after startup.
Hold the application port with another process and verify a competing
startup makes zero LiveKit calls. Verify that both the replacement room and a
second normal room contain
`mediaMode: "peer-assisted"`, with independent route revisions and no shared
room state or capacity bypass. Exercise join, offer and answer, stale-token
reconnect after abort, Host signaling loss with and without a live Host
participant, stop, restart, and room deletion in both rooms. Confirm each drain
keeps capacity charged until the room is absent. Ordinary Web clients remain
STUN-only. Roll back by stopping Screener, proving every managed LiveKit room
absent, and restoring the exact recorded application environment, application
release, LiveKit configuration, coturn configuration, and firewall snapshot as
one unit; or direct traffic to the unchanged old instance. During migration,
remove retired route configuration in the same coherent change; the process
flag explicitly enables the all-room controller.

Only `POST /api/site-access` accepts the site access secret in an
`Authorization: Bearer` header from an exact allowed Origin. Success returns a
12-hour stateless HMAC-SHA256 cookie with `HttpOnly`, `SameSite=Strict`,
`Path=/`, bounded `Max-Age`, and, under production HTTPS, `Secure` plus an
`__Host-` name. The cookie contains no account or server-side session ID. There
is no account database, JWT, session map, or logout endpoint.

Before an access-boundary release, set `CHROME_PATH` to a local Chrome or
Chromium executable and run `npm run gate:access-privacy`. The gate creates a
loopback in-memory room with an isolated browser profile, navigates the fragment
through CDP rather than a process argument, disposes that context, and emits only
fixed booleans and counts. It checks tracked request/nginx/application logs,
browser storage, fragment cleanup, absence of a persistent room file, and runs
the complete signaling suite containing the strong rotate/revoke teardown case.
It never connects to production or accepts a production credential; exact
production request/nginx/journal inspection remains separate.

nginx limits this exact endpoint per source at `5r/m` with `burst=5 nodelay` and
returns 429 when exhausted. The limiter uses nginx shared memory; do not add the
secret, Authorization header, request body, or a new source-address field to
logs. `POST /api/rooms` accepts only the site-access cookie and strict JSON
with an explicit code-entry policy and optional room password; a Bearer header
is not an alternate creation
path. `/signal` still admits a cookie-free browser after Origin and capacity
checks and records the cookie state at upgrade. Host requires it with the room
Host token. A Viewer may omit it only when presenting a valid, unexpired grant
for that exact room; otherwise the server rejects before evaluating code entry.

Every room receives an independent invitation
`/r/{code}#v={room-scoped-grant}`; the fragment does not enter HTTP or WebSocket
request targets. The page validates it, writes it only to that room's
`sessionStorage`, and immediately replaces the visible URL with `/r/{code}`.
The Host may update or revoke that grant without changing code-entry policy.

Room allocation and lifetime use one deliberately small model:

- random unallocated codes come only from `1000` through `9999`, never duplicate
  an active code, respect `MAX_ROOMS <= 9000`, and return on room release;
- active Host sharing does not expire; stop, capture-track end, or Host
  disconnect starts `ROOM_LEASE_SECONDS`;
- only the exact Host token resumes and renews before expiry, Viewer activity
  cannot, and expiry invalidates the code, credentials, verifier, participants,
  and routes; and
- process restart has the same fail-closed effect.

The server keeps only process-memory digests/verifiers for Host tokens, Viewer
grants, and optional room passwords. There is no room database, schema,
migration, writable room directory, or backup/restore step. The same browser may
replay its Host display-name, code-entry, and optional-password creation profile
when it explicitly creates a replacement room; this is local convenience, not
server-side identity or cross-restart recovery.

Production startup requires one to eight syntactically valid `stun:` URLs
before the server listens. This validates shape only; it does not prove DNS,
firewall, NAT mappings, or external STUN reachability. The current application
rejects `TURN_URLS`, `TURN_SHARED_SECRET`, or `TURN_CREDENTIAL_TTL_SECONDS` when
any key is present, including with an empty value. Remove those obsolete keys
from the candidate environment; startup fails instead of pretending they enable
compatibility.

The rejected `PEER_ICE_TURN_*` and `SELECTED_EDGE_TURN_*` candidate names must
remain absent from production and fail startup even when blank. Ordinary peer
edges remain STUN-only and the application has no TURN configuration surface.

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
request target.

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
deployment's self-hosted STUN listener for server-side public-IP discovery and
to prevent pinned LiveKit from substituting a public default in its join
response. Current Screener source gives Browser publisher/subscriber connects an
explicit empty list, so those SFU PCs do not use either response after the
pending application cutover. Do not add Redis for this one-node workload.
The service journal is the diagnostic log; keep its retention finite and access
restricted. Pinned LiveKit 1.13.5 includes raw PublisherOffer SDP in info-level
join records, so the tracked production baseline uses `logging.level: warn` and
`pion_level: error`. Raise either only in an isolated, short-lived canary and
remove its journal afterward. Never persist JWTs, SDP, ICE candidates, API
secrets, or full `/rtc` and `/rtc/*` request targets.

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

This subsection describes the accepted and deployed STUN-only boundary.
Production uses the tracked configuration and keeps TCP 3478/5349 plus every
relay range closed.

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
| `share.example.com:80` | TCP | HTTP redirect and ACME challenge |
| `share.example.com:443` | TCP | HTTPS and WSS |
| `stun.example.com:3478` | UDP | STUN binding only |
| host public address `:7882` | UDP | LiveKit WebRTC ICE/UDP mux |

## Verification

Run these checks from real external networks before closing route acceptance:

1. Open the official [Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   and test the configured STUN URL. It must produce an `srflx` candidate over
   UDP and no `relay` candidate. Confirm TCP 3478/5349 and the old relay range
   are closed externally.
2. Create a normal Screener room on two different networks. Confirm media flows
   and the selected-pair stats report a non-relay path when direct ICE succeeds.
3. On a normal room, exhaust a peer route and verify exactly one Host
   publication serves only the admitted SFU subscriptions over LiveKit UDP 7882.
   Peer descendants stay on ordinary direct UDP and every non-server endpoint
   obeys the configured `ENDPOINT_MEDIA_COPY_CAPACITY`. On each Browser SFU PC,
   verify no local external STUN/TURN server is configured, a nominated
   non-relay UDP pair reaches an authorized LiveKit-signaled SFU candidate, and
   the exact Viewer presents a decoded frame. Do not gate on candidate type or count.
4. Block all UDP and verify bounded recovery ends clearly without ICE/TCP,
   TURN, or a long pseudo-connected path.
5. Exercise root departure, reconnect, SFU unavailable, route prepare rollback,
   stop, and source/profile changes. Unaffected subtrees must not migrate.
6. Repeat at 1, 3, 5, and 20 viewers across representative consumer networks.
   Record selected protocol, RTT, bitrate, frame rate, packet loss, publisher
   upload/encode load, LiveKit ingress/egress, and final decoded quality. A real
   public-network 1:20 session remains unverified; the passed local synthetic
   1:20 smoke does not replace this heterogeneous-network quality gate.

References: [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2),
[pinned turnserver documentation](https://github.com/coturn/coturn/blob/4.17.2/README.turnserver),
the [pinned example configuration](https://github.com/coturn/coturn/blob/4.17.2/examples/etc/turnserver.conf),
[RFC6265bis](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/),
[LiveKit firewall guidance](https://docs.livekit.io/deploy/admin/firewall/), and
the [pinned LiveKit configuration sample](https://github.com/livekit/livekit/blob/v1.13.5/config-sample.yaml).
