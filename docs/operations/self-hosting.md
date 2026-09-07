# Self-Hosting Operations

This runbook owns initial single-host service setup. Application releases use
[deployment](../deployment.md); accepted environment values and ports are in
[configuration reference](../reference/configuration.md).

## Embedded Media Configuration

The current source embeds STUN and SFU in the Screener process under
[ADR-0013](../adr/0013-embedded-node-local-media.md). Hosted `STUN_URLS`
advertises ordinary discovery and enables the UDP 3478 listener on
`STUN_LISTEN_HOST` (IPv4, default `0.0.0.0`). Enabling
`NAT_PREDICTION_ENABLED` also binds UDP 3479/3480 on that address. Local and
public-link Client modes use discovery without creating media-service listeners.

Set `SFU_UDP_PORT=7882` to enable automatic embedded SFU fallback. Its IPv4 bind
address is `SFU_LISTEN_HOST`, default `0.0.0.0`; `SFU_PUBLIC_IP` optionally
overrides the advertised IPv4 address when the host is behind NAT. Unset or
blank `SFU_UDP_PORT` keeps SFU disabled. SFU control uses authenticated Screener
signaling through the Web origin. No separate media-service executable, control
origin, or API credentials are needed by this source contract.

These source templates describe the embedded candidate. Production cutover,
active-session acceptance, and public media verification remain pending.

## Single-Host Topology

```text
Browser -- HTTPS/WSS --> nginx :443 --> Screener :8787
Browser <---------- DTLS-SRTP P2P ----------> Browser
Browser -------- ordinary STUN/UDP --------> Screener :3478
Browser -------- optional STUN/UDP --------> Screener :3479/3480
Browser <--------- DTLS-SRTP/UDP ----------> Screener :7882
```

The public baseline uses one Screener Go binary, nginx, a valid Web TLS
certificate, and time synchronization. nginx terminates Web HTTPS/WSS and
proxies only to Screener's private application listener; media UDP reaches the
Go process directly. There is no separate SFU token endpoint or TCP 7880 service.
Web and STUN may use different DNS names on the same public IP. Another proxy or
firewall owner needs its own matching updater and recovery checks.

Expose only the public listeners in
[configuration reference](../reference/configuration.md). Screener TCP 8787 stays
private. STUN answers Binding requests only; TURN allocations remain unavailable.

## Templates

- [Screener systemd unit](../../deploy/systemd/screener.service.example)
- [nginx site](../../deploy/nginx/share.bonfire.icu.conf.example)

Copy templates outside the repository, inject independent secrets through an
access-restricted environment file or service manager, and adapt only addresses,
domains, certificates, users, and resource limits required by the host.

## Initial Setup

1. Configure DNS and TLS for the Web origin and STUN name.
2. Install nginx. The Screener release is one static binary and needs no
   language runtime or separate media-service executable.
3. Create an unprivileged `screener` service account, `/opt/screener/releases`,
   `/opt/screener/uploads`, and an access-restricted environment file.
4. Provision one verified initial immutable release and atomically point
   `/opt/screener/current` to it before enabling the unit. The tracked release
   wrapper is upgrade-only and deliberately refuses a missing prior release;
   this repository does not provide a generic first-install transaction.
5. When stable room authority is enabled, use the service-owned
   `/var/lib/screener` StateDirectory and include the SQLite file in the host's
   state backup/recovery policy.
6. Install the tracked service and proxy templates. Bind HTTP to loopback on
   bare metal; STUN and SFU retain their independent public IPv4 binds.
   Containers may bind HTTP to `0.0.0.0` only when publishing/firewall rules
   preserve the private application boundary.
7. Apply the public-port allowlist and confirm every retired TURN/TCP port
   is closed.
8. Start Screener, then nginx. Screener binds its configured media listeners
   before accepting signaling and closes them with the application; a listener
   bind failure rolls back startup. Verify public UDP reachability separately.

## Coordinated Embedded-Media Cutover

Replacing the external STUN/SFU services, including Node-to-Go where still
needed, is one explicitly authorized infrastructure and protocol transaction.
The routine application wrapper cannot perform or recover it.

