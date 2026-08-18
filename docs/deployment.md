# Minimal Deployment

Last verified against upstream documentation: 2026-08-18.

This is the first production-shaped deployment for the WebRTC PoC: one Node.js
process provides the built Web client, room API, and WebSocket signaling behind
Caddy or nginx. The default `MEDIA_MODE=p2p` keeps media browser-to-browser and
uses the separate coturn service only for ICE pairs that cannot connect
directly. An explicit `MEDIA_MODE=sfu` can add one same-host LiveKit process for
measurement; it is not the default and has not been deployed or benchmarked.

The public staging infrastructure has already passed the relay checks recorded
in `docs/status.md`, but every new deployment must run the direct, relay, and
mixed-network procedures below. Configuration validation alone is not evidence
that its DNS, firewall, NAT, or relay path works.

## Topology and prerequisites

The P2P baseline uses two DNS names, for example `share.example.com` and `turn.example.com`. They
may resolve to the same public IP in the minimal deployment: the Web ingress
owns TCP 443 while coturn owns UDP and TCP 3478. TURN/TLS is optional and uses
its standard TCP port 5349 by default, which can also share that public IP.

```text
browser -- HTTPS/WSS --> Caddy or nginx :443 --> Node.js :8787
browser <------------ DTLS-SRTP P2P ------------> browser
browser -- TURN only for failed ICE pairs --> coturn
```

The single-node SFU option needs no additional DNS name or certificate in the
minimal same-host layout. `LIVEKIT_URL=wss://share.example.com`; nginx routes
only LiveKit's fixed `/rtc/*` paths to port 7880 and leaves `/signal`, `/api`, and
the application routes on Node. LiveKit media reaches the host directly on
7881/TCP or 7882/UDP and never passes through the HTTP reverse proxy.

The minimum P2P runtime is Node.js 24 LTS and coturn 4.17.2 or a newer patched
release. SFU mode additionally uses the separately installed LiveKit Server
version recorded in the SFU research document. Provision a valid TLS certificate for the Web name and, only when
enabling TURN/TLS, for the TURN name. Enable operating system time
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

MEDIA_MODE=p2p
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

STUN_URLS=stun:turn.example.com:3478
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SHARED_SECRET=<SAME_VALUE_AS_COTURN_STATIC_AUTH_SECRET>
TURN_CREDENTIAL_TTL_SECONDS=3600
```

`ALLOWED_ORIGINS` must list exact `http` or `https` origins, never `*`.
`ACCESS_PASSWORD` is optional: omit it or leave it empty for a public site. A
non-empty value must contain 1 through 128 visible ASCII characters (`0x21`
through `0x7e`). For an Internet deployment intended to stay private, use an
independent value that is not reused elsewhere. `TURN_SHARED_SECRET` must
contain at least 32 bytes and must not reuse the access password.
`ROOM_DATABASE_PATH` is optional but requires `ACCESS_PASSWORD`; startup fails
if a database path is supplied without the whole-site gate. The baseline above
enables persistent protected rooms. Omit `ROOM_DATABASE_PATH` to keep random
temporary rooms, and omit both values for public mode. `ROOM_TTL_SECONDS` applies
only to temporary rooms.
`MAX_VIEWERS_PER_ROOM` defaults to 8 and accepts 1 through 16. It is an admission
limit, not evidence that the publisher can sustain that many streams.
`MEDIA_MODE` defaults to `p2p` and is fixed for the process lifetime. The three
`LIVEKIT_*` values must either all be absent or all be present; a complete tuple
may remain dormant in P2P mode for a reversible restart-based switch.
`TURN_SHARED_SECRET` stays only in the Node environment and coturn configuration;
browsers receive HMAC-SHA1-derived, time-limited credentials after room
authentication. Keep host clocks synchronized because the credential username
contains its Unix expiry time.

When `ACCESS_PASSWORD` is configured, both host and viewer routes first show the
same login gate. Only `POST /api/session` accepts the password in an
`Authorization: Bearer` header, then returns a 12-hour stateless HMAC-SHA256
cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`, a
bounded `Max-Age`, and, under production HTTPS, `Secure` plus an `__Host-` name.
The cookie contains no account or server-side session identifier. There is no
account database, access-session JWT, session map, or logout endpoint; expiry or
clearing site cookies ends access. The optional room database is unrelated to
access sessions.

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

Production P2P startup validates the configured ICE transport mix before the
server listens. The P2P baseline must contain STUN and separate `TURN_URLS` entries
for `turn:` with explicit `transport=udp` and `turn:` with explicit
`transport=tcp`. TURN/TLS is optional; when enabled, append
`turns:turn.example.com:5349?transport=tcp`. This startup check only validates
configuration shape; it does not prove that DNS, certificates, firewall rules,
NAT mappings, or the coturn listeners work from an external network. Every STUN
and TURN entry is also syntax-checked; use the exact lowercase TURN query forms
shown above because one malformed ICE URL can make a browser reject the whole
peer-connection configuration.

