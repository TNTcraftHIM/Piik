# Configuration And Ports

The tracked [`.env.example`](../../.env.example) is the executable schema
companion; `internal/server/config` is validation truth. Keep real values in the
service secret store or an untracked access-restricted environment file.

## Ownership

- Deployment configuration owns listeners, advertised origins, persistence,
  admission, capacity and optional services. Change it before starting the process.
- The Host owns share settings and the available per-share route switches in the
  shared Web UI. Server and App use the same controls, order and semantics;
  configuration changes availability, not which controls exist. A fixed switch
  remains visible and explains the reason in text or its pure-visual hint.
- Protocol versions, queue bounds and routing/adaptation constants stay in code.
  They are not deployment tuning knobs. Debug and report destinations are
  explicit diagnostic options, not normal share settings.

## Application Environment

| Variable | Contract |
| --- | --- |
| `PIIK_ENV` | `development` or `production`, default `development`; required for every server deployment: `production` enables production-only validation and the `Secure` site-access cookie. |
| `LISTEN_HOST` | Defaults to `0.0.0.0`; bare-metal production normally uses `127.0.0.1`. |
| `PORT` | Positive TCP port, default `8787`; the tracked release wrapper supports only that default. |
| `PUBLIC_BASE_URL` | Exact public HTTP(S) origin; production requires HTTPS. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTP(S) origins; wildcard is invalid. |
| `SITE_ACCESS_PASSWORD` | Optional in every environment. Unset or empty allows entry without a site password. A configured value is matched exactly, including spaces and Unicode; there are no password length or character rules. General HTTP request limits still apply. Room ownership and Viewer admission remain independent. |
| `ROOM_DATABASE_PATH` | Hosted defaults to `rooms.sqlite` in its working directory when unset or blank. An explicit absolute file path selects another SQLite file; `:memory:` opts into process-memory room authority. App Local remains in memory. |
| `MAX_VIEWERS_PER_ROOM` | `1..20`, default `8`. |
| `ENDPOINT_MEDIA_COPY_CAPACITY` | Shared endpoint steady-copy cap `1..3`, default `2`. |
| `STUN_URLS` | Comma-separated advertised `stun:` discovery URLs; at least one is required in production. These are not local bind addresses and may use an unproxied DNS name separate from the Web origin. |
| `STUN_LISTEN_HOST` | Hosted IPv4 STUN bind address, default `0.0.0.0` when `STUN_URLS` is configured; independent of HTTP `LISTEN_HOST`. Local App construction creates no STUN listeners. |
| `NAT_PREDICTION_ENABLED` | Optional bounded NAT prediction capability, default `false`; requires an ordinary `STUN_URLS` endpoint on UDP 3478. Hosted startup binds UDP 3479/3480 before advertising the capability. When unavailable, the visible NAT switch is locked off; ordinary ICE remains. Firewall reachability remains an operator requirement. |

Automatic SFU fallback runs inside the Hosted process when `SFU_UDP_PORT` is set:

| Variable | Contract |
| --- | --- |
| `SFU_UDP_PORT` | Optional UDP media port `1..65535`; unset or blank disables SFU and fixes Privacy mode on for every room. Set `7882` for the standard public listener and allow the Host to choose Privacy mode. |
| `SFU_LISTEN_HOST` | IPv4 bind address, default `0.0.0.0`; independent of HTTP `LISTEN_HOST`. Read only when SFU is enabled. |
| `SFU_PUBLIC_IP` | Optional explicit IPv4 advertised-address override for a host behind NAT. Read only when SFU is enabled. |

SFU control uses the application's authenticated signaling connection. No
separate control origin or infrastructure credentials are configured. Local and
public-link App construction create no SFU listener. The relay does not
provide application E2EE.

For a P2P-only Server, leave `SFU_UDP_PORT` blank. Room authority, signaling,
configured STUN and peer relays remain; no media-server fallback is possible.
The server enforces this even if a Host requests hybrid mode. There is no
separate `SFU_ENABLED` flag to conflict with the listener configuration.

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
dual configuration readers. [Versioning](./versioning.md) owns the planned public
upgrade promise and the work required before its first release.

## Piik App Configuration

Piik App stores `Piik/client.json` under the operating system's user configuration
directory (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
and `$XDG_CONFIG_HOME` or `~/.config` on Linux). The App manages its `version`
schema field. The user settings are:

| Setting | Contract |
| --- | --- |
| `site` | Saved Piik Site origin. The launcher or `--site` updates it. |
| `localAccessPassword` | Empty by default. Optional password for the App's Local room authority, with the same exact-match behavior as `SITE_ACCESS_PASSWORD`. It is separate from a hosted site's password. |

