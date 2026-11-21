# 服务管理

[English](./service-management.md) · 简体中文 · [文档导航](../guide/README.zh-CN.md)

更新或备份 Piik Server，设置 Linux 开机启动，或检查站点是否正常。首次安装请看[部署指南](./self-hosting.zh-CN.md)。

- [使用 systemd 启用后台服务](#systemd)
- [备份并更新容器](#备份并更新容器)
- [检查运行状态](#运行验证)

## 容器

首次安装见 [Docker Compose 配置](./self-hosting.zh-CN.md#使用-docker-compose)。

### 备份并更新容器

1. 单独备份 `.env`，记下当前镜像标签或摘要。将 `.env` 中的 `PIIK_IMAGE` 设为要安装的 2.x 镜像标签或摘要。
2. 在原部署目录执行下方命令。请使用新的备份目录。复制 SQLite 前先停止 Piik，确保数据库和日志文件一致。

```sh
docker compose pull
docker compose stop
docker compose cp piik:/home/nonroot ./piik-data-backup
docker compose up -d
docker compose logs --tail=50 piik
```

配置和数据备份包含房间凭据，请妥善保存。继续使用原 Compose 项目与目录，保留命名数据卷。`docker compose down --volumes` 会删除该卷。

启动后检查 [运行验证](#运行验证) 中的健康状态和分享步骤。

### 回滚容器

将 `PIIK_IMAGE` 和配置恢复到之前的兼容版本，然后在部署目录运行 `docker compose up -d`。涉及存储格式变化时，先查看发布说明。重新执行[运行验证](#运行验证)。

<details>
<summary>修改容器的端口、数据卷或诊断设置</summary>

使用既有的[生产配置](../standards/configuration.md)。容器内保留 `LISTEN_HOST=0.0.0.0`，
并继续使用主机已有的 HTTPS/WebSocket 代理。使用 Docker 端口映射且启用 SFU 时，
将 `SFU_PUBLIC_IP` 设为外部可达的服务器 IPv4 地址；容器私网候选无法从互联网访问。
公布的 STUN 域名必须解析到服务器公网地址，UDP 必须能直接到达容器。

[Compose 文件](../../deploy/container/compose.yaml)将 HTTP 绑定到主机回环地址，
公布标准 UDP 端口，并启用自动重启。公布端口不会开启对应服务，可选监听器由 `.env` 控制。
修改监听端口时，同时修改应用配置和端口映射。
请使用主机上的代理，或明确调整代理容器的网络配置；代理容器自己的 `127.0.0.1`
无法访问另一个容器内的 Piik。

镜像中的 `/home/nonroot` 属于 UID/GID `65532:65532`，权限为 `0700`。
新的命名数据卷继承该目录；已有数据卷或绑定挂载需要事先允许该身份写入。
替换容器时保留这个数据卷。设置 `ROOM_DATABASE_PATH=:memory:` 可让房间权威状态只保存在内存中。
诊断保持手动开启，使用 `/home/nonroot/logs`；[导出与保留](../standards/configuration.md#diagnostics)
由运维人员负责。不要将应用文件挂载为可写。
启用诊断后，`docker compose kill --signal=SIGUSR1 piik` 会请求本地导出，不会停止容器；
ZIP 保存在挂载的日志目录中。

</details>

[镜像版本与发布](../standards/versioning.md#container-distribution)

## systemd

[服务模板](../../deploy/systemd/piik.service.example)使用 `piik` 用户运行，
读取 `/etc/piik/piik.env`，启动 `/opt/piik/current/piik-server`。
请创建服务账号，将解压后的发布产物放在该路径，或让 `current` 指向对应发布目录。
将配置复制到 `/etc/piik/piik.env`，并设置 `ROOM_DATABASE_PATH=/var/lib/piik/rooms.sqlite`；
服务单元会创建这个状态目录。环境文件只应允许运维人员读取。

将模板安装为 `/etc/systemd/system/piik.service`，然后执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now piik
sudo systemctl status piik
```

状态输出应显示 `Active: active (running)`。使用默认地址和端口时，在服务器上访问 `http://127.0.0.1:8787/healthz`，应看到 `{"status":"ok"}`。

HTTPS 代理与 Piik 在同一主机时，让 HTTP 继续绑定回环地址。
STUN 和可选的 SFU 使用各自的公网 UDP 监听器。已有 nginx 时，可修改
[代理示例](../../deploy/nginx/piik.conf.example)中的域名与证书路径后使用。

## 运行验证

1. 在服务器本机和公网 HTTPS 地址分别打开 `/healthz`，两处都应返回 `{"status":"ok"}`。
2. 开始分享，将邀请发给另一网络上的朋友。请对方发一条聊天消息、看画面，并听一段你开启分享的声音。
3. 检查 STUN 时，在 [Trickle ICE 示例](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)中只保留你配置的 STUN 地址，再点 **Gather candidates**。结果中应出现类型为 `srflx` 的 UDP 候选。
4. 启用了 SFU 时，用无法直连但能通过 UDP 访问服务器的网络测试。房主在开播前关闭 **隐私模式**。确认观众能看到画面，并在连接详情里检查是否经过服务器转发。
5. 使用 SQLite 时，在一次计划内的重启后重新打开原房间。检查原邀请仍能使用，再发起分享，确认观众能重新看到画面。
