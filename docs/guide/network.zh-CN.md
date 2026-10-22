# 进阶网络排查

[English](./network.md) · 简体中文 · [问题排查](./troubleshooting.zh-CN.md)

本页用于排查 **网页能打开，但画面或语音连接不上**。按你的情况选择：

- **校园网、公司网络，或换成热点就能看：** [选择连接方案](#校园网或严格-nat)。
- **同一邀请在别的浏览器里正常：** [检查浏览器限制](#浏览器限制了-webrtc)。
- **日志提到 STUN，或准备检查自家路由器：** [地址发现与路由器](#stunipv6-与路由器检查)。
- **准备使用 UU、Tailscale 或 ZeroTier：** [虚拟局域网使用步骤](#可选虚拟局域网)。

网页、邀请和聊天与画面、声音使用不同的连接。因此，能进房间或发消息，并不代表媒体已连通。

![房主和朋友通过站点访问网页与聊天；画面和声音使用独立的直连或转发连接。](../assets/guide/network-paths.zh-CN.svg)

如果是[邀请网页打不开](./troubleshooting.zh-CN.md#公网邀请创建失败或出现-1033)，或[画面已经出现但模糊、卡顿](./troubleshooting.zh-CN.md#画面模糊卡顿或中断)，先按对应症状排查。

## 校园网或严格 NAT

**先用手机热点打开同一邀请。** 热点能看、原网络不能看时，原网络的共享出口或防火墙限制更值得检查。

需要长期使用时，可以选择以下方案：

- **有可用的 Piik 站点：** 请管理员[启用服务器媒体转发（SFU）](../operations/self-hosting.zh-CN.md#可选启用媒体兜底)，房主关闭 **隐私模式**，直连失败时即可尝试转发。使用 App 采集时，[授权新站点](./getting-started.zh-CN.md#通过已有站点使用-app)，再发送该站点的邀请。
- **朋友们可以安装组网工具：** 按下方[虚拟局域网步骤](#可选虚拟局域网)，通过 App 的 **本地房间** 分享。
- **所需的连接被网络阻断：** 换用可用网络，或请网络管理员检查放行。

> **在线版与公网邀请的边界：** `demo.piik.tv` 和 App 的 **公网邀请** 都是纯 P2P，没有服务器媒体兜底。P2P 和 SFU 媒体目前均需要 UDP；仅搭建网页服务不能解决媒体 UDP 被阻断的问题。

## 浏览器限制了 WebRTC

浏览器的 WebRTC 设置、VPN 或隐私扩展可能阻止画面和声音连接。
这也会影响同一台电脑上的网页与 App；能选到来源，不代表媒体连接一定可用。

1. 用默认设置、未启用相关隐私扩展的浏览器打开同一邀请，对照能否观看。
2. 如果新配置可以观看，检查原浏览器中的 **WebRTC** 或 **IP 泄露保护** 选项，恢复允许 WebRTC UDP 的策略。
3. 修改后刷新 Piik 页面，再尝试分享或观看。学校或公司统一管理的策略需由管理员调整。

<details>
<summary>Chrome / Vivaldi 设置</summary>

`disable_non_proxied_udp` 表示限制未经代理的 UDP，可先与浏览器默认策略对照。
Chrome 的扩展可能控制此策略，即使浏览器没有显式开关。
Vivaldi 在 **设置 → 隐私和安全 → WebRTC IP 处理** 中提供 **广播 IP 以获得最佳 WebRTC 性能**。

仅隐藏本机 IP 不一定会阻止 WebRTC。允许直连可能向对端暴露网络地址，只调整相关选项即可。
参考 [Chrome 策略说明](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
与 [Vivaldi 隐私设置](https://help.vivaldi.com/desktop/privacy/privacy-settings/)（英文）。

</details>

## STUN、IPv6 与路由器检查

这部分适合查看日志的 App 用户，以及可以管理站点或路由器的人。只检查你能够管理的部分。

<details>
<summary>STUN：地址发现与服务配置</summary>

App 公网邀请使用多个地址发现服务，**单个 STUN 报错不代表全部线路失败**。
需要更换时，在启动公网邀请前设置 [`PIIK_STUN_URLS`](../standards/configuration.md#piik-app-configuration)，替换所有内置地址。
自部署管理员应检查 `STUN_URLS` 是否指向可达的 UDP 服务；HTTP 反向代理不能转发 STUN。

STUN 服务会接收到参与者的公网 IP，请选择信任的服务。
[WebRTC 连接说明](https://webrtc.org/getting-started/peer-connections)介绍了地址发现的作用（英文）。

</details>

<details>
<summary>IPv6：检查双方网络</summary>

宽带、路由器和双方设备都有可用 IPv6 时，Piik 可以在 IPv4 之外尝试这条路径。
同时保留 IPv4；IPv6 仍受防火墙约束。路由器菜单因型号而异，参考厂商的
[IPv6 配置说明](https://support.google.com/googlehome/answer/6361450?hl=zh-Hans)。

</details>

<details>
<summary>路由器：端口映射与共享地址</summary>

支持的 UPnP、PCP 或 NAT-PMP 可以让 App 原生媒体连接申请端口映射；纯浏览器采集不会申请。
光猫和路由器都做 NAT 时，可按对应型号的桥接或 AP 模式说明减少一层，修改前先备份配置。
运营商共享公网地址（CGNAT）位于上游，需向运营商咨询公网 IPv4 或 IPv6 服务。

参考厂商的 [UPnP 说明](https://support.google.com/googlehome/answer/6274337?hl=zh-Hans)
和[双重 NAT 示例](https://www.tp-link.com/us/support/faq/3113/)（英文）。

</details>

## 可选：虚拟局域网

虚拟局域网让异地设备像在同一网络中一样互访，再通过 Piik App 的 **本地房间** 分享。
工具必须提供可互访的虚拟 IPv4 地址，同时支持网页访问和 WebRTC UDP；只加速某个游戏的功能不适用。
选择朋友们都能使用的工具即可：

- **[UU](https://uu.163.com/blog/lan-multiplayer-guide-net.html)：** 使用通用局域网组网入口，加入同一房间。在 Piik 中选择房主的 UU 虚拟 IPv4 地址。
- **[Tailscale](https://tailscale.com/docs/how-to/quickstart)（英文教程）：** 各设备安装后，邀请朋友加入同一个私有网络（tailnet）。在 Piik 中选择房主的 Tailscale IPv4 地址（`100.x.y.z`）。
- **[ZeroTier](https://docs.zerotier.com/quickstart/)（英文教程）：** 各设备加入同一个网络 ID，再在管理页面授权这些设备。在 Piik 中选择分配给房主的虚拟 IPv4 地址。

![虚拟局域网三步：加入同一虚拟网络，在本地房间选择虚拟地址，发送完整邀请并确认证书。](../assets/guide/virtual-lan.zh-CN.svg)

1. **加入同一网络。** 房主和朋友都运行组网工具，进入同一个虚拟局域网。
2. **房主选择虚拟地址。** 在新版 Piik App 选择 **本地房间**，展开 **局域网邀请地址**，选择组网工具提供的 IP，然后进入房间并分享。
3. **发送完整邀请。** 朋友打开该虚拟 IP 下的 HTTPS 邀请，首次访问先与房主[核对本地证书](./troubleshooting.zh-CN.md#本地-https-证书提示)，再进入房间。不要发送 `localhost` 地址或只发房间号。
4. **确认画面和声音。** 所有设备保持组网工具运行，房主同时保持 Piik App 运行。虚拟 IP 变化后，房主需重新选择地址并发送新邀请。

Piik 已通过 UU 在 Windows 设备间实测；Tailscale、ZeroTier 尚未与 Piik 实测，可按下方步骤检查实际连通性。

遇到问题时，按最先失败的一步检查：

- **网页打不开：** 先查[本地邀请与防火墙](./troubleshooting.zh-CN.md#本地邀请打不开)，确认 Piik 可通过该虚拟网络访问。
- **网页能开，画面连不上：** 检查工具是否传输媒体 UDP，以及[浏览器 WebRTC 设置](#浏览器限制了-webrtc)。网页连通不代表媒体连通。
- **不能开麦或远控：** 使用 App 生成的 HTTPS 邀请，确认证书，再查[浏览器权限](./troubleshooting.zh-CN.md#无法使用麦克风或远程控制)。支持的浏览器无需公网隧道即可使用这些功能，普通局域网同样适用。

仅与信任的朋友组网；防火墙、浏览器地址发现与第三方服务仍会影响可用性。

<details>
<summary>通过 frp 转发已有服务器</summary>

有公网服务器的管理员可按 [frp 教程](../operations/self-hosting.zh-CN.md#可选通过-frp-转发已有服务)，
通过 frps 转发已有站点的网页和 SFU 端点；只转发网页不能同时转发 WebRTC 媒体。

</details>

仍有问题时，请按[反馈说明](./troubleshooting.zh-CN.md#反馈问题)收集同一次尝试的报告。