1. Prepare and verify matching `screener-v22` Web/Server and native protocol v9
   Client artifacts. Check active sessions and obtain the owner's acceptance of
   share interruption before cutover; old pages and Clients must reload or
   update together.
2. Retain the exact prior release path, Screener unit and drop-ins, environment,
   nginx configuration, and external media-service units, configuration, secrets,
   and enabled/active state for rollback. Keep this material access-restricted
   outside the repository. Define recovery for any persistent-state or firewall
   surface the transaction actually changes.
3. Stage the current unit with
   `ExecStart=/opt/screener/current/screener-server` and
   `SCREENER_ENV=production`. Remove retired `NODE_ENV`, `PEER_ASSISTED_MEDIA`
   and external `LIVEKIT_*` configuration; use the current
   [environment contract](../reference/configuration.md), including
   `SFU_UDP_PORT=7882` when fallback is enabled. Replace route `NODE_DEBUG` with
   `SCREENER_DEBUG=route` when needed. Validate the new binary's production
   configuration as the service user before switching.
4. Stop Screener and the old coturn/LiveKit services. Disable those old media
   services and remove the installed Screener LiveKit-readiness drop-in so they
   cannot reclaim ports or delay startup. Verify that UDP 3478/3479/3480/7882
   are released before the new Go process binds them. Install the current unit,
   environment and nginx template, remove the old RTC proxy locations, validate
   nginx, and reload systemd. Preserve unrelated proxy headers, limits, TLS,
   asset handling, and firewall rules.
5. Atomically point the current release at the verified candidate, start
   Screener, and reload nginx. Verify the actual unit command and environment,
   local/public health, the matching Web asset, UDP listener ownership, public
   STUN Binding and admitted SFU media, and the agreed active-session outcome.
6. On failure, stop the new Go process and confirm it released its UDP sockets.
   Restore the exact prior application path, unit/drop-ins, environment, proxy
   and changed infrastructure configuration; reload systemd and validate nginx.
   Restore the previous external service states before starting the previous
   application with its matching unit, then prove health and media. Restore
   matching pages and Clients as part of protocol rollback. A symlink-only
   rollback cannot recover this transaction.

Retain the recovery material through the agreed acceptance window. This is a
single replacement contract with no permanent legacy aliases or migration mode.
Later application-only releases use the ordinary
[release wrapper](../deployment.md#atomic-cutover).

## Optional NAT Prediction

Allow UDP 3479 and 3480 in both the cloud security group and the existing
nftables input rule, validating the complete ruleset with
`nft -c -f /etc/nftables.conf`. Set `NAT_PREDICTION_ENABLED=true` and restart
Screener within an accepted service window. Verify `ss -lunp` shows all three
Screener STUN listeners and that a public Binding request succeeds on each.
Do not add auxiliary URLs to `STUN_URLS`; enabled connections derive them from
the ordinary STUN authority. Keep both firewall rules while the capability is
enabled. Set `NAT_PREDICTION_ENABLED=false` and restart Screener before removing
the auxiliary firewall rules. Avoid verbose STUN/ICE logging because those
requests contain client IP addresses.

These same-IP auxiliary ports measure destination-port mapping behavior. They
are not a full RFC 5780 alternate-address deployment; that requires a second
public IPv4.

## Operational Verification

- `/healthz` returns `{"status":"ok"}` locally and through the public origin.
- Screener and nginx are active with expected restart counts and bounded
  logs/resources; Screener owns the configured STUN/SFU UDP listeners.
- The official Trickle ICE sample obtains an ordinary UDP `srflx` candidate from
  the configured STUN service and no relay candidate.
- A direct room presents media on two networks when Peer ICE succeeds.
- A constrained route creates one managed Host publication and only admitted
  subscriptions over embedded SFU UDP; Peer descendants remain ordinary P2P.
- Blocking all UDP reaches a clear bounded failure.
- Restarting Screener in stable mode retains room authority while Browser
  sessions and media reconnect from fresh process state.

Representative network, mobile, audio, 20-Viewer, and long-running evidence is
tracked in [verification status](../verification-status.md), not in this runbook.
