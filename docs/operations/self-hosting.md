# Deploy Piik Server

English · [简体中文](./self-hosting.zh-CN.md) · [Documentation](../README.md)

Piik Server packages the web interface, room management and optional media
forwarding in **one server binary**. Extract and run it; room data is stored in SQLite.

## Try it locally

These server instructions use a Linux x64 machine.

Download the **Linux x64 Server** archive from [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases)
or the [Gitee mirror](https://gitee.com/TNTcraftHIM/Piik/releases),
extract it, and run the following in its directory:

```sh
./piik-server
```

Open `http://localhost:8787`. This is a local trial; use the configuration below
to let friends connect over the internet. To start a temporary room on your computer,
use the [Piik App guide](../guide/getting-started.md).

## Docker Compose

On a Linux x64 server with Docker Compose v2, download the two deployment files
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
and optional SFU. Complete [HTTPS](#2-enable-https) and
[firewall configuration](#3-open-the-ports-and-verify) below. The default is P2P;
the sample `.env` also shows how to enable SFU fallback. Keep the `piik-data`
volume, which stores room data and optional diagnostics. See
[container maintenance](./service-management.md#container) for updates and backups.

## Put it online

You need a Linux x64 server and a domain pointing to its public IP.
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

### 2. Enable HTTPS

Use your existing HTTPS reverse proxy to forward to `127.0.0.1:8787` with
WebSocket support. If you do not have one, [install Caddy](https://caddyserver.com/docs/install)
and add this to its Caddyfile:

```caddyfile
share.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Reload Caddy. It obtains and renews the certificate automatically when DNS points
to the server and TCP 80/443 are reachable. See [Caddy's HTTPS proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy#https).

### 3. Open the ports and verify

Allow **TCP 80/443** for HTTPS and **UDP 3478** for STUN in the server firewall
and cloud security group. Keep TCP 8787 private. The STUN hostname must resolve
directly to the server; a CDN HTTP proxy does not forward its UDP traffic.

Open `https://share.example.com/healthz`; it should return `{"status":"ok"}`.
Then open the site, share a screen and join from another device. This initial
configuration uses P2P media, so participants need a usable UDP path.

## Optional: media fallback

Add `SFU_UDP_PORT=7882` to `.env`, allow UDP 7882, and restart Piik to enable
automatic SFU fallback. When the server is behind NAT, also set `SFU_PUBLIC_IP`
to its reachable public IPv4 address. The same binary provides the fallback.

## Keep it running and update

For automatic startup, use the [systemd or container guide](./service-management.md).
Keep `.env` and `rooms.sqlite` across updates. Back up room data while the server is
stopped, replace the executable with the new release, then restart and check
health and room access. Read release notes before an upgrade that changes data formats.

[All settings and ports](../reference/configuration.md) ·
[Maintainer release tooling](../deployment.md)