SFU mode instead requires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
`LIVEKIT_API_SECRET`; the API secret must contain at least 32 bytes, and production
requires a `wss:` URL. Screener does not use its
P2P `STUN_URLS`, `TURN_URLS`, or `TURN_SHARED_SECRET` to configure LiveKit.
LiveKit's ICE and any later TURN fallback are separate deployment concerns.

## HTTPS and WSS ingress

Terminate public TLS at Caddy or nginx. In P2P mode every application path goes
to the single Node process. `/signal` must preserve the WebSocket upgrade,
`Host`, and `Origin`, and its idle/read timeout must be longer than a normal
sharing session. Do not cache `/api/*` responses. Caddy's minimal P2P form is:

```caddyfile
share.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

An equivalent nginx layout, including the optional same-origin LiveKit route,
is:

```nginx
location ^~ /rtc/ {
    access_log off;
    error_log /dev/null crit;
    proxy_pass http://127.0.0.1:7880;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 5h;
    proxy_buffering off;
}

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
depend on the optional SNI router.

When Certbot manages the Web certificate, install the tracked
[`reload-nginx.sh`](../deploy/certbot/reload-nginx.sh) as an executable under
`/etc/letsencrypt/renewal-hooks/deploy/`. Run `certbot renew --dry-run` after
the first certificate is installed. This hook only reloads the Web ingress;
if optional TURN/TLS later uses a renewed certificate, configure and verify a
separate coturn reload or restart action.

Keep the proxy's access-log retention bounded and access controlled. Requests to
`/r/{code}` put the room code in the path, so access logs can contain room codes
as well as network metadata. They must not be treated as public artifacts; in
public mode a current code is itself the only viewing capability.

For a process-level liveness probe, send `GET /healthz`. A running process
returns HTTP 200 with `{"status":"ok"}` and `Cache-Control: no-store`; other
methods return 405 with `Allow: GET`. The endpoint does not inspect room state,
TURN reachability, or any external dependency, so use it only to decide whether
the Node process can accept HTTP requests. It is not a deployment-readiness or
end-to-end media check.

## Optional single-node LiveKit SFU

Enable this section only for the ADR-0003 measurement experiment. It does not
replace the P2P/coturn baseline or establish that SFU performs better on the
target machines and networks.

The tracked files are:

- [`deploy/livekit/livekit.yaml.example`](../deploy/livekit/livekit.yaml.example)
- [`deploy/systemd/livekit.service.example`](../deploy/systemd/livekit.service.example)
- the `/rtc/` location in
  [`deploy/nginx/share.bonfire.icu.conf.example`](../deploy/nginx/share.bonfire.icu.conf.example)

Install the pinned LiveKit Server release selected by the current research from
its official release assets, verify the downloaded artifact, and place the
binary at `/usr/local/bin/livekit-server`. Do not use `--dev` or the documented
development key pair in an Internet deployment. Create a dedicated `livekit`
service account and copy the YAML example to `/etc/livekit/livekit.yaml`.

Generate a unique API key pair with:

```sh
livekit-server generate-keys
```

Using a secret-aware editor, create `/etc/livekit/keys.yaml` as a single YAML
mapping from the generated API key to its secret:

```yaml
<GENERATED_API_KEY>: <GENERATED_API_SECRET>
```

Set ownership to the LiveKit service account and mode `0600`. Current LiveKit
rejects a key file whose mode grants access to `others`; the stricter example
also avoids accidental group disclosure. Put the same pair in Screener's
untracked environment; do not reuse `ACCESS_PASSWORD`, `TURN_SHARED_SECRET`, or
any example value:

```dotenv
MEDIA_MODE=sfu
LIVEKIT_URL=wss://share.example.com
LIVEKIT_API_KEY=<GENERATED_API_KEY>
LIVEKIT_API_SECRET=<GENERATED_API_SECRET>
```

`LIVEKIT_URL` is the base WebSocket origin and contains no `/rtc` suffix. The
2.22 client appends `/rtc/v1` and its validation route. nginx's exact
`location ^~ /rtc/` sends those requests to LiveKit without rewriting the URI;
the broader `/` location continues to send Screener pages, `/api/*`, and
`/signal` to Node. A separate `sfu.example.com` hostname and certificate can be
used when operational isolation is preferred, but it is not required on one
host.

The LiveKit client sends its short-lived join JWT in an `access_token` query
parameter during the WebSocket handshake. Keep access and request-line error
logging disabled specifically for `/rtc/`, as shown above, so nginx does not
persist that credential. Use the LiveKit service journal for SFU diagnostics.

