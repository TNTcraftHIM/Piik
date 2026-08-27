# Self-Hosting Operations

This runbook owns initial single-host service setup. Application releases use
[deployment](../deployment.md); accepted environment values and ports are in
[configuration reference](../reference/configuration.md).

## Topology

```text
Browser -- HTTPS/WSS --> nginx :443 --> Screener :8787
Browser -- /rtc/v1 WSS --> nginx :443 --> LiveKit :7880
Browser <---------- DTLS-SRTP P2P ----------> Browser
Browser -------- ordinary STUN/UDP --------> coturn :3478
Browser <--------- DTLS-SRTP/UDP ----------> LiveKit :7882
Screener -------- private RoomService -----> LiveKit :7880
```

The tracked public baseline uses Node.js 24, nginx, a valid Web TLS
certificate, time synchronization, and coturn 4.17.2 or a newer patched release.
LiveKit is required for the accepted SFU fallback and tracked release wrapper.
Web and STUN may use different DNS names on the same public IP. Another proxy or
P2P-only service shape needs its own matching updater and recovery checks.

Expose only the public listeners in
[configuration reference](../reference/configuration.md). Screener 8787 and
LiveKit 7880 stay private.

## Tracked Templates

- [Screener systemd unit](../../deploy/systemd/screener.service.example)
- [LiveKit systemd unit](../../deploy/systemd/livekit.service.example)
- [LiveKit readiness drop-in](../../deploy/systemd/screener-livekit-readiness.conf.example)
- [coturn systemd unit](../../deploy/systemd/coturn.service.example)
- [STUN-only coturn config](../../deploy/coturn/turnserver.conf.example)
- [LiveKit config](../../deploy/livekit/livekit.yaml.example)
- [nginx site](../../deploy/nginx/share.bonfire.icu.conf.example)

Copy templates outside the repository, inject independent secrets through an
access-restricted environment file or service manager, and adapt only addresses,
domains, certificates, users, and resource limits required by the host.

## Initial Setup

1. Configure DNS and TLS for the Web origin and STUN name.
2. Install Node.js, nginx, coturn, and pinned-compatible LiveKit.
3. Create an unprivileged `screener` service account, `/opt/screener/releases`,
   `/opt/screener/uploads`, and an access-restricted environment file.
4. Provision one verified initial immutable release and atomically point
   `/opt/screener/current` to it before enabling the unit. The tracked release
   wrapper is upgrade-only and deliberately refuses a missing prior release;
   this repository does not provide a generic first-install transaction.
5. When stable room authority is enabled, use the service-owned
   `/var/lib/screener` StateDirectory and include the SQLite file in the host's
   state backup/recovery policy.
6. Install the tracked service and proxy templates. Bind Screener to loopback on
   bare metal; containers may bind `0.0.0.0` only when publishing/firewall rules
   preserve the same boundary.
7. Apply the public-port allowlist and confirm every retired TURN/TCP port
   is closed.
8. Start coturn and LiveKit before Screener, then nginx. The LiveKit
   readiness drop-in waits for its private control listener before Screener.

LiveKit must be dedicated to this Screener application, set
`room.auto_create: false`, and expose its control listener only to the proxy and
application host. Screener binds its own listener before touching LiveKit,
rejects foreign room names, removes stale managed rooms, confirms the namespace
empty, and only then installs signaling. A competing application process must
make no LiveKit mutation.

Coturn runs `stun-only`, `no-tcp`, and `no-tls`. It must answer STUN binding and
reject TURN allocation. Avoid verbose STUN/ICE logging because infrastructure
necessarily observes client IP addresses.

## Operational Verification

- `/healthz` returns `{"status":"ok"}` locally and through the public origin.
- Screener, nginx, coturn, and LiveKit are active with expected restart
  counts and bounded logs/resources.
- The official Trickle ICE sample obtains an ordinary UDP `srflx` candidate from
  the configured STUN service and no relay candidate.
- A direct room presents media on two networks when Peer ICE succeeds.
- A constrained route creates one managed Host publication and only admitted
  subscriptions over LiveKit UDP; Peer descendants remain ordinary P2P.
- Blocking all UDP reaches a clear bounded failure.
- Restarting Screener in stable mode retains room authority while Browser
  sessions and media reconnect from fresh process state.

Representative network, mobile, audio, 20-Viewer, and long-running evidence is
tracked in [verification status](../verification-status.md), not in this runbook.
