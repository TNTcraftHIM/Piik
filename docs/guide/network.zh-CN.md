# 进阶网络排查

[English](./network.md) · 简体中文 · [问题排查](./troubleshooting.zh-CN.md)

房间能打开，但看不到朋友分享的画面？从[进房后没画面](./no-media-route.zh-CN.md)开始。如果你已经试过其他浏览器或网络，可以直接选对应的情况。

- **同一邀请在别的浏览器里正常：** [检查浏览器限制](#浏览器限制了-webrtc)。
- **换成热点就能看。** [原来的网络连不上时怎么办](#校园网或严格-nat)
- **异地朋友打不开你的本地邀请：** [通过虚拟局域网连接](#可选虚拟局域网)。
- **日志提到 STUN，或准备检查自家路由器：** [地址发现与路由器](#stunipv6-与路由器检查)。

如果是[公网邀请网页打不开](./troubleshooting.zh-CN.md#公网邀请创建失败或出现-1033)，或[有画面但模糊、卡顿](./troubleshooting.zh-CN.md#画面模糊卡顿或中断)，先按对应症状排查。

网页与聊天、画面与声音使用不同的连接：

![房主和朋友通过站点访问网页与聊天；画面和声音使用独立的直连或转发连接。](../assets/guide/network-paths.zh-CN.svg)

## 校园网或严格 NAT

**如果用的是公网邀请，先换手机热点打开同一链接。** 如果能看，可以继续用热点，也可以请管理原来网络的人帮忙。

需要长期使用时，可以选择以下方案：

- **有可用的 Piik 站点：** 请管理员确认站点已开启画面和声音转发。房主在该站点关闭 **隐私模式** 后开始分享，再把新房间的邀请发给观众。直连失败时，Piik 会尝试通过站点转发。[管理员设置](../operations/self-hosting.zh-CN.md#可选启用媒体兜底) · [用 App 在已有站点分享](./getting-started.zh-CN.md#通过已有站点使用-app)
- **没有可用的转发站点，直连仍然失败：** 可尝试[虚拟局域网](#可选虚拟局域网)。朋友们加入同一个虚拟网络，再通过 App 的 **本地房间** 分享。

<details>
<summary>站点管理员可选读 · 转发画面和声音</summary>

**媒体需要 UDP。** `demo.piik.tv` 和 App 的 **公网邀请** 使用纯 P2P。
服务器转发需要站点启用 SFU，并且 UDP 端点可达。

</details>

## 浏览器限制了 WebRTC

1. 用另一款浏览器打开同一邀请。如果那里能看到画面，可以直接用它观看。
2. 想继续使用原浏览器，可以先用默认设置的新浏览器配置打开邀请。如果能看，检查原配置的隐私扩展。如果两款浏览器都看不到，公网邀请可以换手机热点再试。本地邀请需要让两台设备都留在同一个局域网或虚拟局域网内。

<details>
<summary>进阶 · Chrome 或 Vivaldi 的隐私设置</summary>

浏览器或 VPN 的 WebRTC 策略可能阻止画面连接，也可能影响同一台电脑上的 App 采集。检查原配置中的 **WebRTC** 或 **IP 泄露保护**。学校或公司统一管理的设备，请联系管理员。

`disable_non_proxied_udp` 表示限制未经代理的 UDP，可先与浏览器默认策略对照。
Chrome 的扩展可能控制此策略，即使浏览器没有显式开关。
Vivaldi 在 **设置 → 隐私和安全 → WebRTC IP 处理** 中提供 **广播 IP 以获得最佳 WebRTC 性能**。

直连可能向对端暴露网络地址。调整阻止 UDP 的设置，其他隐私设置可按需保留。
参考 [Chrome 策略说明](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)
与 [Vivaldi 隐私设置](https://help.vivaldi.com/desktop/privacy/privacy-settings/)（英文）。

</details>

## STUN、IPv6 与路由器检查

这部分适合查看日志的 App 用户，以及可以管理站点或路由器的人。只检查你能够管理的部分。

<details>
<summary>STUN：地址发现与服务配置</summary>

STUN 用于发现设备可连接的地址。App 公网邀请会尝试多个服务；地址发现失败时，
在启动公网邀请前设置 [`PIIK_STUN_URLS`](../standards/configuration.md#piik-app-configuration)，替换内置地址。
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

朋友在外地，也可以用组网工具把设备连到同一个虚拟局域网，再用 Piik App 的 **本地房间** 分享。选择支持局域网组网的工具，让朋友也加入同一个网络。

- **[UU](https://uu.163.com/blog/lan-multiplayer-guide-net.html)：** 使用通用局域网组网入口，加入同一房间。在 Piik 中选择房主的 UU 虚拟 IPv4 地址。
- **[Tailscale](https://tailscale.com/docs/how-to/quickstart)（英文教程）：** 各设备安装后，邀请朋友加入同一个私有网络（tailnet）。在 Piik 中选择房主的 Tailscale IPv4 地址（`100.x.y.z`）。
- **[ZeroTier](https://docs.zerotier.com/quickstart/)（英文教程）：** 各设备加入同一个网络 ID，再在管理页面授权这些设备。在 Piik 中选择分配给房主的虚拟 IPv4 地址。

![虚拟局域网三步：加入同一虚拟网络，在本地房间选择虚拟地址，发送完整邀请并确认证书。](../assets/guide/virtual-lan.zh-CN.svg)

1. **加入同一网络。** 房主和朋友都运行组网工具，进入同一个虚拟局域网。
2. **房主在 Piik 里选地址。** 在组网工具里查看自己这台设备的 IPv4 地址。打开 Piik App，选 **本地房间**，展开 **局域网邀请地址**，在列表里选中相同的地址，然后进房开播。下图的示例地址是 `192.0.2.30`。

   ![局域网邀请地址字段显示选中的示例虚拟网卡及其 IPv4 地址。](../assets/guide/virtual-lan-address.zh-CN.png#gh-light-mode-only)
   ![局域网邀请地址字段显示选中的示例虚拟网卡及其 IPv4 地址。](../assets/guide/virtual-lan-address.zh-CN.dark.png#gh-dark-mode-only)

3. **发送完整邀请。** 房主复制 Piik 生成的完整 HTTPS 邀请发给朋友。链接里应包含刚选的虚拟 IPv4 地址。朋友打开链接，首次访问时先和房主核对证书，再进入房间。[核对本地证书](./troubleshooting.zh-CN.md#本地-https-证书提示)
4. **请朋友试播。** 请朋友确认能看到正在分享的画面。如果房主开启了声音分享，也应能听到声音。观看期间，双方都保持组网工具运行，房主还需保持 Piik App 运行。虚拟 IP 变化后，房主重新选地址，再发新邀请。

遇到问题时，按最先失败的一步检查：

- **网页打不开：** 先查[本地邀请与防火墙](./troubleshooting.zh-CN.md#本地邀请打不开)，确认 Piik 可通过该虚拟网络访问。
- **网页能开，画面连不上。** 请房主[允许 Piik 的 UDP 媒体通信通过防火墙](./troubleshooting.zh-CN.md#本地邀请打不开)。确认双方都开了通用的局域网组网功能，且支持设备之间的 UDP 通信。仍看不到画面时，再检查[浏览器的 WebRTC 设置](#浏览器限制了-webrtc)。
- **不能开麦或远控：** 使用 App 生成的 HTTPS 邀请，确认证书，再查[浏览器权限](./troubleshooting.zh-CN.md#无法使用麦克风或远程控制)。支持的浏览器无需公网隧道即可使用这些功能，普通局域网同样适用。

仅与信任的朋友组网。

如果需要 App 或 Server 的固定公网邀请地址，可用现有 frp 服务或自建隧道。[frp 与樱花映射教程](./frp.zh-CN.md)

仍有问题时，请按[反馈说明](./troubleshooting.zh-CN.md#反馈问题)收集同一次尝试的报告。
