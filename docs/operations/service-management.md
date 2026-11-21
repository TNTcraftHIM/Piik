# Service Management

English · [简体中文](./service-management.zh-CN.md) · [Documentation](../guide/README.md)

Use systemd to run Piik Server in the background on Linux. If you deployed with Docker Compose, use the container section for updates and backups. For a first installation, follow the [deployment guide](./self-hosting.md).

## systemd

The [service template](../../deploy/systemd/piik.service.example) runs as the
`piik` user, reads `/etc/piik/piik.env`, and starts
`/opt/piik/current/piik-server`. Create the service account and place the extracted
release at that path, or point `current` at its release directory. Copy your
configuration to `/etc/piik/piik.env` and set
`ROOM_DATABASE_PATH=/var/lib/piik/rooms.sqlite`; the unit creates this state directory.
Keep the environment file readable only by its operator.

Install the template as `/etc/systemd/system/piik.service`, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now piik
sudo systemctl status piik
```

In the service status, look for `Active: active (running)`. With the default address and port, request `http://127.0.0.1:8787/healthz` from the server. Piik should respond with `{"status":"ok"}`.

Keep HTTP bound to loopback when the HTTPS proxy runs on the same host.
STUN and optional SFU use their own public UDP listeners. An existing nginx
installation can use the [proxy example](../../deploy/nginx/piik.conf.example)
after adapting the domain and certificate paths.

## Container

Use the [Docker Compose setup](./self-hosting.md#docker-compose) for installation.
The image is `ghcr.io/tntcrafthim/piik`, with `latest` and matching product version
tags (`vMAJOR.MINOR.PATCH`). Docker selects **linux/amd64** or **linux/arm64**
to match the host. Set `PIIK_IMAGE` in `.env`
to pin a version or image digest. Updates are explicit; pulling an image does not
replace a running container.

The [runtime Dockerfile](../../deploy/container/Dockerfile) wraps the verified
Server archive, including its Web UI, license notices and `REVISION`.
Its pinned [Distroless non-root base](https://github.com/GoogleContainerTools/distroless)
includes CA certificates and has no shell or package manager. The
[release workflow](../standards/versioning.md#container-distribution) owns
building, checking and publishing the image.

Use the existing [production configuration](../standards/configuration.md).
Keep `LISTEN_HOST=0.0.0.0` inside the container and retain the host's existing
HTTPS/WebSocket proxy. With Docker port mapping, set `SFU_PUBLIC_IP` to the
reachable server IPv4 address when SFU is enabled; container-private candidates
are not Internet-reachable. Advertised STUN names must resolve to the server's
public address, and UDP must reach the container directly.

The [Compose file](../../deploy/container/compose.yaml) keeps HTTP on host
loopback, publishes the standard UDP ports and enables automatic restart.
Publishing a port does not enable its service; `.env` controls optional listeners.
Edit both the application setting and port mapping if changing a listener port.
Run a host proxy, or adapt the proxy's container networking deliberately: its
own `127.0.0.1` does not reach Piik in another container.

The image's `/home/nonroot` is owned by UID/GID `65532:65532` with mode `0700`.
A new named volume inherits that directory; an existing volume or bind mount
must already be writable by that identity. Keep this volume when replacing the
container. Set `ROOM_DATABASE_PATH=:memory:` for memory-only room authority. Diagnostics
remain opt-in and use `/home/nonroot/logs`; [export and retention](../standards/configuration.md#diagnostics)
remain the operator's responsibility. Do not mount application files writable.
With diagnostics enabled, `docker compose kill --signal=SIGUSR1 piik` requests a local
export without stopping the container; the ZIP remains in the mounted log directory.

Check `/healthz` from the host and public proxy, then verify configured STUN/SFU
UDP and room/media behavior using [operational verification](#operational-verification).
There is no shell-based healthcheck in the image. Retain the previous image,
environment and volume backup before replacement. Record the previous image tag or digest for rollback, then set `PIIK_IMAGE` in `.env` to the 2.x release you intend to install. From the deployment directory:

```sh
docker compose pull
docker compose stop
docker compose cp piik:/home/nonroot ./piik-data-backup
docker compose up -d
docker compose logs --tail=50 piik
```

Use a new backup directory each time. Stop Piik before copying SQLite so its
database and journal are consistent. Preserve `.env` separately and protect both
backups as room credentials. Keep the same Compose project/directory so the named
volume is reused; `docker compose down --volumes` deletes that data. To roll back,
restore the previous image setting and compatible configuration, then recreate
the service. Read release notes before crossing a storage-format boundary.
The bare-metal `release-server.sh` wrapper does not manage containers.

## Operational Verification

1. Open `/healthz` on the server and through the public HTTPS address. Both should return `{"status":"ok"}`.
2. Start sharing and send the invitation to a friend on another network. Ask them to send a chat message, watch the picture and listen to a sound you chose to share.
3. To check STUN, enter your configured STUN address in the [Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) as the only server, then select **Gather candidates**. Look for a UDP candidate of type `srflx`.
4. If you enabled SFU, test from a network where direct connections fail but UDP can reach your server. Before sharing, turn off **Privacy mode**. Confirm the viewer receives the picture and that the connection details show server forwarding.
5. After a planned restart with SQLite enabled, reopen an existing room. Check the invitation still works, then start a share and confirm the viewer receives it again.
