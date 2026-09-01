# Configuration And Ports

The tracked [`.env.example`](../../.env.example) is the executable schema
companion; `src/server/config.ts` is validation truth. Keep real values in the
service secret store or an untracked access-restricted environment file.

## Application Environment

| Variable | Contract |
| --- | --- |
| `NODE_ENV` | `production` enables production-only validation. |
| `LISTEN_HOST` | Defaults to `0.0.0.0`; bare-metal production normally uses `127.0.0.1`. |
| `PORT` | Positive TCP port, default `8787`; the tracked release wrapper supports only that default. |
| `PUBLIC_BASE_URL` | Exact public HTTP(S) origin; production requires HTTPS. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) origins; wildcard is invalid. |
| `SITE_ACCESS_PASSWORD` | Production-required independent 8-128 visible-ASCII byte secret. |
| `ROOM_LEASE_SECONDS` | Positive dormant lease, default `86400`; active Host prevents expiry. |
| `ROOM_DATABASE_PATH` | Optional absolute SQLite file path; unset selects memory mode. |
| `MAX_VIEWERS_PER_ROOM` | `1..20`, default `8`. |
| `PEER_ASSISTED_MEDIA` | Enables the all-room bounded Peer/SFU controller. |
| `ENDPOINT_MEDIA_COPY_CAPACITY` | Shared endpoint steady-copy cap `1..3`, default `2`. |
| `STUN_URLS` | Comma-separated `stun:` URLs; at least one is required in production. |

Automatic SFU fallback is enabled only when `PEER_ASSISTED_MEDIA=true` and all
four values below are present:

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
startup even when blank. The private deployment is upgraded atomically; there
are no compatibility aliases or dual configuration readers.

During pre-release route canaries, standard Node `NODE_DEBUG=screener-route`
enables sanitized room and participant-ordinal events. It records route reasons,
candidates, revisions, quality states and commit/failure outcomes, but not raw
Peer IDs, SDP, ICE candidates, tokens or media credentials.

## Public And Private Ports

| Port | Scope | Owner |
| ---: | --- | --- |
| TCP 80/443 | public | HTTP redirect and HTTPS/WSS reverse proxy |
| UDP 3478 | public | STUN-only coturn |
| UDP 3479/3480 | temporary public during approved NAT survey | auxiliary STUN-only coturn listeners |
| UDP 7882 | public when SFU enabled | LiveKit WebRTC media |
| TCP 8787 | private | Screener application |
| TCP 7880 | private when SFU enabled | LiveKit signaling/control |

TCP 3478, TCP/TLS 5349, TURN relay ranges, LiveKit media TCP, and other media
ports remain closed. HTTPS/WSS transport is independent of the UDP-only media
contract.

The optional NAT survey uses `stun:<same-hostname>:3479` and `:3480` in a
diagnostic page only. It does not change `STUN_URLS`, ordinary Peer ICE, or any
media route, and it needs both cloud security-group rules and the host's
`/etc/nftables.conf` rule. Coturn must bind the auxiliary listeners to the
host's local address with `aux-server`; opening a cloud port without a listener
has no effect. No new DNS record is required. Same-IP ports measure destination
port allocation behavior; a full RFC 5780 alternate-address test requires a
second public IPv4.

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
