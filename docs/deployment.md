# Minimal Deployment

Last verified against upstream documentation: 2026-08-19.

This section documents the repository's UDP-only deployment candidate: one
Node.js process provides the built Web client, room API, and WebSocket signaling
behind Caddy or nginx; coturn runs in `stun-only` mode for address discovery;
LiveKit supplies bounded SFU-root capacity. Normal media remains distributed
through direct or peer edges whenever those paths work.

A deployment may additionally provide one single-node LiveKit process as the
current controller's automatic final media fallback. This capacity is dormant unless the complete
`LIVEKIT_URL`/key/secret tuple is configured. It does not replace the P2P path,
the peer-assisted experiment, or required STUN discovery. It is configured with
ICE/UDP only; the candidate has no ordinary TURN or media-TCP configuration.

Production `769de201f7cc` is still the old TURN-required release. Keep it on a
separate rollback instance while validating this candidate; do not reuse its
environment or coturn relay config. Every new candidate deployment must run the
direct, SFU/UDP, UDP-blocked failure, and mixed-network procedures below.

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

The repository candidate requires STUN but has no TURN URL/secret/TTL variables,
credential issuer, expiry refresh protocol, LiveKit ICE/TCP listener, or
embedded/external LiveKit TURN. Ordinary authenticated ICE contains only STUN
servers. LiveKit participants receive only revision-bound `sfu-config` URL/token
messages and negotiate within LiveKit's separate ICE domain.

`PEER_ASSISTED_ROOM_IDS` remains an exact-room topology boundary, but ordinary
STUN-only ICE is process-wide. An unlisted room keeps ordinary P2P routing, not
the old TURN wire. Run candidate rooms on an isolated instance/hostname and keep
the old release unchanged for rollback. If the candidate fails, roll back the
release or instance; do not add a permanent dual-transport branch.

Optional selected-edge TURN is not supported by this candidate. If later network
evidence justifies it, configuration, generation-bound grants, client wire,
tests, and deployment must arrive together in a separate PR. HTTPS/WSS always
remains TLS/TCP independently.

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
ACCESS_PASSWORD=<WHOLE_SITE_PASSWORD>
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

`PEER_ASSISTED_ROOM_IDS` is the required deployment canary boundary whenever
`PEER_ASSISTED_MEDIA=true`. Its non-empty value
is a comma-separated set of exact positive numeric room IDs, using the same
1-to-12-digit syntax as room authentication. Duplicate IDs, empty entries,
leading zeroes, and malformed IDs fail startup. A non-empty allowlist requires
`PEER_ASSISTED_MEDIA=true`. Only listed rooms receive peer-assisted
authentication, routing, room quality state, or optional LiveKit fallback;
every other room keeps ordinary P2P route fields and signaling behavior. The
ordinary STUN-only ICE snapshot is process-wide; unlisted rooms do not retain
the old TURN contract. Omitting or blanking the variable fails startup rather
than enabling every room. There is no browser control, percentage rollout, or
all-room fail-open.

`ALLOWED_ORIGINS` must list exact `http` or `https` origins, never `*`.
`ACCESS_PASSWORD` is optional: omit it or leave it empty for a public site. A
non-empty value must contain 1 through 128 visible ASCII characters (`0x21`
through `0x7e`). For an Internet deployment intended to stay private, use an
independent value that is not reused elsewhere.
`ROOM_DATABASE_PATH` is optional but requires `ACCESS_PASSWORD`; startup fails
if a database path is supplied without the whole-site gate. The baseline above
enables persistent protected rooms. Omit `ROOM_DATABASE_PATH` to keep random
temporary rooms, and omit both values for public mode. `ROOM_TTL_SECONDS` applies
only to temporary rooms.
`MAX_VIEWERS_PER_ROOM` defaults to 8 and accepts 1 through 16. It is an admission
limit, not evidence that the publisher can sustain that many streams.

