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
| `STUN_URLS` | Comma-separated `stun:` URLs; at least one is required in production. |
| `NAT_PREDICTION_ENABLED` | Optional bounded NAT prediction capability, default `false`; requires an ordinary `STUN_URLS` endpoint on UDP 3478 plus reachable same-host UDP 3479/3480 listeners. |

Automatic SFU fallback is enabled when all four values below are present:

| Variable | Contract |
| --- | --- |
| `LIVEKIT_URL` | Browser `ws:`/`wss:` origin with no path; production requires WSS. |
| `LIVEKIT_API_URL` | RoomService `http:`/`https:` origin with no path; production plaintext is loopback-only. |
| `LIVEKIT_API_KEY` | Independent LiveKit API key. |
| `LIVEKIT_API_SECRET` | Independent secret of at least 32 bytes. |

The site-access password, LiveKit API key, and LiveKit secret must not reuse one
another. LiveKit tokens are short-lived media credentials and do not provide
application E2EE.

Removed access, room TTL, endpoint-tier, room-rollout, and TURN variables fail
startup even when blank. A present `NODE_ENV` fails the same way, so a stale
environment file cannot silently drop a deployment out of production. The
private deployment is upgraded atomically; there are no compatibility aliases or
dual configuration readers.

During pre-release route canaries, `SCREENER_DEBUG=route` enables sanitized room
and participant-ordinal events. It records route reasons, candidates, revisions,
quality states and commit/failure outcomes, but not raw Peer IDs, SDP, ICE
candidates, tokens or media credentials.

## Public And Private Ports

| Port | Scope | Owner |
| ---: | --- | --- |
| TCP 80/443 | public | HTTP redirect and HTTPS/WSS reverse proxy |
| UDP 3478 | public | STUN-only coturn |
| UDP 3479/3480 | public when NAT prediction is enabled | auxiliary STUN-only coturn listeners |
| UDP 7882 | public when SFU enabled | LiveKit WebRTC media |
| TCP 8787 | private | Screener application |
| TCP 7880 | private when SFU enabled | LiveKit signaling/control |

TCP 3478, TCP/TLS 5349, TURN relay ranges, LiveKit media TCP, and other media
ports remain closed. HTTPS/WSS transport is independent of the UDP-only media
contract.

When `NAT_PREDICTION_ENABLED=true`, the server derives
`stun:<same-hostname>:3479` and `:3480` from the first ordinary STUN authority
on UDP 3478. The Host sees a pre-share switch that defaults on and may disable
it. The capability adds no media route or third-party service. It needs both
cloud security-group rules and the host's `/etc/nftables.conf` rule; coturn must
bind both auxiliary listeners with `aux-server`. Opening a cloud port without a
listener has no effect, and no new DNS record is required. Disable the
capability before removing either listener or firewall rule. Same-IP ports
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
- One application process owns room authority and LiveKit admission. Multiple
  processes require a new shared atomic owner.
