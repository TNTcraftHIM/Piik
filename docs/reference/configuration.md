# Configuration And Ports

The tracked [`.env.example`](../../.env.example) is the executable schema
companion; `internal/server/config` is validation truth. Keep real values in the
service secret store or an untracked access-restricted environment file.

## Application Environment

| Variable | Contract |
| --- | --- |
| `PIIK_ENV` | `development` or `production`, default `development`; required for every server deployment: `production` enables production-only validation and the `Secure` site-access cookie. |
| `LISTEN_HOST` | Defaults to `0.0.0.0`; bare-metal production normally uses `127.0.0.1`. |
| `PORT` | Positive TCP port, default `8787`; the tracked release wrapper supports only that default. |
| `PUBLIC_BASE_URL` | Exact public HTTP(S) origin; production requires HTTPS. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) origins; wildcard is invalid. |
| `SITE_ACCESS_PASSWORD` | Production-required independent 8-128 visible-ASCII byte secret. |
| `ROOM_DATABASE_PATH` | Hosted defaults to `rooms.sqlite` in its working directory when unset or blank. An explicit absolute file path selects another SQLite file; `:memory:` opts into process-memory room authority. Client Local remains in memory. |
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

The SQLite parent directory must exist and be writable. The systemd template
sets `/var/lib/piik/rooms.sqlite` under its managed state directory; the
container image sets `/home/nonroot/rooms.sqlite` under its writable data
directory. Keep the existing database path and data across application updates.
Room authority has no idle expiry; the separate site-access cookie keeps its
24-hour idle lifetime.

Removed access, room TTL/lease, endpoint-tier, room-rollout, and TURN variables fail
startup even when blank. A present `NODE_ENV` fails the same way, so a stale
environment file cannot silently drop a deployment out of production. The
private deployment is upgraded atomically; there are no compatibility aliases or
dual configuration readers.

## Diagnostics

Diagnostics are local and opt-in. Enable them **before** reproducing the problem:

| Surface | Enable | Export |
| --- | --- | --- |
| Client | Start with `--debug` or `PIIK_DEBUG=client` | Press `D` in the terminal for a ZIP |
| Browser Host/Viewer | Add `?debug=1` to the page URL, before any invitation fragment | Use the download button beside language/theme controls |
| Hosted Server | Start with `--debug`, `PIIK_DEBUG=server` or `PIIK_DEBUG=route` | On Unix, `kill -USR1 <pid>`; also exported at orderly shutdown |

Client/Server ZIP and Browser JSON reports are separate: when investigating
Browser/Client cooperation, include both from the same reproduction. Neither
action stops an active share or uploads anything. Browser export also remains
available as `await window.__PIIK_DEBUG__.export()` in DevTools.

Client logs go to `logs` beside the executable, falling back to `Piik/logs`
in the OS user-cache directory when that default is unwritable. The TUI shows
the actual path and the exported ZIP. `--log-dir` overrides
`PIIK_LOG_DIR`; an explicit directory must be writable. Choosing a
directory alone does not enable collection. Non-interactive Clients export at
orderly shutdown. On Client, `PIIK_DEBUG=route` alone retains console route
tracing; use `--debug` for file collection and the `D` action.

Hosted logs use `PIIK_LOG_DIR`, otherwise systemd `LOGS_DIRECTORY`,
otherwise `logs` under the working directory. The service unit supplies
`/var/log/piik` with mode `0700`. Normal service notices remain in the
journal; detailed dependency records go into the report. Windows Server has no
Unix signal trigger; forced process termination cannot create a final snapshot.

The report combines operation history and existing runtime evidence:

- Native request IDs connect start/completion, duration, requested/applied
  profiles, source kind, codec/adapter selection and cancellation or failure.
  Async quality preparation retains that ID until its actual completion.
- Capture process start/exit/EOF and streamed stderr include useful failure
  causes and system/HRESULT codes. Windows samples its existing WebRTC encoder
  observer during processing: input/output FPS, actual size, bitrate, encode
  time/usage, QP when available, drops, limitation flags and adaptation counts.
  Those are VSE counters, not a complete account of WGC mailbox overwrites.
- Pion connection/ICE/DTLS and media-component diagnostics are included.
  Existing RTP/BWE/allocation observations, packet queue/drop counters,
  group demand/attachment changes and gateway/STUN outcomes explain delivery
  without adding a media-control loop or a new per-connection polling timer.
- Browser records capture settings and sender readbacks, signaling and Native
  operations, meaningful error messages/stacks/causes and existing RTCStats.
  Pool observations distinguish native carrier reports, actual output and its
  assigned producer. Export adds Browser/platform metadata; diagnostic collection
  does not replace media APIs or control transport.

Each Go component keeps an 8 MiB current log and one 8 MiB backup. ZIPs contain
these retained logs, a report marker, selected startup context, build/module and
platform metadata, Go memory counters, sampled allocation profile
(`heap.pprof`) and aggregate goroutine stacks. These are not raw process-memory
or C++ memory dumps. A failed optional collector leaves useful files available;
`metadata.json` lists included files, errors and partial status. ZIP write/disk
failure still reports an export failure. Rotation and preexisting history are
identified; retained logs do not claim a complete session history.

Browser retains up to 8,192 events and 8 MiB of compact event data in the current
page. Reports identify retained sequence/time ranges, evicted/truncated events
and collector failures. Field/record limits are explicit in the report.
Browser reload/close loses that in-page history; export before closing it.
Go ZIP exports remain until the user/operator removes them; rotation only
manages the current logs.

Credentials, authorization/cookies, invitation secrets, ICE passwords/fragments
and private keys are filtered before persistence/export. Application media
identities use diagnostic hashes where applicable; Browser/library technical
identifiers, IP addresses, device information and file paths may remain.
Do not treat a report as anonymous. Review it before sharing. Raw screen/audio
payloads, arbitrary config/environment files and raw process-memory contents
are not collected. Browser window titles and participant display names are
omitted. Debug detail has CPU/I/O cost and should be enabled for investigation.

The [research comparison](../research/diagnostic-feedback.md) records the mature
project references and the reasons for this collection boundary.

## Public And Private Ports

| Port | Scope | Owner |
| ---: | --- | --- |
| TCP 80/443 | public | HTTP redirect and HTTPS/WSS reverse proxy |
| UDP 3478 | public | in-process STUN-only Piik listener |
| UDP 3479/3480 | public when NAT prediction is enabled | in-process auxiliary STUN-only Piik listeners |
| UDP 7882 (or `SFU_UDP_PORT`) | public when SFU enabled | in-process Piik WebRTC media |
| TCP 8787 | private | Piik application |

TCP 3478, TCP/TLS 5349, TURN relay ranges, media TCP, and other media
ports remain closed. HTTPS/WSS transport is independent of the UDP-only media
contract.

When `NAT_PREDICTION_ENABLED=true`, the server derives
`stun:<same-hostname>:3479` and `:3480` from the first ordinary STUN authority
on UDP 3478. The Host sees a pre-share switch that defaults on and may disable
it. The capability adds no media route or third-party service. It needs both
cloud security-group rules and the host's `/etc/nftables.conf` rule. Piik
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
