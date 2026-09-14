# 服务管理

[English](./service-management.md) · 简体中文 · [文档导航](../README.md)

首次安装请从[部署指南](./self-hosting.zh-CN.md)开始。本页介绍 Linux 常驻服务与容器维护。

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

HTTPS 代理与 Piik 在同一主机时，让 HTTP 继续绑定回环地址。
STUN 和可选的 SFU 使用各自的公网 UDP 监听器。已有 nginx 时，可修改
[代理示例](../../deploy/nginx/piik.conf.example)中的域名与证书路径后使用。

## 容器

安装步骤见 [Docker Compose 配置](./self-hosting.zh-CN.md#使用-docker-compose)。
镜像为 `ghcr.io/tntcrafthim/piik`，提供 `latest` 和对应产品版本标签（`vMAJOR.MINOR.PATCH`），
支持 **linux/amd64**。在 `.env` 中设置 `PIIK_IMAGE` 可固定版本或镜像摘要。
更新需要手动执行；仅拉取镜像不会替换正在运行的容器。

[运行时 Dockerfile](../../deploy/container/Dockerfile)封装已验证的 Server 压缩包，
包括网页界面、许可证声明和 `REVISION`。固定版本的
[Distroless 非 root 基础镜像](https://github.com/GoogleContainerTools/distroless)
包含 CA 证书，没有 shell 或包管理器。镜像的构建、检查和发布由
[发布流程](../reference/versioning.md#container-distribution)管理。

使用既有的[生产配置](../reference/configuration.md)。容器内保留 `LISTEN_HOST=0.0.0.0`，
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
诊断保持手动开启，使用 `/home/nonroot/logs`；[导出与保留](../reference/configuration.md#diagnostics)
由运维人员负责。不要将应用文件挂载为可写。
启用诊断后，`docker compose kill --signal=SIGUSR1 piik` 会请求本地导出，不会停止容器；
ZIP 保存在挂载的日志目录中。

从主机与公网代理检查 `/healthz`，再按[运行验证](#运行验证)检查已配置的 STUN/SFU UDP，
以及房间和媒体行为。镜像内没有基于 shell 的健康检查。
替换前保留旧镜像、环境配置与数据卷备份。在部署目录执行：

```sh
docker compose pull
docker compose stop
docker compose cp piik:/home/nonroot ./piik-data-backup
docker compose up -d
docker compose logs --tail=50 piik
```

每次使用新的备份目录。复制 SQLite 前先停止 Piik，确保数据库和日志文件一致。
单独保存 `.env`，并将配置和数据备份视为房间凭据加以保护。
保留同一个 Compose 项目与目录，以便继续使用原命名数据卷；
`docker compose down --volumes` 会删除这些数据。
回滚时，恢复之前的镜像设置与兼容配置，再重新创建服务。
跨越存储格式边界前，先阅读发布说明。裸机部署脚本 `release-app.sh` 不管理容器。

## 运行验证

- 本地和公网来源的 `/healthz` 都返回 `{"status":"ok"}`。
- Piik 与 HTTPS 代理处于运行状态，重启次数符合预期，日志和资源使用有界；
  Piik 占有配置中的 STUN/SFU UDP 监听器。
- 官方 Trickle ICE 示例能从配置的 STUN 服务取得普通 UDP `srflx` 候选，不出现 relay 候选。
- Peer ICE 成功时，两个网络上的设备能在直连房间中显示媒体。
- 启用 SFU 时，受限路由通过内嵌 SFU UDP 创建一个受管理的房主发布，且只接纳已授权订阅；
  Peer 后代节点继续使用普通 P2P。
- 阻断全部 UDP 后，在有限时间内进入明确的失败状态。
- 使用持久化模式时，重启 Piik 保留房间权威状态；浏览器会话和媒体从新进程状态重新连接。

代表性网络、移动端、音频、20 位观众和长时间运行的证据由
[验证状态](../verification-status.md)跟踪，不记录在本操作手册中。
