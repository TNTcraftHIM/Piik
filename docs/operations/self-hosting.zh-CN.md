# 部署 Piik Server

[English](./self-hosting.md) · 简体中文 · [文档导航](../README.md)

Piik Server 将网页、房间管理和可选的媒体转发打包在**一个服务端程序**中。
解压后即可运行，房间数据保存在 SQLite 中。

## 先在本机试用

以下服务端操作在 Linux x64 环境中执行。

从 [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) 或
[Gitee 镜像](https://gitee.com/TNTcraftHIM/Piik/releases)下载 **Linux x64 服务端**程序包，
解压后，在该目录运行：

```sh
./piik-server
```

打开 `http://localhost:8787` 即可试用。需要让朋友通过互联网访问时，
继续完成下方配置。如果只想在自己的电脑上临时开房间，可直接使用 [Piik App](../guide/getting-started.zh-CN.md#用-piik-app-分享)。

## 对外提供服务

准备一台 Linux x64 服务器，以及一个指向服务器公网 IP 的域名。
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

程序会自动读取 `.env`，并将房间数据保存在工作目录的 `rooms.sqlite` 中。
`SITE_ACCESS_PASSWORD` 留空时，进入站点无须口令；
如需设置口令，可填写 8–128 个可见 ASCII 字符。房间邀请与加入权限仍由房主管理。

### 2. 配置 HTTPS

如果已有 HTTPS 反向代理，将请求转发到 `127.0.0.1:8787`，并启用 WebSocket 支持。
如果还没有，可以[安装 Caddy](https://caddyserver.com/docs/install)，在 Caddyfile 中加入：

```caddyfile
share.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

重新加载 Caddy。域名解析正确且 TCP 80/443 可访问时，它会自动申请和续期证书。
具体操作见 [Caddy 的 HTTPS 代理说明](https://caddyserver.com/docs/quick-starts/reverse-proxy#https)。

### 3. 放行端口并检查

在服务器防火墙和云平台安全组中放行 **TCP 80/443**（HTTPS）和 **UDP 3478**（STUN）。
TCP 8787 仅供本机反向代理访问。STUN 域名需要直接解析到服务器，不能只经过 CDN 的 HTTP 代理。

打开 `https://share.example.com/healthz`，应返回 `{"status":"ok"}`。
随后打开站点，分享一个画面，并用另一台设备加入验证。
上述基础配置使用 P2P 传输，参与者之间需要可用的 UDP 通路。

## 可选：启用媒体兜底

在 `.env` 中添加 `SFU_UDP_PORT=7882`，放行 UDP 7882，再重启 Piik，即可启用自动 SFU 兜底。
如果服务器处于 NAT 后方，还需将 `SFU_PUBLIC_IP` 设置为外部可达的公网 IPv4 地址。
这项功能由同一个服务端程序提供。

## 长期运行与更新

需要开机启动时，参阅 [systemd 与容器配置](./service-management.md)。
更新时保留 `.env` 和 `rooms.sqlite`：停止服务、备份房间数据、替换新版程序，再启动并检查健康状态和房间访问。
涉及数据格式变化的版本，请先阅读发布说明。

[全部配置与端口](../reference/configuration.md) · [维护者发版工具](../deployment.md)
