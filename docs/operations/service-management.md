# Service Management

For first installation, use the [short self-hosting guide](./self-hosting.md).
This reference covers a persistent Linux service and the optional container recipe.

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

Keep HTTP bound to loopback when the HTTPS proxy runs on the same host.
STUN and optional SFU use their own public UDP listeners. An existing nginx
installation can use the [proxy example](../../deploy/nginx/piik.conf.example)
after adapting the domain and certificate paths.

## Container

The [runtime-only Dockerfile](../../deploy/container/Dockerfile) consumes the
existing linux/amd64 Server release; it does not rebuild Go or Browser assets.
Its pinned [Distroless static non-root base](https://github.com/GoogleContainerTools/distroless)
includes CA certificates for HTTPS release checks and has no shell or package
manager. This is an optional recipe, not a published image or automatic installer.

Verify the release archive against its descriptor and manifest using the
[release procedure](../deployment.md), then extract its four files into a new
build-context directory: `piik-server`, `LICENSE`, `THIRD-PARTY-NOTICES.txt`
and `REVISION`. Use that directory, not the repository or a secrets directory:

```sh
docker build --platform linux/amd64 \
  -f /path/to/Piik/deploy/container/Dockerfile \
  -t piik:<full-revision> /path/to/extracted-runtime
docker run --rm --env-file /path/to/piik.env \
  piik:<full-revision> --check-config
```

Use the existing [production configuration](../reference/configuration.md).
Keep `LISTEN_HOST=0.0.0.0` inside the container and retain the host's existing
HTTPS/WebSocket proxy. With Docker port mapping, set `SFU_PUBLIC_IP` to the
reachable server IPv4 address when SFU is enabled; container-private candidates
are not Internet-reachable. Advertised STUN names must resolve to the server's
public address, and UDP must reach the container directly.

The following example publishes the standard listeners and keeps HTTP private
to a proxy running on the same host. Omit UDP publish options for disabled SFU
or auxiliary STUN listeners; use the matching port if configuration changes it.

```sh
docker run -d --name piik --restart unless-stopped --stop-timeout 20 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env-file /path/to/piik.env \
  --mount type=volume,source=piik-data,target=/home/nonroot \
  -e ROOM_DATABASE_PATH=/home/nonroot/rooms.sqlite \
  -p 127.0.0.1:8787:8787/tcp \
  -p 3478:3478/udp -p 3479:3479/udp -p 3480:3480/udp -p 7882:7882/udp \
  piik:<full-revision>
```

The image's `/home/nonroot` is owned by UID/GID `65532:65532` with mode `0700`.
A new named volume inherits that directory; an existing volume or bind mount
must already be writable by that identity. Keep this volume when replacing the
container. Set `ROOM_DATABASE_PATH=:memory:` for memory-only room authority. Diagnostics
remain opt-in and use `/home/nonroot/logs`; [export and retention](../reference/configuration.md#diagnostics)
remain the operator's responsibility. Do not mount application files writable.
With diagnostics enabled, `docker kill --signal=USR1 piik` requests a local
export without stopping the container; the ZIP remains in the mounted log directory.

Check `/healthz` from the host and public proxy, then verify configured STUN/SFU
UDP and room/media behavior using [operational verification](#operational-verification).
There is no shell-based healthcheck in the image. Retain the previous image,
environment and volume backup before replacement. Stop the old container before
reusing its listeners or SQLite volume, and recreate with the previous image and
environment if verification fails. The bare-metal `release-app.sh` wrapper does
not manage containers. This recipe changes no proxy or firewall itself.

## Operational Verification

- `/healthz` returns `{"status":"ok"}` locally and through the public origin.
- Piik and the HTTPS proxy are active with expected restart counts and bounded
  logs/resources; Piik owns the configured STUN/SFU UDP listeners.
- The official Trickle ICE sample obtains an ordinary UDP `srflx` candidate from
  the configured STUN service and no relay candidate.
- A direct room presents media on two networks when Peer ICE succeeds.
- A constrained route creates one managed Host publication and only admitted
  subscriptions over embedded SFU UDP; Peer descendants remain ordinary P2P.
- Blocking all UDP reaches a clear bounded failure.
- Restarting Piik in stable mode retains room authority while Browser
  sessions and media reconnect from fresh process state.

Representative network, mobile, audio, 20-Viewer, and long-running evidence is
tracked in [verification status](../verification-status.md), not in this runbook.
