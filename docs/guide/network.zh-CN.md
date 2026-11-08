# 进阶网络排查

本页适用于 3.0 内测版；正式版请看 [2.6.1 网络指南](https://github.com/TNTcraftHIM/Piik/blob/v2.6.1/docs/guide/network.zh-CN.md)。

[English](./network.md) · 简体中文 · [问题排查](./troubleshooting.zh-CN.md)

先按[常见问题](./troubleshooting.zh-CN.md#常见问题)完成基本检查。
**域能打开，但画面、语音或文件下载仍连不上**时，再按现象选择：

- **同一邀请在别的浏览器里正常：** [检查 WebRTC 限制](#浏览器限制了-webrtc)。
- **换成热点就正常：** [对照连接方案](#校园网或严格-nat)。
- **异地朋友之间无法传画面、语音或文件：** [尝试共用虚拟局域网](#可选虚拟局域网)。
- **有地址发现错误，或可以管理路由器：** [检查 STUN、IPv6 与端口映射](#stunipv6-与路由器检查)。

文字、历史、消息表情和附件描述通过域连接传送；画面、语音和文件内容使用设备间连接。
聊天也失败时，先查[域连接与房间托管](./troubleshooting.zh-CN.md#聊天或历史记录加载不出来)。

![参与者通过域与房间托管端交换文字、历史和附件描述；画面、语音和文件内容走点对点连接。](../assets/guide/network-paths.zh-CN.svg)

## 校园网或严格 NAT

用手机热点打开同一邀请。如果热点下画面或文件传输正常，原网络不行，再检查原网络的 UDP、VPN 和防火墙规则。
网页能打开，不代表点对点流量也能通过。

- 用默认 WebRTC 设置的浏览器对照，具体步骤见下节。
- 朋友们能使用同一个组网工具时，可按[虚拟局域网步骤](#可选虚拟局域网)尝试。
- 受管理的网络可请管理员检查 UDP 限制，或换用其他网络。

线路由 Piik 自动选择。当前网络限制无法调整时，可以使用下方的连接方案。

## 浏览器限制了 WebRTC

浏览器设置、VPN 或隐私扩展可能阻止点对点流量，即使域连接与聊天都正常。

1. 用默认设置、未启用相关隐私扩展的浏览器打开同一邀请。
2. 如果能正常使用，检查原浏览器的 **WebRTC** 或 **IP 泄露保护**，允许点对点连接需要的 UDP。
3. 重试观看、语音或下载。学校或公司统一管理的设置需由管理员检查。

<details>
<summary>Chrome / Vivaldi 设置</summary>

`disable_non_proxied_udp` 表示限制未经代理的 UDP。Chrome 扩展可能控制此策略，即使浏览器没有显式开关。
Vivaldi 在 **设置 → 隐私和安全 → WebRTC IP 处理** 中提供 **广播 IP 以获得最佳 WebRTC 性能**。

直连会向对端暴露网络地址。调整阻止连接的设置，其他隐私设置可按需保留。
参考 [Chrome 策略说明](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
与 [Vivaldi 隐私设置](https://help.vivaldi.com/desktop/privacy/privacy-settings/)（英文）。

</details>

## STUN、IPv6 与路由器检查

这部分适合查看 App 日志，或管理域、路由器的人。只修改你能管理的设备与设置。

<details>
<summary>STUN 地址发现</summary>

STUN 用于发现点对点连接可以尝试的地址，不承载聊天或文件内容。
App 和 Server 默认使用内置公共 STUN；管理员可按
[运行参考](../../prototype/channel-server/README.md#rooms-conversation-and-media)配置 `PIIK_CHANNEL_ICE_SERVERS`。
HTTP 反向代理不能转发 STUN UDP，更换 STUN 本身也不能解除网络的 UDP 限制。

STUN 服务会收到参与者的公网 IP，请选择信任的服务。
[WebRTC 连接说明](https://webrtc.org/getting-started/peer-connections)介绍了地址发现的作用（英文）。

</details>

<details>
<summary>IPv6 与路由器映射</summary>

宽带、路由器和双方设备都有可用 IPv6 时，Piik 可以与 IPv4 一起尝试。保留 IPv4；IPv6 仍受防火墙约束。
路由器菜单因型号而异，可参考厂商的 [IPv6 配置说明](https://support.google.com/googlehome/answer/6361450?hl=zh-Hans)。

支持的 UPnP、PCP 或 NAT-PMP 可以让 Native App 为点对点套接字申请映射，浏览器不会申请这些映射。
端口映射不能直接让打不开的邀请网页变得可访问。光猫和路由器都做 NAT 时，可按对应型号的桥接或 AP 模式说明减少一层，修改前先备份。
运营商共享公网地址（CGNAT）位于上游，需向运营商咨询公网 IPv4 或 IPv6。

参考厂商的 [UPnP 说明](https://support.google.com/googlehome/answer/6274337?hl=zh-Hans)
和[双重 NAT 示例](https://www.tp-link.com/us/support/faq/3113/)（英文）。

</details>

## 可选：虚拟局域网

异地朋友之间无法传画面、语音或文件时，可尝试共用一个虚拟局域网。
工具须提供彼此可达的虚拟地址，并传输网页流量和 WebRTC UDP；只加速某个游戏的功能不够。
选择朋友们都能使用的工具：

- **[UU](https://uu.163.com/blog/lan-multiplayer-guide-net.html)：** 使用通用局域网组网入口，加入同一房间；在 Piik 中选择 App 所在设备的 UU 虚拟 IPv4 地址。
- **[Tailscale](https://tailscale.com/docs/how-to/quickstart)（英文教程）：** 各设备安装后，邀请朋友加入同一个私有网络（tailnet）；选择 App 所在设备的 Tailscale IPv4 地址（`100.x.y.z`）。
- **[ZeroTier](https://docs.zerotier.com/quickstart/)（英文教程）：** 各设备加入同一个网络 ID，再到管理页面授权设备；选择 App 所在设备分配到的虚拟 IPv4 地址。

![加入同一虚拟网络，在 App 局域网使用模式中选择虚拟地址，再发送完整域或房间邀请并确认证书。](../assets/guide/virtual-lan.zh-CN.svg)

1. 所有人运行组网工具，加入同一虚拟网络。
2. 在 App 启动页选择 **局域网使用**，从可用邀请地址中选择组网工具的虚拟 IP，再点击 **进入 Piik**。如果已经启动了另一模式，先结束分享并重新打开 App，再选择模式。
3. 创建或打开目标房间，用该虚拟地址发送完整域或房间邀请。朋友先与 App 使用者[核对本地证书](./troubleshooting.zh-CN.md#本地-https-证书提示)，再进入。
4. 先试聊天，再试 **观看**、语音或下载。所有人保持组网工具运行，App 使用者也保持 Piik App 运行。

虚拟地址变化后，重新选择地址并发送新链接。不要发送 `localhost`，它指向每位收件人自己的设备。

- **网页打不开：** 查[本地访问与防火墙](./troubleshooting.zh-CN.md#本地邀请打不开)。
- **聊天或历史加载失败：** 查[房间托管](./troubleshooting.zh-CN.md#聊天或历史记录加载不出来)。
- **聊天正常，画面、语音或文件不通：** 查组网工具是否传输 UDP，再看[WebRTC 设置](#浏览器限制了-webrtc)。
- **麦克风或远控权限不可用：** 使用 HTTPS 邀请，检查[浏览器权限](./troubleshooting.zh-CN.md#无法使用麦克风或远程控制)。

仅与信任的朋友组网。仍然失败时，按[反馈说明](./troubleshooting.zh-CN.md#反馈问题)收集同一次尝试的报告。