The example deliberately omits Redis. It uses one UDP mux port instead of the
default large range and sets `rtc.use_external_ip: true`. LiveKit therefore
needs network-interface and external-address discovery; the systemd unit allows
`AF_NETLINK`. If discovery advertises the wrong address, diagnose the actual NAT
mapping before changing the official `node_ip`/`use_external_ip` settings.

The HTTP/API listener on 7880 must not be reachable from the Internet. LiveKit
also needs these direct public media listeners:

| Destination | Protocol | Purpose |
| --- | --- | --- |
| host `7880` | TCP, private | nginx to LiveKit HTTP/WebSocket only |
| public `7881` | TCP | WebRTC ICE/TCP fallback |
| public `7882` | UDP | WebRTC ICE/UDP mux |

Check and configure both the operating-system firewall and any provider
firewall/security group. Do not infer that one layer is open because the other
is open, and do not expose 7880 as a shortcut. If the server is behind NAT,
forward 7881/TCP and 7882/UDP without changing their ports and verify the public
candidate from an external client.

The initial template does not enable LiveKit embedded TURN and does not wire the
existing coturn into `rtc.turn_servers`. ICE/TCP 7881 is the first non-UDP
fallback, but it cannot cross every authenticated proxy or restrictive policy.
Reusing coturn is a plausible next deployment change only after its shared-secret
credential flow and forced-relay behavior are verified with LiveKit clients.
Embedded TURN on the same public IP would also compete with the existing 3478
and HTTPS/TURN-TLS listeners. Treat strict-network coverage in SFU mode as
unverified until one option passes the external matrix.

Install the tracked unit, reload systemd, and start LiveKit only after the
configuration, key permissions, reverse-proxy route, host firewall, and provider
firewall have been reviewed. Starting the process or obtaining a WSS connection
does not verify media reachability.

## coturn

Copy [`deploy/coturn/turnserver.conf.example`](../deploy/coturn/turnserver.conf.example)
to an untracked service-owned location. Replace the FQDN and secret. The
`static-auth-secret` value must exactly match the application's
`TURN_SHARED_SECRET`; do not configure `no-auth` or permanent browser users.
Certificate paths are needed only if the optional TURN/TLS block is enabled.

When the application and coturn configs share a parent directory, both service
accounts must be able to traverse that directory. One minimal layout is a
`root:root` directory with mode `0751`, an application environment file owned
by `root:screener` with mode `0640`, and a coturn config owned by
`root:turnserver` with mode `0640`. Verify readability as the actual service
user before starting coturn. The tracked systemd unit deliberately fails its
pre-start check when the coturn config is missing or unreadable; coturn itself
may otherwise warn and continue with unsafe defaults.

On a host with a public address directly on its interface, coturn can select the
single listen/relay address automatically. On a multi-homed host, set
`listening-ip` and `relay-ip` explicitly. Behind 1:1 NAT, also set
`external-ip=<PUBLIC_IP>/<LOCAL_RELAY_IP>` and forward the complete relay range
without port translation. A normal consumer NAT that changes relay port numbers
is not a supported TURN-host topology.

The minimum deployment exposes TURN/UDP and TURN/TCP on 3478. `turn:` over TCP
does not add TLS between the client and coturn, but relayed WebRTC media remains
protected end to end by DTLS-SRTP. Optional TURN/TLS should listen directly on
standard TCP 5349 and use `turns:turn.example.com:5349?transport=tcp`.

TCP 443 is an optional enhancement for networks that block uncommon ports. On
the same public IP, coturn cannot bind it while the Web ingress already owns it.
Use a second public IP or an explicitly validated layer-4/SNI router, such as
the optional
[`tls-sni-router.conf.example`](../deploy/nginx/tls-sni-router.conf.example).
That router requires moving the site's TLS virtual host to loopback TCP 8443;
the default nginx site template intentionally does not do this. A normal
Cloudflare HTTP proxy does not carry TURN even on port 443. Keep the TURN DNS
record DNS-only, or use a compatible layer-4 service such as Cloudflare
Spectrum; the Web hostname may remain HTTP-proxied independently.

Open only these public listeners:

| Destination | Protocol | Purpose |
| --- | --- | --- |
| `share.example.com:443` | TCP | HTTPS and WSS |
| `turn.example.com:3478` | UDP and TCP | STUN, TURN/UDP, and TURN/TCP |
| `turn.example.com:49152-49251` | UDP, bidirectional | Relayed media endpoints |
| `turn.example.com:5349` | TCP, optional | Standard TURN/TLS |
| `turn.example.com:443` | TCP, optional | TURN/TLS on a dedicated IP or validated L4/SNI route |
| host public address `:7881` | TCP, SFU mode | LiveKit ICE/TCP; never HTTP proxy traffic |
| host public address `:7882` | UDP, SFU mode | LiveKit ICE/UDP mux |

