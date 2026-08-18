# Minimal Deployment

Last verified against upstream documentation: 2026-08-18.

This is the first production-shaped deployment for the WebRTC PoC: one Node.js
process provides the built Web client, room API, and WebSocket signaling behind
Caddy or nginx; coturn is the separate STUN/TURN service. Normal media remains
browser-to-browser. Only an ICE pair that cannot connect directly consumes TURN
bandwidth.

This workstation does not have coturn installed, so the coturn configuration and
public-network procedures below have not been run locally. Treat deployment as
unverified until the direct, relay, and mixed-network checks at the end pass.

## Topology and prerequisites

Use two DNS names, for example `share.example.com` and `turn.example.com`.
The simplest deployment gives the TURN name a separate public IP so coturn can
bind TCP 443; otherwise use an explicitly validated layer-4/SNI gateway:

```text
browser -- HTTPS/WSS --> Caddy or nginx :443 --> Node.js :8787
browser <------------ DTLS-SRTP P2P ------------> browser
browser -- TURN only for failed ICE pairs --> coturn
```

The minimum runtime is Node.js 24 LTS and coturn 4.17.2 or a newer patched
release. Provision a valid TLS certificate for each public name, enable operating
system time synchronization, and keep the Node application port reachable only
from its reverse proxy. A single Node process is intentional: rooms are held in
memory, so restarting it ends signaling and invalidates room state.

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
ROOM_CREATION_TOKEN=<INDEPENDENT_RANDOM_SECRET>
ROOM_TTL_SECONDS=14400
MAX_ROOMS=1000

STUN_URLS=stun:turn.example.com:3478
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp
TURN_SHARED_SECRET=<SAME_VALUE_AS_COTURN_STATIC_AUTH_SECRET>
TURN_CREDENTIAL_TTL_SECONDS=3600
```

`ALLOWED_ORIGINS` must list exact `http` or `https` origins, never `*`.
`ROOM_CREATION_TOKEN` and `TURN_SHARED_SECRET` must each contain at least 32
bytes. They must be independently generated rather than reused.
`TURN_SHARED_SECRET` stays only in the Node environment and coturn configuration;
browsers receive HMAC-SHA1-derived, time-limited credentials after room
authentication. Keep host clocks synchronized because the credential username
contains its Unix expiry time.

Production startup validates the configured TURN transport mix before the
server listens. The baseline must contain separate `TURN_URLS` entries for
`turn:` with explicit `transport=udp`, `turn:` with explicit `transport=tcp`,
and `turns:` with explicit port 443 and `transport=tcp`. This startup check only
validates configuration shape; it does not prove that DNS, certificates,
firewall rules, NAT mappings, or the coturn listeners work from an external
network. Every STUN and TURN entry is also syntax-checked; use the exact
lowercase TURN query forms shown above because one malformed ICE URL can make a
browser reject the whole peer-connection configuration.

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

Keep the proxy's access-log retention bounded and access controlled. Viewer
tokens are URL fragments and therefore are not sent in HTTP requests, but logs
still contain network metadata and must not be treated as public artifacts.

For a process-level liveness probe, send `GET /healthz`. A running process
returns HTTP 200 with `{"status":"ok"}` and `Cache-Control: no-store`; other
methods return 405 with `Allow: GET`. The endpoint does not inspect room state,
TURN reachability, or any external dependency, so use it only to decide whether
the Node process can accept HTTP requests. It is not a deployment-readiness or
end-to-end media check.

## coturn

Copy [`deploy/coturn/turnserver.conf.example`](../deploy/coturn/turnserver.conf.example)
to an untracked service-owned location. Replace the FQDN, certificate paths, and
secret. The `static-auth-secret` value must exactly match the application's
`TURN_SHARED_SECRET`; do not configure `no-auth` or permanent browser users.

On a host with a public address directly on its interface, coturn can select the
single listen/relay address automatically. On a multi-homed host, set
`listening-ip` and `relay-ip` explicitly. Behind 1:1 NAT, also set
`external-ip=<PUBLIC_IP>/<LOCAL_RELAY_IP>` and forward the complete relay range
without port translation. A normal consumer NAT that changes relay port numbers
is not a supported TURN-host topology.

The example binds TURN/TLS to 443 because that is the required restrictive-network
fallback. It requires a separate public IP for `turn.example.com` or an ingress
that explicitly supports TURN at layer 4/SNI. A normal HTTPS reverse proxy and
coturn cannot both bind the same IP and port.

Open only these public listeners:

| Destination | Protocol | Purpose |
| --- | --- | --- |
| `share.example.com:443` | TCP | HTTPS and WSS |
| `turn.example.com:3478` | UDP and TCP | STUN, TURN/UDP, and TURN/TCP |
| `turn.example.com:443` | TCP | TURN/TLS on a dedicated IP or L4/SNI route |
| `turn.example.com:49152-49251` | UDP, bidirectional | Relayed media endpoints |

The 100-port relay range is an initial small-room limit, not a universal sizing
rule. Monitor 508/allocation failures and concurrent allocations before widening
it. The example also sets `user-quota=8`, `total-quota=100`, and a per-allocation
`max-bps` of 2,000,000 bytes/s. Tune these from measured 1080p60 traffic and the
purchased egress capacity; never remove all quotas as a shortcut.

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
ICE candidates, or the shared secret. Reload or restart coturn after certificate
renewal and confirm time synchronization remains healthy.

## Verification

Run these checks from real external networks before calling the deployment usable:

1. Open the official [Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   and test each configured TURN URL separately with a short-lived credential.
   Each UDP, TCP, and TLS test must produce a `relay` candidate; a successful
   STUN-only `srflx` candidate does not prove TURN works.
2. Create a normal Screener room on two different networks. Confirm media flows
   and the selected-pair stats report a non-relay path when direct ICE succeeds.
3. Open the host at `https://share.example.com/?relay=1`, create a new room, and
   connect a viewer. This diagnostic flag sets `iceTransportPolicy=relay`; media
   must still flow and the stats panel must report `relay`.
4. Block UDP on a test client while leaving the TURN/TLS endpoint reachable.
   Confirm a new session succeeds through the configured `turns:` URL.
5. Repeat with three viewers and a mixed direct/restrictive-network cohort. Record
   the selected path, RTT, bitrate, frame rate, packet loss, and coturn egress for
   each viewer. Verify a direct viewer does not start consuming relay bandwidth
   merely because another viewer needs TURN.

References: [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2),
[turnserver documentation](https://github.com/coturn/coturn/blob/master/README.turnserver),
and the [official example configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).
