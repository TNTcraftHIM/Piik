# 用 frp 给 Piik 设置固定公网邀请

[English](./frp.md) · 简体中文 · [文档中心](./README.zh-CN.md)

用 frp 可以给家里的 Piik App 或内网里的 Piik Server 一个固定网址。只有运行 Piik 的一端需要配置，朋友用浏览器打开房间邀请即可。

| 要填到哪里 | 地址从哪里来 |
| --- | --- |
| frp 的本地目标 | Piik **网页服务**的本地 IP 和端口。本文以 `127.0.0.1:8787` 为例，启动器和 Piik 运行在同一台机器上。 |
| Piik 的公网地址 | 朋友能访问的 HTTPS 域名，包含服务商分配的公网端口，例如 `https://piik.example.nyat.app:21080`。请换成你的实际地址。 |

## 取得公网地址

下面用 **SakuraFrp（樱花映射）** 演示。有自己的 frps 或其他服务商时，让它把同一 HTTPS 地址下的网页和 WebSocket 转给 Piik 的本地 HTTP 服务，然后直接做下一节。[自建 frps 配置](https://github.com/TNTcraftHIM/Piik/blob/main/docs/operations/self-hosting.zh-CN.md#可选通过-frp-转发已有服务)

1. 在运行 Piik 的电脑上打开樱花映射启动器。登录樱花账号，把管理面板「用户信息」里的访问密钥填进启动器。[启动器图文说明](https://doc.natfrp.com/launcher/usage.html)
2. 在「隧道列表」创建 **TCP** 隧道，选择允许网页流量的节点。本地 IP 填 `127.0.0.1`，本地端口填 Piik 的网页端口。远程端口留空让平台分配，**自动 HTTPS** 选 **自动**。这样朋友用 HTTPS，本机 Piik 仍接收 HTTP。[网页隧道设置](https://doc.natfrp.com/app/http.html) · [自动 HTTPS](https://doc.natfrp.com/frpc/auto-https.html)
3. 到管理面板的「子域绑定」申请一个 `nyat.app` 子域名，点「新建绑定」并选中刚建的隧道。启动或重启隧道，等日志显示已为该域名加载证书。把日志里的**域名和公网端口一起**复制，加上 `https://`，即为下节要填的地址。[子域绑定与证书图文说明](https://doc.natfrp.com/bestpractice/domain-bind.html)

## 让 Piik 生成正确的邀请

### 桌面 App

- 使用 **3.0 内测版**时，在启动页选 **公网邀请 → 使用已有地址**，填入上一步的 HTTPS 地址。将隧道的本地目标与页面显示的 **本机转发目标** 对齐，点 **进入 Piik**。房主从 App 打开的页面进入。
- 使用 **2.8 或之后的 2.x 版本**时，在解压后的 App 目录打开 PowerShell，运行下面的命令。把示例 HTTPS 地址替换为隧道日志里的公网地址，把 `8787` 换成 TCP 隧道设置里的本地端口。v2.7.0 如需使用固定地址，可采用下方的 Server 方式。

```powershell
.\piik-app.exe --link --public-origin https://piik.example.nyat.app:21080 --port 8787
```

### 已部署的 Server

在现有服务配置中选用对应版本的设置，然后重启 Piik Server。容器部署请把 frp 指向宿主机上发布的 Piik 网页端口。

| 版本 | 本地网页端口 | 邀请使用的公网地址 |
| --- | --- | --- |
| 2.x Server | `PORT=8787` | `PUBLIC_BASE_URL=https://piik.example.nyat.app:21080` |
| 3.0 Server | `PIIK_CHANNEL_PORT=8787` | `PIIK_CHANNEL_INVITATION_ORIGIN=https://piik.example.nyat.app:21080` |

公网地址填到端口为止。房间路径和私房邀请码由 Piik 在复制邀请时生成。

## 从外网验证

在 Piik 房间里复制**完整邀请链接**或显示二维码，让朋友用手机流量打开。能进入房间并收到一条新聊天消息，说明网页和信令已通。保持 Piik 与隧道运行，再开始分享，确认朋友能看到画面、听到声音。

- **打不开或提示证书不受信任**时，核对邀请中的域名和公网端口，再到樱花日志确认隧道已启动、已为这个子域名加载证书。[樱花映射排查](https://doc.natfrp.com/faq/site-inaccessible.html)
- **聊天正常，画面连接不上**时，网页隧道已经工作。画面和声音另走 WebRTC，可以先让一方换用手机热点重试。[媒体网络排查](./network.zh-CN.md)

<details>
<summary>Server 也需要通过 frp 中转媒体</summary>

另建一条 UDP 隧道，记录服务商分配的公网 IP 和 UDP 端口。网页隧道继续使用原来的地址。

- **2.x Server** 将隧道的本地端口和 `SFU_UDP_PORT` 都设为分配的公网 UDP 端口，`SFU_PUBLIC_IP` 填该节点的公网 IPv4。[2.x 媒体转发配置](https://github.com/TNTcraftHIM/Piik/blob/main/docs/operations/self-hosting.zh-CN.md#使用托管-frp-服务)
- **3.0 Server** 将隧道转发到 `PIIK_CHANNEL_UDP_PORT`，`PIIK_CHANNEL_UDP_PUBLIC_ADDRESS` 填实际的公网 `IP:端口`。然后在 Server 上启用[站点转发](../../prototype/channel-server/README.md#site-forwarding)。

</details>