Keep LiveKit TCP 7880 absent from every public allowlist. The two SFU media rows
are required only when `MEDIA_MODE=sfu`; they do not change the default P2P
exposure.

The 100-port relay range is an initial small-room limit, not a universal sizing
rule. Monitor 508/allocation failures and concurrent allocations before widening
it. The example also sets `user-quota=32`, `total-quota=100`, and a per-allocation
`max-bps` of 2,000,000 bytes/s. Tune these from measured 1080p60 traffic and the
purchased egress capacity; never remove all quotas as a shortcut. The per-user
value leaves allocation headroom for the host's independent connections and ICE
restarts in an eight-viewer room; it is not a claim that the application or
relay can sustain 1:8 media.

coturn 4.17.2 denies loopback peers unless `allow-loopback-peers` is enabled; the
example deliberately does not enable it and additionally denies common private,
carrier-grade NAT, link-local, and benchmark ranges. Keep `no-multicast-peers` and
`no-cli`. If the TURN host must intentionally reach an internal peer, narrow an
exception to that exact address instead of removing the deny list.

The example writes informational logs to stdout. Configure the supervisor to
rotate by size and time with a finite retention, such as seven days initially,
then reduce or extend it only for a documented operational need. coturn and the
reverse proxy necessarily see client IP addresses; restrict log access, do not
enable `verbose` or `log-binding` continuously, and never log credentials, SDP,
ICE candidates, or the shared secret. When TURN/TLS is enabled, reload or
restart coturn after certificate renewal. Confirm time synchronization remains
healthy in every deployment.

## Verification

Run these checks from real external networks before calling the deployment usable:

1. Open the official [Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   and test each configured TURN URL separately with a short-lived credential.
   Each required UDP and TCP test must produce a `relay` candidate; test TLS too
   when it is configured. A successful STUN-only `srflx` candidate does not
   prove TURN works.
2. Create a normal Screener room on two different networks. Confirm media flows
   and the selected-pair stats report a non-relay path when direct ICE succeeds.
3. Open the host at `https://share.example.com/?relay=1`, create a new room, and
   connect a viewer. This diagnostic flag sets `iceTransportPolicy=relay`; media
   must still flow and the stats panel must report `relay`.
4. Block UDP on a test client while leaving TURN/TCP reachable. Confirm a new
   session succeeds through `turn:turn.example.com:3478?transport=tcp`.
5. If TURN/TLS is enabled, test its `turns:` URL separately on 5349 or the
   explicitly configured 443 route. Failure of an optional endpoint must be
   diagnosed, but an intentionally omitted endpoint is not a deployment failure.
6. Repeat at 1, 3, 5, and 8 viewers with a mixed direct/restrictive-network cohort.
   Record the selected path, RTT, bitrate, frame rate, packet loss, publisher
   upload/encode load, and coturn egress for each viewer. Verify a direct viewer
   does not start consuming relay bandwidth merely because another viewer needs
   TURN. A real 1:8 session is currently unverified and must not be inferred from
   the configured admission limit.

For an SFU deployment, run a separate matrix rather than treating the P2P relay
results as transferable:

1. Confirm `https://share.example.com/` still serves Screener, `/signal` still
   upgrades to Screener, and a LiveKit client reaches the same origin through
   `/rtc/v1`; port 7880 must remain unreachable from an external host.
2. From an external network, confirm a publisher and viewer select LiveKit's
   7882/UDP candidate and receive screen video plus available screen audio.
3. Block UDP and verify a newly established session can use 7881/TCP. Record a
   clear failure if the test network also blocks that port; do not claim TURN
   fallback unless a separately configured TURN path is forced and observed.
4. Stop sharing and publish again in the same Screener room. Viewers must wait
   without losing the invitation, then receive the new publication. Repeat a
   source replacement and a short Screener `/signal` interruption.
5. Compare 1, 3, 5, and 8 viewers against P2P using the same source and quality
   profile. Record broadcaster upload/encode load, LiveKit ingress/egress/CPU,
   selected transport, viewer bitrate/frame rate/loss, first picture, and
   glass-to-glass latency on desktop and mobile.

The SFU remains experimental until this evidence is recorded. Conventional
LiveKit transport encryption does not exclude the server from media access and
must not be reported as E2EE.

References: [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2),
[turnserver documentation](https://github.com/coturn/coturn/blob/master/README.turnserver),
the [official example configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf),
[TURN URI scheme RFC 7065](https://www.rfc-editor.org/rfc/rfc7065.html),
[Cloudflare network-port guidance](https://developers.cloudflare.com/fundamentals/reference/network-ports/),
[RFC6265bis](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/),
[Node.js Crypto](https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options),
[LiveKit self-hosted deployment](https://docs.livekit.io/transport/self-hosting/deployment/),
[LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/),
and the [LiveKit configuration sample](https://github.com/livekit/livekit/blob/master/config-sample.yaml).
