# Deploy Piik Server

English · [简体中文](./self-hosting.zh-CN.md) · [Documentation](../guide/README.md)

Piik Server packages the web interface, room management and optional media
forwarding in **one server binary**. Extract and run it; room data is stored in SQLite.

The default P2P configuration handles room management, signaling and STUN; shared
video and audio travel between participants. Enabling SFU adds media-forwarding
bandwidth and processing on the server. For a small server, start with the default
and measure CPU, memory and network use with your intended number of rooms and
viewers before enabling SFU. Lowering picture resolution primarily reduces
participants' capture and encoding work.

## Try it locally

These instructions support Linux x64 and ARM64.

Download the Server archive matching your machine
from [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases)
or the [Gitee mirror](https://gitee.com/TNTcraftHIM/Piik/releases).
Use `uname -m` to check the architecture:

| Architecture | Archive |
| --- | --- |
| `x86_64` (x64) | `piik-<revision>-runtime.tar.gz` |
| `aarch64` (ARM64) | `piik-<revision>-linux-arm64-runtime.tar.gz` |

Extract it and run the following in its directory:

```sh
./piik-server
```

Open `http://localhost:8787`. This is a local trial; use the configuration below
to let friends connect over the internet. To start a temporary room on your computer,
use the [Piik App guide](../guide/getting-started.md).

## Docker Compose

On a Linux x64 or ARM64 server with Docker Compose v2, download the two deployment files
into an empty directory:

```sh
curl -fsSLo compose.yaml https://raw.githubusercontent.com/TNTcraftHIM/Piik/main/deploy/container/compose.yaml
curl -fsSLo .env https://raw.githubusercontent.com/TNTcraftHIM/Piik/main/deploy/container/.env.example
```

Replace `share.example.com` in `.env` with your domain, then start Piik:

```sh
docker compose run --rm piik --check-config
docker compose up -d
```

The `ghcr.io/tntcrafthim/piik:latest` image includes the Web UI, signaling, STUN
and optional SFU. Docker selects the matching architecture automatically. Complete [HTTPS](#2-enable-https) and
[firewall configuration](#3-open-the-ports-and-verify) below. The default is P2P;
the sample `.env` also shows how to enable SFU fallback. Keep the `piik-data`
volume, which stores room data and optional diagnostics. See
[container maintenance](./service-management.md#container) for updates and backups.

## Put it online

You need a Linux x64 or ARM64 server and a domain pointing to its public IP.
The example uses `share.example.com`; replace it with your domain.

### 1. Configure and start Piik

Create a `.env` file next to the binary:

```dotenv
PIIK_ENV=production
LISTEN_HOST=127.0.0.1
PUBLIC_BASE_URL=https://share.example.com
STUN_URLS=stun:share.example.com:3478
MAX_VIEWERS_PER_ROOM=20
SITE_ACCESS_PASSWORD=
```

Run these commands from that directory as a regular user:

```sh
./piik-server --check-config
./piik-server
```

The server reads `.env` automatically and stores rooms in `rooms.sqlite` in the
working directory. A blank `SITE_ACCESS_PASSWORD` allows
entry without a site passphrase; enter a passphrase to require one.
Room invitations and access settings still apply.

`PUBLIC_BASE_URL` must match the address opened in the browser, including HTTPS
and any non-default port. Leave `ALLOWED_ORIGINS` unset or empty for this single
address. An existing non-empty value overrides that default; a stale value can
cause [403 when creating a room](../guide/troubleshooting.md#room-creation-returns-403).

`MAX_VIEWERS_PER_ROOM` sets the room's Viewer limit, excluding the Host. Choose
`1..20` and restart to apply it. More Viewers can require more network and relay
resources. See [room capacity](../standards/configuration.md#room-capacity)
for defaults and the difference from App rooms.

For a public site, optionally set `ROOM_EMPTY_TIMEOUT_SECONDS=3600` and restart.
Rooms with nobody connected are reclaimed after an hour; if all room codes are
used, the oldest empty room can be reclaimed earlier. Occupied rooms keep working.
Reclaimed rooms need new invitations. Unset or `0` keeps the default indefinite
retention; see [room retention](../standards/configuration.md#room-retention).

### 2. Enable HTTPS

Use your existing HTTPS reverse proxy to forward to `127.0.0.1:8787` with
WebSocket support. If you do not have one, [install Caddy](https://caddyserver.com/docs/install)
and add this to its Caddyfile:

```text
share.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Reload Caddy. It obtains and renews the certificate automatically when DNS points
to the server and TCP 80/443 are reachable. See [Caddy's HTTPS proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy#https).

For nginx, see the [configuration example](../../deploy/nginx/piik.conf.example).
If you copied an older example, change its `Permissions-Policy` to
`camera=(self), microphone=(self), geolocation=()` and reload nginx. Empty
camera/microphone allowlists prevent Browser capture even when the user grants
permission; `self` allows this site to request access.

### 3. Open the ports and verify

Allow **TCP 80/443** for HTTPS and **UDP 3478** for STUN in the server firewall
and cloud security group. Keep TCP 8787 private. The STUN hostname must resolve
directly to the server; a CDN HTTP proxy does not forward its UDP traffic.
See the [complete port table](../standards/configuration.md#public-and-private-ports)
for optional services. Embedded SFU media shares the single UDP port set by
`SFU_UDP_PORT`.

Open `https://share.example.com/healthz`; it should return `{"status":"ok"}`.
Then open the site, share a screen and join from another device. This initial
configuration uses P2P media, so participants need a usable UDP path.

## Optional: media fallback

Add `SFU_UDP_PORT=7882` to `.env`, allow UDP 7882, and restart Piik to enable
automatic SFU fallback. When the server is behind NAT, also set `SFU_PUBLIC_IP`
to its reachable public IPv4 address and forward the same external and internal
UDP port as `SFU_UDP_PORT`. The same binary provides the fallback.
Allow server forwarding capacity and outbound bandwidth for Viewers actually
using the SFU.
The Host must turn off **Privacy mode** before sharing to allow this route.
Both direct and SFU media need a usable UDP connection.

To send every room through your server, also set `SFU_ONLY=true` and restart.
The sharing settings will show **Server media**. Plan server bandwidth for every
Viewer; this mode does not fall back to P2P if the server route fails.

## Optional: forward an existing server with frp

If Piik runs behind NAT and you control a public frps host, frp can forward its
existing web and SFU endpoints. P2P ICE discovery remains unchanged.

Run the [HTTPS proxy above](#2-enable-https) on the public host, keeping its
WebSocket-capable upstream at `127.0.0.1:8787`. Point `share.example.com` and
`relay.example.com` to that host. Open TCP 7000 for frpc and UDP 7882 for media,
alongside TCP 80/443; keep the forwarded TCP 8787 private to the HTTPS proxy.

On the public host, configure `frps.toml`:

```toml
bindPort = 7000
auth.token = "{{ .Envs.FRP_TOKEN }}"
transport.tls.force = true
allowPorts = [{ single = 8787 }, { single = 7882 }]
```

On the Piik machine, copy [frpc.toml.example](../../deploy/frp/frpc.toml.example)
to `frpc.toml` and replace `relay.example.com`. Inject the same private, nonempty
`FRP_TOKEN` into both frp process environments. Validate each file with
`frps verify -c frps.toml` / `frpc verify -c frpc.toml`, then start each process
with `-c` and its file. See [frp configuration](https://gofrp.org/en/docs/features/common/configure/)
and [TCP/UDP forwarding](https://gofrp.org/en/docs/features/tcp-udp/).

Keep Piik's `LISTEN_HOST=127.0.0.1` and update its `.env`:

```dotenv
PUBLIC_BASE_URL=https://share.example.com
STUN_URLS=stun:stun.direct.example.com:3478
SFU_UDP_PORT=7882
SFU_PUBLIC_IP=203.0.113.10
```

Replace the example IPv4 with the public frps address and the STUN hostname with
a directly reachable STUN service. The frpc local and remote UDP ports must both
equal `SFU_UDP_PORT`. Do not forward Piik's STUN ports through frp: its UDP proxy
[changes the source mapping](../research/nat-traversal.md#external-forwarding-and-participant-relays)
STUN would report. Restart Piik and check HTTPS health, room access and
**Server media** from another network.

## Keep it running and update

For automatic startup, use the [systemd or container guide](./service-management.md).
Keep `.env` and `rooms.sqlite` across updates. Back up room data while the server is
stopped, replace the executable with the new release, then restart and check
health and room access. Read release notes before an upgrade that changes data formats.

[All settings and ports](../standards/configuration.md) ·
[Maintainer release tooling](../deployment.md)