The launcher preselects a saved Site when present; otherwise it preselects the
public invitation link. Selecting a mode does not start it: the user confirms
with the launch button. Local mode remains available for the same network.
For Local mode, the launcher selects a sole active address or sole private IPv4
address automatically. With several choices it shows interface names and IPs;
an ambiguous choice must be selected before launch. `--lan-address` preselects
an active address. Selection applies to this launch and is revalidated at startup.
It sets the local invitation origin; HTTP still listens on the existing wildcard
listener and ICE remains free to use available media interfaces. Public Link and
Site mode require no local address selection.

Command-line options select entry and local runtime behavior:

| Option | Purpose |
| --- | --- |
| `--site <origin>` / `--local` | Save and use a Site, or select the self-contained Local mode. Mutually exclusive. |
| `--link` | Create a public Viewer invitation for Local mode. |
| `--config <path>` | Select another App configuration file. |
| `--lan-address <IPv4>` / `--port <port>` | Override the Local invitation address or HTTP port (default `8787`). |
| `--capture-process <path>` / `--tunnel-process <path>` | Override packaged native capture or public tunnel helpers. Ordinary installations use the packaged paths. |
| `--debug` / `--log-dir <path>` | Enable diagnostics or choose their destination as described below. |

Share quality, room access policy, language and theme are configured in
the shared Web UI. Decorative motion follows the system's reduced-motion preference.

## Diagnostics

Normal Server logs record startup identity, listener and enabled services,
unexpected failures, orderly shutdown and any available release found by the
single background startup check. Detailed room/ICE/media traces require Debug.

Diagnostics are local and opt-in. Enable them **before** reproducing the problem:

| Surface | Enable | Export |
| --- | --- | --- |
| App | Enable **Debug launch** with the small chip icon after the theme control in the mode selector, or start with `--debug` / `PIIK_DEBUG=client` | Press `D` in the terminal for a ZIP |
| Browser Host/Viewer | Click the **Debug** chip icon after the theme control and confirm the reload, or add `?debug=1` before any invitation fragment | The same control becomes a download arrow for the web report |
| Hosted Server | Start with `--debug`, `PIIK_DEBUG=server` or `PIIK_DEBUG=route` | On Unix, `kill -USR1 <pid>`; also exported at orderly shutdown |

App **Debug launch** enables App and Browser collection for that run before
starting the selected mode. It records Native capability results and subsequent
capture, connection and local-server activity. Use `--debug` for failures before
the mode selector opens. This choice does not change the saved App configuration.
When bypassing the mode selector, `--debug` and `PIIK_DEBUG=client` enable backend
collection; enable the Browser control separately for browser-side diagnosis.

The Browser entry reloads the current page so collection includes connection
startup. The opt-in follows App launch and room entry. Enabling it keeps the
current URL parameters and any invitation fragment, but interrupts active
sharing/viewing; enable it before reproducing the problem. Reports remain local
until exported and shared by the user.

Server Debug is controlled by its startup environment or CLI, never by a remote
page or room role. Browser `?debug=1` only enables that page's local collection;
it does not enable App Native/capture or Server logging, or download their
reports. The Server exposes no HTTP diagnostic export or pprof endpoint.

App/Server ZIP and Browser JSON reports are separate: when investigating
Browser/App cooperation, include both from the same reproduction. Exporting
either report does not stop an active share or upload anything. Browser export
also remains available as `await window.__PIIK_DEBUG__.export()` in DevTools.

App logs go to `logs` beside the executable, falling back to `Piik/logs`
in the OS user-cache directory when that default is unwritable. The TUI shows
the actual path and the exported ZIP. `--log-dir` overrides
`PIIK_LOG_DIR`; an explicit directory must be writable. Choosing a
directory alone does not enable collection. Non-interactive Apps export at
orderly shutdown; a returned App error also exports before the terminal closes.
On App, `PIIK_DEBUG=route` alone retains console route
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
  Each RTC sample includes a compact ICE summary ahead of the bounded raw stats:
  reported pair states and selected-path type, prediction provenance, check
  responses and RTT when available. Pair counts describe that sample, not route
  attempts or a connection-success rate.

Each Go component keeps an 8 MiB current log and one 8 MiB backup. ZIPs contain
these retained logs, a report marker, selected startup context, build/module and
platform metadata, Go memory counters, sampled allocation profile
(`heap.pprof`) and aggregate goroutine stacks. These are not raw process-memory
or C++ memory dumps. A failed optional collector leaves useful files available;
`metadata.json` lists included files, errors and partial status. ZIP write/disk
failure still reports an export failure. Rotation and preexisting history are
identified; retained logs do not claim a complete session history.

Exported ZIPs remain until the user moves or deletes them; rotation manages only
the current logs. Repeated exports and Debug-mode error exits accumulate archives,
so manage that directory's disk usage separately.

Browser retains up to 8,192 events and 8 MiB of compact event data in the current
page. Reports identify retained sequence/time ranges, evicted/truncated events
and collector failures. Field/record limits are explicit in the report.
Browser reload/close loses that in-page history; export before closing it.

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
