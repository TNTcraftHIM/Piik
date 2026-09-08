# Configuration And Ports

The tracked [`.env.example`](../../.env.example) is the executable schema
companion; `internal/server/config` is validation truth. Keep real values in the
service secret store or an untracked access-restricted environment file.

## Application Environment

| Variable | Contract |
| --- | --- |
| `SCREENER_ENV` | `development` or `production`, default `development`; required for every server deployment: `production` enables production-only validation and the `Secure` site-access cookie. |
| `LISTEN_HOST` | Defaults to `0.0.0.0`; bare-metal production normally uses `127.0.0.1`. |
| `PORT` | Positive TCP port, default `8787`; the tracked release wrapper supports only that default. |
| `PUBLIC_BASE_URL` | Exact public HTTP(S) origin; production requires HTTPS. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) origins; wildcard is invalid. |
| `SITE_ACCESS_PASSWORD` | Production-required independent 8-128 visible-ASCII byte secret. |
| `ROOM_LEASE_SECONDS` | Positive dormant lease, default `86400`; active Host prevents expiry. |
| `ROOM_DATABASE_PATH` | Optional absolute SQLite file path; unset selects memory mode. |
| `MAX_VIEWERS_PER_ROOM` | `1..20`, default `8`. |
| `ENDPOINT_MEDIA_COPY_CAPACITY` | Shared endpoint steady-copy cap `1..3`, default `2`. |
| `STUN_URLS` | Comma-separated advertised `stun:` discovery URLs; at least one is required in production. These are not local bind addresses and may use an unproxied DNS name separate from the Web origin. |
| `STUN_LISTEN_HOST` | Hosted IPv4 STUN bind address, default `0.0.0.0` when `STUN_URLS` is configured; independent of HTTP `LISTEN_HOST`. Local Client construction creates no STUN listeners. |
| `NAT_PREDICTION_ENABLED` | Optional bounded NAT prediction capability, default `false`; requires an ordinary `STUN_URLS` endpoint on UDP 3478. Hosted startup binds UDP 3479/3480 before advertising the capability. Firewall reachability remains an operator requirement. |

Automatic SFU fallback runs inside the Hosted process when `SFU_UDP_PORT` is set:

| Variable | Contract |
| --- | --- |
| `SFU_UDP_PORT` | Optional UDP media port `1..65535`; unset or blank disables SFU. Set `7882` for the standard public listener. |
| `SFU_LISTEN_HOST` | IPv4 bind address, default `0.0.0.0`; independent of HTTP `LISTEN_HOST`. Read only when SFU is enabled. |
| `SFU_PUBLIC_IP` | Optional explicit IPv4 advertised-address override for a host behind NAT. Read only when SFU is enabled. |

SFU control uses the application's authenticated signaling connection. No
separate control origin or infrastructure credentials are configured. Local and
public-link Client construction create no SFU listener. The relay does not
provide application E2EE.

Removed access, room TTL, endpoint-tier, room-rollout, and TURN variables fail
startup even when blank. A present `NODE_ENV` fails the same way, so a stale
environment file cannot silently drop a deployment out of production. The
private deployment is upgraded atomically; there are no compatibility aliases or
dual configuration readers.

During pre-release route canaries, `SCREENER_DEBUG=route` enables sanitized room
and participant-ordinal events. It records route reasons, candidates, revisions,
quality states and commit/failure outcomes, but not raw Peer IDs, SDP, ICE
candidates, tokens or media credentials.

Client diagnostics use `--debug` or `SCREENER_DEBUG=client`. They add structured
lifecycle, build-revision, native-capability and fixed native-failure events to
stderr without changing the launcher/TUI or machine-readable stdout. Use
`SCREENER_DEBUG=client,route` for both Client and route events; `--debug` alone
does not enable route tracing.

For Browser diagnostics, add `?debug=1` to the page before reproducing the
problem. The page retains its last 256 bounded events and exposes
`window.__SCREENER_DEBUG__.export()` for manual JSON export from DevTools.
The report includes the Browser asset name and signaling contract, capture
exception categories, capture-setting outcomes, signaling state and native
request/state outcomes. It excludes raw exception messages, credentials,
invitation fragments, URLs, SDP, ICE candidates and media payloads. Collection
stays in the current page; there is no automatic upload or persistent log.

## Public And Private Ports

| Port | Scope | Owner |
| ---: | --- | --- |
| TCP 80/443 | public | HTTP redirect and HTTPS/WSS reverse proxy |
| UDP 3478 | public | in-process STUN-only Screener listener |
| UDP 3479/3480 | public when NAT prediction is enabled | in-process auxiliary STUN-only Screener listeners |
| UDP 7882 (or `SFU_UDP_PORT`) | public when SFU enabled | in-process Screener WebRTC media |
| TCP 8787 | private | Screener application |

TCP 3478, TCP/TLS 5349, TURN relay ranges, media TCP, and other media
ports remain closed. HTTPS/WSS transport is independent of the UDP-only media
contract.

When `NAT_PREDICTION_ENABLED=true`, the server derives
`stun:<same-hostname>:3479` and `:3480` from the first ordinary STUN authority
on UDP 3478. The Host sees a pre-share switch that defaults on and may disable
it. The capability adds no media route or third-party service. It needs both
cloud security-group rules and the host's `/etc/nftables.conf` rule. Screener
binds every required UDP listener before opening room persistence or accepting
signaling; a bind failure rolls back all newly owned sockets. Close and End
retire these listeners with the application. Existing coturn listeners must
be retired in the coordinated deployment because two processes cannot own the
same ports. Opening a cloud port without a listener has no effect, and local
binding alone does not prove external reachability. Disable the capability
before removing firewall rules. Same-IP ports
expose destination-port allocation behavior; a full RFC 5780 alternate-address
test requires a second public IPv4.

## Bounds

- Site-access requests are rate-limited at the reverse proxy and use constant-
  time secret comparison in the application.
- HTTP body, WebSocket payload, total/unauthed connections, room count, Viewer
  count, output buffers, endpoint copies, and SFU resources are bounded.
- The four-digit code space fixes the maximum managed Host publications at
  9,000; maximum subscription admission is that capacity times the configured
  per-room Viewer limit. These are admission bounds, not throughput claims.
- One application process owns room authority and SFU admission. Multiple
  processes require a new shared atomic owner.
