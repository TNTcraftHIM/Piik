# 部署 Piik Server

[English](./self-hosting.md) · 简体中文 · [文档导航](../guide/README.zh-CN.md)

Piik Server 将网页、房间管理和可选的媒体转发打包在**一个服务端程序**中。
解压后即可运行，房间数据保存在 SQLite 中。

默认的 P2P 配置由服务器负责房间管理、信令和 STUN，画面与声音在参与者之间传输。
启用 SFU 后，服务器还会承担媒体转发的带宽和处理开销。配置较低的服务器可以先用默认设置，
按预计的房间数和观众数观察 CPU、内存与网络占用，再决定是否开启 SFU。
降低画面分辨率主要减轻参与者设备的采集和编码负担。

## 先在本机试用

服务端提供 Linux x64／ARM64 和 Windows x64 程序包。

从 [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) 或
[Gitee 镜像](https://gitee.com/TNTcraftHIM/Piik/releases)下载对应架构的服务端程序包。
Linux 可运行 `uname -m` 查看架构：

| 平台 | 程序包 |
| --- | --- |
| Linux `x86_64`（x64） | `piik-<revision>-runtime.tar.gz` |
| Linux `aarch64`（ARM64） | `piik-<revision>-linux-arm64-runtime.tar.gz` |
| Windows x64 | `piik-<revision>-windows-amd64-runtime.zip` |

Linux 解压后，在该目录运行：

```sh
./piik-server
```

Windows 解压后，在该目录打开 PowerShell，运行 `./piik-server.exe`。

打开 `http://localhost:8787` 即可试用。需要让朋友通过互联网访问时，
继续完成下方配置。如果只想在自己的电脑上临时开房间，可直接使用 [Piik App](../guide/getting-started.zh-CN.md#用-piik-app-分享)。

## 使用 Docker Compose

在已安装 Docker Compose v2 的 Linux x64 或 ARM64 服务器上，将两个部署文件下载到空目录中：

```sh
curl -fsSLo compose.yaml https://raw.githubusercontent.com/TNTcraftHIM/Piik/main/deploy/container/compose.yaml
curl -fsSLo .env https://raw.githubusercontent.com/TNTcraftHIM/Piik/main/deploy/container/.env.example
```

将 `.env` 中的 `share.example.com` 换成自己的域名，然后启动：

```sh
docker compose run --rm piik --check-config
docker compose up -d
```

`ghcr.io/tntcrafthim/piik:latest` 镜像包含网页、信令、STUN 和可选 SFU。
Docker 会自动选择对应架构的镜像。
接着完成下方的 [HTTPS 配置](#2-配置-https)和[端口放行](#3-放行端口并检查)。
默认使用 P2P；如需 SFU 兜底，按 `.env` 中的说明启用即可。
请保留 `piik-data` 数据卷，房间数据和可选诊断文件都保存在其中。
更新与备份见[容器维护说明](./service-management.zh-CN.md#容器)。

## 无域名的内网部署

NAS、家用服务器或虚拟局域网可以直接使用 Piik 提供的 HTTPS，无需另装反向代理。
在服务端程序旁创建 `.env`，填写以下配置，将所有 `192.168.1.10` 换成服务器在该网络中的 IP：

```dotenv
PIIK_ENV=production
LISTEN_HOST=0.0.0.0
PORT=8787
PUBLIC_BASE_URL=https://192.168.1.10:8787
TLS_SELF_SIGNED=true
STUN_URLS=stun:192.168.1.10:3478
```

在该目录先运行 `./piik-server --check-config`，检查通过后运行 `./piik-server`；Windows 加上 `.exe`。
在该网络放行 TCP 8787 和 UDP 3478，然后用各台设备打开上述 **HTTPS** 地址。
不需要公网 IP 或域名。如果使用 Docker Compose，还需把网页端口映射
`127.0.0.1:8787:8787/tcp` 改为 `8787:8787/tcp`，让内网设备可以访问。

浏览器会提示证书不受信任。请先核对证书的 SHA-256 指纹，与服务端启动时的
**HTTPS certificate** 信息一致后再继续，见[本地证书确认说明](../guide/troubleshooting.zh-CN.md#本地-https-证书提示)。
临时证书只保存在内存中，重启 Piik 后会更换，需要重新确认。
开麦、摄像头和远控仍需浏览器支持相关接口，并完成各自的正常授权。

如果已有自己的证书，关闭 `TLS_SELF_SIGNED`，同时设置 `TLS_CERT_FILE` 和 `TLS_KEY_FILE`，
指向 PEM 格式的证书和私钥文件。Docker 中需将文件只读挂载，并使用容器内的路径。
证书需覆盖 `PUBLIC_BASE_URL` 中的域名或 IP；
`--check-config` 会检查文件配对、地址与有效期，替换文件后需重启 Piik。
Piik 不负责申请或续期证书。长期对外服务的站点建议使用下方自动管理证书的 HTTPS 代理。
网页端口被占用时，先停止占用服务，或同时修改 `PORT` 与 `PUBLIC_BASE_URL` 中的端口，
再重新发送邀请。

## 对外提供服务

准备一台受支持的服务器，以及一个指向服务器公网 IP 的域名。
下文以 `share.example.com` 为例，请替换成自己的域名。

### 1. 配置并启动 Piik

在程序旁新建 `.env` 文件：

```dotenv
PIIK_ENV=production
LISTEN_HOST=127.0.0.1
PUBLIC_BASE_URL=https://share.example.com
STUN_URLS=stun:share.example.com:3478
MAX_VIEWERS_PER_ROOM=20
SITE_ACCESS_PASSWORD=
```

使用普通用户，在该目录执行：

```sh
./piik-server --check-config
./piik-server
```

Windows 请在 PowerShell 中改用 `./piik-server.exe --check-config` 和
`./piik-server.exe`；`.env` 文件和端口配置相同。

程序会自动读取 `.env`，并将房间数据保存在工作目录的 `rooms.sqlite` 中。
`SITE_ACCESS_PASSWORD` 留空时，进入站点无须口令；
如需设置口令，填写你想使用的口令即可。房间邀请与加入权限仍由房主管理。

`PUBLIC_BASE_URL` 应与浏览器访问的网址一致，包括 HTTPS 和非默认端口。
只使用这个地址时，`ALLOWED_ORIGINS` 不设置或留空即可；已有的非空值会覆盖此默认值，
旧地址未更新可能导致[创建房间返回 403](../guide/troubleshooting.zh-CN.md#创建房间返回-403)。

`MAX_VIEWERS_PER_ROOM` 可设置每房观众上限，不含房主，支持 `1..20`，修改后重启生效。
人数越多，对网络和转发资源的需求也可能增加。默认值及 App 房间的区别见
[人数限制](../standards/configuration.md#room-capacity)。

公开站点可选设 `ROOM_EMPTY_TIMEOUT_SECONDS=3600`，重启后，无人在线的房间会在空置一小时后
回收；房间号用满时，会提前回收最早创建的空房间，仍有人在线的房间不受影响。
被回收的房间需要重新创建并发送邀请。不设置或设为 `0` 则保持默认的长期保留行为，
详见[房间保留策略](../standards/configuration.md#room-retention)。

### 2. 配置 HTTPS

如果已有 HTTPS 反向代理，将请求转发到 `127.0.0.1:8787`，并启用 WebSocket 支持。
如果还没有，可以[安装 Caddy](https://caddyserver.com/docs/install)，在 Caddyfile 中加入：

```text
share.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

重新加载 Caddy。域名解析正确且 TCP 80/443 可访问时，它会自动申请和续期证书。
具体操作见 [Caddy 的 HTTPS 代理说明](https://caddyserver.com/docs/quick-starts/reverse-proxy#https)。

nginx 可参考[配置示例](../../deploy/nginx/piik.conf.example)。如果沿用了旧示例，请将
`Permissions-Policy` 改为 `camera=(self), microphone=(self), geolocation=()`，然后重新加载 nginx。
摄像头和麦克风的空白允许列表会阻止浏览器采集，即使用户已授权；`self` 允许本站请求访问。

### 3. 放行端口并检查

在服务器防火墙和云平台安全组中放行 **TCP 80/443**（HTTPS）和 **UDP 3478**（STUN）。
TCP 8787 仅供本机反向代理访问。STUN 域名需要直接解析到服务器，不能只经过 CDN 的 HTTP 代理。
可选服务的端口见[完整端口表](../standards/configuration.md#public-and-private-ports)。
内置 SFU 的媒体流复用 `SFU_UDP_PORT` 指定的单个 UDP 端口。

打开 `https://share.example.com/healthz`，应返回 `{"status":"ok"}`。
随后打开站点，分享一个画面，并用另一台设备加入验证。
上述基础配置使用 P2P 传输，参与者之间需要可用的 UDP 通路。

## 可选：启用媒体兜底

在 `.env` 中添加 `SFU_UDP_PORT=7882`，放行 UDP 7882，再重启 Piik，即可启用自动 SFU 兜底。
如果服务器处于 NAT 后方，还需将 `SFU_PUBLIC_IP` 设置为外部可达的公网 IPv4 地址或 DDNS 域名。
域名应直接指向该 IPv4，关闭 CDN 代理。Piik 在启动时解析域名；公网 IP 变化、DDNS 更新后需重启 Piik。
公网和内部映射的 UDP 端口都应与 `SFU_UDP_PORT` 一致。
这项功能由同一个服务端程序提供。
服务器需要为实际经由 SFU 观看的观众承担转发负载和出口带宽。
房主需要在开始分享前关闭 **隐私模式**，才会允许使用这条线路。
直连和 SFU 媒体都需要可用的 UDP 通路。

如需所有房间都通过服务器转发，再设置 `SFU_ONLY=true` 并重启。
分享设置中会显示 **服务器转发**。请为每位观众预留服务器带宽；
服务器线路失败时，此模式不会改走 P2P。

## 可选：通过 frp 转发已有服务

如果 Piik 位于 NAT 后方，且你有一台公网 frps 主机，可用 frp 转发已有的网页和 SFU 端口。
P2P 的 ICE 探测方式保持不变。

将[上方的 HTTPS 代理](#2-配置-https)部署在公网主机，仍转发到 `127.0.0.1:8787`，
并保留 WebSocket 支持。将 `share.example.com` 和 `relay.example.com` 解析到该主机。
除 TCP 80/443 外，放行供 frpc 连接的 TCP 7000 和媒体使用的 UDP 7882；
转发后的 TCP 8787 仅供 HTTPS 代理访问，不对公网开放。

在公网主机配置 `frps.toml`：

```toml
bindPort = 7000
auth.token = "{{ .Envs.FRP_TOKEN }}"
transport.tls.force = true
allowPorts = [{ single = 8787 }, { single = 7882 }]
```

在 Piik 所在机器，将 [frpc.toml.example](../../deploy/frp/frpc.toml.example)
复制为 `frpc.toml`，替换其中的 `relay.example.com`。
为两端的 frp 进程注入相同、非空的私密环境变量 `FRP_TOKEN`。
分别运行 `frps verify -c frps.toml` / `frpc verify -c frpc.toml` 检查配置，
再用 `-c` 指定各自的文件启动。具体用法见 [frp 配置说明](https://gofrp.org/zh-cn/docs/features/common/configure/)
和 [TCP/UDP 转发](https://gofrp.org/zh-cn/docs/features/tcp-udp/)。

Piik 保持 `LISTEN_HOST=127.0.0.1`，并修改 `.env`：

```dotenv
PUBLIC_BASE_URL=https://share.example.com
STUN_URLS=stun:stun.direct.example.com:3478
SFU_UDP_PORT=7882
SFU_PUBLIC_IP=203.0.113.10
```

将示例 IPv4 换成 frps 的公网地址，将 STUN 域名换成直接可达的 STUN 服务。
frpc 的本地与公网 UDP 端口必须都等于 `SFU_UDP_PORT`。
不要通过 frp 转发 Piik 的 STUN 端口：UDP 代理会
[改变 STUN 所观察到的源地址映射](../research/nat-traversal.md#external-forwarding-and-participant-relays)。
重启 Piik，从另一网络验证 HTTPS 健康检查、房间访问及**服务器转发**。

### 使用托管 frp 服务

SakuraFrp 等服务会提供公网服务器和自己的客户端或启动器；按服务商教程配置，
不必套用上面的自建 frps 令牌配置。先确认所选节点同时支持带 WebSocket 的 HTTPS 网页访问和普通 UDP 隧道。

| 端点 | 本地目标 | Piik 设置 |
| --- | --- | --- |
| 网页 | `127.0.0.1:8787`，由自己的代理或服务商提供 HTTPS | 将 `PUBLIC_BASE_URL` 设为实际公网 HTTPS 地址，包含所需端口。 |
| 媒体 | `127.0.0.1:<分配的 UDP 端口>` | 将 `SFU_UDP_PORT` 设为相同的本地／公网端口，`SFU_PUBLIC_IP` 设为 UDP 节点的公网 IPv4。 |

例如，服务商分配 UDP `30000` 时，将隧道的本地、公网端口和 Piik 的 `SFU_UDP_PORT` 都设为 `30000`；
网页本地端口仍可使用 `8787`。STUN 仍按上文保持直接可达。
只穿透网页可以承载信令，但不会为严格 NAT 增加 SFU 媒体路线。

可参考 SakuraFrp 的[网页配置](https://doc.natfrp.com/app/http.html)和
[UDP 连通说明](https://doc.natfrp.com/faq/network.html)。节点功能、访问要求与带宽以服务商为准；
Piik 尚未完成该托管服务的实际连通与性能验收。

## 长期运行与更新

Linux 开机启动可参考 [systemd 与容器配置](./service-management.zh-CN.md)。
Windows 可使用已有的服务管理工具或任务计划程序；Piik 不会安装 Windows 服务。
更新时保留 `.env` 和 `rooms.sqlite`：停止服务、备份房间数据、替换新版程序，再启动并检查健康状态和房间访问。
涉及数据格式变化的版本，请先阅读发布说明。

[全部配置与端口](../standards/configuration.md) · [维护者发版工具](../deployment.md)