The three `LIVEKIT_*` values must either all be absent or all be present, and a
complete tuple requires `PEER_ASSISTED_MEDIA=true`. An empty tuple keeps the
optional SDK and server path dormant. `LIVEKIT_URL` must be a plain `ws:` or
`wss:` origin with no `/rtc` suffix; production requires `wss:`.
`LIVEKIT_API_SECRET` must contain at least 32 bytes and must not reuse
`ACCESS_PASSWORD`. `MAX_SFU_ROOTS_PER_ROOM` defaults to
2 and accepts only 1 or 2; it is ignored when LiveKit is not configured. These
credentials authorize short-lived LiveKit room tokens and do not provide E2EE:
the LiveKit operator can access ordinary SFU media.

For the first candidate canary, use an isolated instance and a protected
persistent room whose ID is stable across restarts. Set only that ID, restart
the application, and verify
that its authenticated message contains `mediaMode: "peer-assisted"` while a
second non-allowlisted room contains none of `mediaMode`, `qualitySettings`,
`routeRevision`, `routeAssignment`, or `sfuStandbyUrl`. Exercise join, offer and
answer, stop, reconnect, and room deletion in both rooms. Both rooms receive
STUN-only ordinary ICE. Roll back by directing traffic to the unchanged old
release; disabling `PEER_ASSISTED_MEDIA` only disables topology/SFU routing and
does not restore the removed TURN wire. After acceptance, retire or replace the
temporary exact-room gate in a separate coherent change; never clear the value
to trigger an implicit all-room rollout.

When `ACCESS_PASSWORD` is configured, both host and viewer routes first show the
same login gate. Only `POST /api/session` accepts the password in an
`Authorization: Bearer` header, then returns a 12-hour stateless HMAC-SHA256
cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`, a
bounded `Max-Age`, and, under production HTTPS, `Secure` plus an `__Host-` name.
The cookie contains no account or server-side session identifier. There is no
account database, JWT, session map, or logout endpoint; expiry or clearing site
cookies ends access. The optional room database is unrelated to access sessions.

`POST /api/rooms` and the `/signal` WebSocket upgrade use that cookie when the
gate is enabled. The room API does not accept a direct Bearer credential as an
alternate creation path. Viewers open `/r/{code}` or enter only the numeric code
at `/join`; there is no viewer token or URL fragment, while the host token remains
internal to the host page.

Room allocation has two deliberately small policies:

- With `ROOM_DATABASE_PATH`, SQLite allocates positive decimal IDs starting at
  `1`. These protected rooms and links do not expire. An explicit stop or capture
  track ending stops the current publication and leaves viewers waiting; it does
  not delete the room. A brief signaling disconnect does not stop otherwise
  healthy P2P media.
- Without `ROOM_DATABASE_PATH`, rooms use random numeric IDs and expire according
  to `ROOM_TTL_SECONDS`. Stopping sharing does not immediately delete them. Public
  mode always uses this policy, so anonymous clients cannot simply walk a
  sequential namespace.

The built-in `node:sqlite` database stores only each room ID (the table rowid)
and SHA-256 host-token digest. It must not contain plaintext tokens, passwords,
access cookies, SDP, ICE candidates, IP addresses, viewer state, TURN
credentials, or media. Protect and back up the file as service state. The tracked
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

Enabling persistence does not migrate rooms that existed only in memory. The
deployment restart invalidates those temporary links; the first subsequently
created persistent room receives ID `1`.

With no `ACCESS_PASSWORD`, the random room code is the sole viewing capability
and does not provide strong privacy, so public mode is suitable only when public
access is acceptable or another trusted access layer exists.

Production startup requires one to eight syntactically valid `stun:` URLs
before the server listens. This validates shape only; it does not prove DNS,
firewall, NAT mappings, or external STUN reachability. The current application
rejects `TURN_URLS`, `TURN_SHARED_SECRET`, or `TURN_CREDENTIAL_TTL_SECONDS` when
any key is present, including with an empty value. Remove those obsolete keys
from the candidate environment; startup fails instead of pretending they enable
compatibility.

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
as well as network metadata. They must not be treated as public artifacts; in
public mode a current code is itself the only viewing capability.

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
