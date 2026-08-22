# P2P 优先游戏屏幕共享调研与可行性评估

- 调研日期：2026-08-18
- 移动端采集与 Viewer 投屏能力复核：2026-08-21
- selected candidate 地址隐私语义复核：2026-08-22
- 目标场景：一名玩家向少量熟人私密分享，观看者可用手机/桌面浏览器加入，低延迟，尽量不消耗媒体服务器带宽
- 结论状态：本文记录已部署 PoC 的 P2P/coturn 基线。ADR-0005 与[低服务器成本媒体路由](./low-server-media-routes.md)已取代本文早期“每条 peer edge 必带 TURN”的旗舰建议；生产后续移除了 room `1` 边界，ordinary ICE 仍为 STUN-only，selected-edge TURN 已配置但尚未完成真实媒体验收

> Truth-audit boundary: direct/peer first、ordinary STUN-only 和 dated production evidence 仍是输入；固定 SFU/TURN 顺序、root/lease 数值和资源计账受 [TODO audit hold](../todo-audit-hold.md) 约束，不是当前实现授权。

## 结论

这个想法可行，而且非常适合先做 Web MVP。它的定位不是缩小版 Twitch，而是好友之间临时、私密、低延迟的实时窗口。正确的首版不是“完全没有服务器”，而是把系统拆为轻量控制面和 P2P 优先的数据面；分享者可以先用 Web/Electron，观看者应能直接打开手机或桌面浏览器链接：

```text
                         HTTPS / WSS
分享者 <------------ 房间、鉴权、信令 ------------> 观看者
   |                                               |
   +---- ICE + STUN 尝试直接 UDP WebRTC ----------+
   |
   +---- direct/peer UDP -> SFU root -> selected TURN edge

2026-08-18 的历史目标顺序是 direct/peer UDP -> SFU virtual parent -> optional selected-edge TURN -> 明确失败；room `1` 只是首个 bounded production smoke，生产后来移除了 exact-room 边界并对所有房间运行 automatic controller。retained-media 验收仍未完成，未来 SFU/TURN 顺序与计账受 truth-audit hold 约束。
系统必须无感完成拓扑分配、恢复和必要迁移；大规模公开分享仍直接使用现有直播服务。
```

“让画面跑起来”难度不高；“像 Discord/TeamSpeak 一样在不同 GPU、浏览器、NAT、运营商和弱网中都保持清晰、60 fps、低延迟”难度高。建议把产品分层：

- 原型：Web、P2P、STUN、TURN，验证小范围多观看者；当前默认接入上限为八、可配置 1 至 16，但真实 1:8 仍待验证。
- 可用 MVP：房间鉴权、短期 TURN 凭据、质量降档、ICE restart、统计与 30 分钟稳定性测试。
- 产品化：Electron 分享端、Web/移动观看端、Windows 应用音频、硬件编码诊断和区域化 TURN。
- Discord 级：原生捕获/编码引擎、多个捕获后端、GPU 零复制、进程树音频、广泛兼容与持续遥测，属于长期工程。

## 竞品事实

| 产品 | 已公开的可靠事实 | 对本项目的含义 |
| --- | --- | --- |
| Discord Go Live | 使用 WebRTC，但媒体发往 Discord RTC Worker 后再转发给观看者；官方明确这是为了路由控制和隐藏用户 IP。桌面端有原生 C++ media engine、自研捕获/编码、多后端回退和硬件编码。 | Discord 的稳定性并不是纯 P2P 或纯浏览器免费获得的。它是未来质量上限参考，不是首版拓扑参考。 |
| TeamSpeak 6 | 官方技术回复说明用 WebRTC/ICE 做 P2P 屏幕分享；Windows 在 DX、Windows Game Capture 与传统捕获路径间选择。2026-04 官方称其 `turn.*` 主机实际仅启用 STUN，server-side SFU 仍在开发。 | 与当前目标接近，也解释了 direct-only/STUN-only 的部分可达风险；Screener 已部署 coturn 基线，旗舰迁移改由 SFU/UDP roots 兜底并把 TURN 设为可选兼容层。 |
| KOOK / Oopz | 官方 SDK 清单只足以证明屏幕分享接入声网相关能力，没有公开具体媒体拓扑。 | 可以参考交互，不能把它们写成已经证实的 P2P 或 SFU 案例。 |

来源：

- [Discord Go Live 技术概览](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Discord WebRTC 架构](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc)
- [Discord GPU 编码优化](https://discord.com/blog/from-blocky-to-brilliant-improving-video-quality-on-discord-go-live-on-amd-gpus)
- [TeamSpeak 6 WebRTC 捕获与传输说明](https://community.teamspeak.com/t/what-dependencies-are-needed-for-screen-share/56852)
- [TeamSpeak 6 P2P 与未来 SFU 状态](https://community.teamspeak.com/t/where-is-screen-share-available-ts3-server-does-not-show-start-stream-button/58890)
- [TeamSpeak 6 P2P 技术讨论](https://community.teamspeak.com/t/how-does-share-screen-technically-work/56850)
- [TeamSpeak 6 当前 STUN/TURN 状态讨论](https://community.teamspeak.com/t/only-p2p-available-on-server-not-implemented-yet/55034?page=3)
- [KOOK SDK 清单](https://m.kookapp.cn/sdk_list.html)
- [Oopz 隐私与 SDK 说明](https://help.oopz.cn/agreement/privacy)

## ICE、STUN、TURN 与信令

- 信令服务交换身份、房间状态、SDP 和 ICE candidates。WebRTC 不规定信令协议，WSS 是直接选择。
- STUN 让客户端发现公网映射并产生 server-reflexive candidate。它不承载媒体，也不能保证穿过所有 NAT。
- ICE 测试 host、server-reflexive、peer-reflexive 和 relay candidates，并选择可工作的候选对。Trickle ICE 可以减少建连等待。
- TURN 在无法直连时转发完整媒体流，是 NAT 组件中真正产生高带宽成本的部分。
- 当前媒体梯级是 direct/peer UDP -> SFU/UDP roots -> optional selected-edge TURN/UDP -> bounded failure。Ordinary peer 只接收 STUN；controller 只为当前异常 edge 的一次重建签发短期 TURN 凭据。每个 `RTCPeerConnection` 只检查实际配置的候选，全部 UDP 路径耗尽后明确失败。

不存在适用于所有用户的权威“P2P 直连率”。CGNAT、endpoint-dependent mapping、校园/企业防火墙、移动网络、IPv6 和地区运营商都会改变结果。首版必须通过 `getStats()` 统计自己的 `host/srflx/prflx/relay` 比例，而不是引用未经验证的行业百分比。

### 为什么会“有人能看，有人看不了”

ICE 是按分享者与每一名观看者的网络组合独立选路，而不是整个房间只做一次连接。一个家庭宽带观看者可能成功 UDP 打洞，另一个处于 CGNAT、对称 NAT、校园网、企业代理或蜂窝网络的观看者却没有可用直连候选。因此同一房间天然可能出现不同结果。

当前边界如下：

1. 将 direct UDP 设为最高优先级，成功者保持零媒体服务器路径。
2. Ordinary peer ICE 为 STUN-only；UDP peer 失败时优先使用 SFU root，可选 coturn 只由 selected-edge grant/rebuild 授予异常连接。
3. 通过统计确认最终选中的 candidate pair；LiveKit participant TURN 与 selected-edge coturn 分别记录，不能从应用计时顺序推断路径。
4. 网络切换或候选对失效时执行 ICE restart，超时后重建该 peer connection。
5. 在 UI 和诊断中区分“直连”“服务器中继”“正在恢复”和明确失败原因。

这种混合房间里，一名观看者走 TURN/UDP 不会迫使其他观看者也中继；被中继的 WebRTC 媒体仍由端点间 DTLS-SRTP 加密。

来源：

- [WebRTC peer connection 与信令](https://webrtc.org/getting-started/peer-connections)
- [ICE RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html)
- [WebRTC transport 要求 RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html)
- [TURN RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html)
- [Trickle ICE RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html)

## 一对多带宽账

设单路编码码率为 `B`，观看者数量为 `N`。以下未计音频、RTP/IP 头、重传和 FEC；生产预算再预留约 10% 至 20%。

| 拓扑 | 分享者上行 | 服务器媒体 I/O | 适用性 |
| --- | ---: | ---: | --- |
| P2P 星型 | `N * B` | 直连时接近 0 | 最符合成本目标；适合少量朋友 |
| P2P + TURN | 仍为 `N * B` | 每条中继约 `B` 入 + `B` 出 | 只解决不可达，不解决分享者上行 |
| Peer-assisted 两链 | 分享端最多约 `2 * B` | 直连边接近 0；TURN 仍按边计费 | 每名 viewer 最多转发一份；标准 browser relay 逐跳解码/重编码 |
| 整房 SFU（仅对照） | 约 `B` | `B` 入 + `N * B` 出 | 分享者轻松，但服务器承担全部观看流量；当前 root-shape 目标另按 `B_pub`、`B_i` 和 `B_exc,j` 计量 |
| MCU | 约 `B` | 另有解码、合成、重编码 | 本场景没有合成需求，不采用 |

以 `8 Mbps` 的 1080p60 目标流为例：

| 观看者 | 分享者上行 | 每小时分享者发送量 |
| ---: | ---: | ---: |
| 1 | 8 Mbps | 3.6 GB |
| 2 | 16 Mbps | 7.2 GB |
| 3 | 24 Mbps | 10.8 GB |
| 4 | 32 Mbps | 14.4 GB |
| 5 | 40 Mbps | 18.0 GB |
| 8 | 64 Mbps | 28.8 GB |

实际高动态 1080p60 可以把首版目标区间设为约 6 至 10 Mbps，因此四名观看者需要约 24 至 40 Mbps 持续上行，再加协议和重传余量。对光纤用户这并非不可行，但不能假设所有用户都具备该条件。

把同一 `MediaStreamTrack` 加到多个 `RTCPeerConnection` 会产生多个独立 `RTCRtpSender`、拥塞控制状态和码率目标。标准不保证跨连接只编码一次；浏览器可能优化，也可能创建多个编码上下文。因此分享端 CPU/GPU 容量必须实测。即使未来原生实现单次编码、多 peer packet fan-out，上行仍然是 `N * B`。

IETF 对 mesh/SFU 的拓扑说明见 [RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html)。

## 推荐的拓扑策略

当前生产基线：

- 生产已移除 exact-room allowlist，所有房间由 bounded peer-assisted/SFU controller 自动路由；ordinary peer 仍使用 STUN-only ICE。
- 当前 PoC 默认允许八名观看者，部署者可配置 1 至 16，超额连接会被明确拒绝。该数值只控制接入，不代表 1:8 已通过性能验收；必须收集可用上行、实际发送码率、`qualityLimitationReason`、编码耗时和发送队列来确定真实可持续人数。
- 每条 ordinary peer 链路独立使用 STUN-only ICE；只有控制器选中的异常 edge 才会获得短期 TURN credential。
- Exact release `9461e20` 的所有房间在 peer recovery 与 alternate parent 耗尽后可准备最多两个 SFU/UDP roots；这是受 truth-audit hold 约束的已部署事实，不是未来固定 root 数的授权。首次 room `1` smoke 已观察到 participant entry，但 retained media 尚未验收。
- 桌面和手机观看者使用同一个 Web 播放端；分享者不要求朋友安装完整客户端。

当前接受的非服务器 endpoint downstream 默认值为二，并允许部署静态配置为一、二或三；分享端及 Viewer 遵守同一规则。ADR-0004 的可删除实验验证第三名及后续 viewer 可由客户端转发；ADR-0005 的自动 controller 最初在 room `1` 受限部署，现已覆盖所有房间。未来 SFU/TURN 层级、计账和 fallback 顺序仍在 truth-audit hold 中。retained SFU media、移动端矩阵和 broad rollout 仍未通过门槛；已关闭 PR #12 的显式整房 SFU 模式不再是当前方案。超过小房间上限时仍建议使用外部直播服务。观察项包括：

- 正常工作负载持续超过实测可承载的 P2P 人数。
- 当前 edge 已耗尽 peer recovery、alternate parent 与 SFU/UDP；未来只有该 edge 可进入 selected-edge TURN 决策。
- 分享者上行安全余量不足。
- 分享者因 CPU/encoder 限制降质。
- 产品开始要求隐藏好友之间的 IP。

不要把观看者转发树直接加入 MVP。标准浏览器把收到的 WebRTC track 再发布会走解码后的 raw-frame sender，并创建新的编码 pipeline，增加负载、质量损失和逐跳延迟。ADR-0004 只允许用这条标准路径做确定性的两链 spike；若需要 Encoded Transform/DataChannel/WebCodecs 媒体、自定义拥塞控制、FEC/RTX、多树或综合评分，即放弃实验。详细证据见 `peer-assisted-media.md`。

## Web、Electron 与原生能力

### Web MVP

Web 版本能直接使用 `getDisplayMedia()` + WebRTC，最适合验证产品。但需要接受：

- 只能在 HTTPS 或 localhost 安全上下文使用。
- 每次捕获必须由用户手势触发并重新选择来源；授权不能持久保存。
- 网页不能通过 `deviceId` 强制指定某个游戏窗口。
- 即使请求 `audio: true`，浏览器规范也允许只返回视频；必须检查音轨是否存在。
- 1080p60 可以请求但不能保证。选择来源后用 `track.getSettings()` 验证实际分辨率和帧率。
- 最小化窗口、受保护内容、UAC secure desktop 和某些独占全屏路径可能黑屏或停止。游戏使用无边框窗口，或分享整个显示器，通常更稳。

直播中换源不需要先关房间。`RTCRtpSender.replaceTrack()` 可在同类媒体且协商 envelope 允许时替换 sender 的来源而不重新协商；分辨率、帧率块率、音频声道或编码约束不兼容时会拒绝，因此应用必须把失败限制在该 viewer 并重建其连接。为支持浏览器有时返回音频、有时不返回，初始 offer 可以预留 send-only audio transceiver，再将 audio sender 在 `null` 与真实 track 间替换。新的 `getDisplayMedia()` 仍必须由用户手势触发并重新选源，取消选择时旧流应继续工作。

游戏轨建议设置：

```js
track.contentHint = "motion";

const parameters = sender.getParameters();
parameters.encodings ??= [{}];
parameters.encodings[0].maxFramerate = 60;
parameters.encodings[0].maxBitrate = selectedProfileBitrate;
parameters.degradationPreference = "balanced";
await sender.setParameters(parameters);
```

这些参数是偏好或上限，不能绕过浏览器拥塞控制，也不能保证目标码率。`balanced` 允许浏览器在分辨率和帧率之间权衡，但不规定具体算法；本项目的 `contentHint = "motion"` 还会影响 Chromium/libwebrtc 对来源的内部分类，因此不能套用其仅限 screen encoder 的 `maintain-resolution` 重解释。当前源码链与测量要求见 [Realtime quality adaptation](./realtime-quality-adaptation.md)。静态画面通常能降低编码数据量，但规范不保证所有浏览器主动降低捕获频率或 GPU 开销。

因此首版不实现画面差分检测、周期性 `applyConstraints()` 或自定义动态 FPS 状态机。先对静态桌面和高动态游戏分别记录 `framesEncoded`、发送码率、`totalEncodeTime / framesEncoded`、`qualityLimitationReason` 及主机 CPU/GPU 占用；只有测量显示浏览器行为留下显著问题时，再设计最小的控制策略。这避免用额外竞态、计时器和画质跳变解决一个可能已由捕获器、编码器和 WebRTC 拥塞控制处理的问题。

来源：

- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)
- [W3C RTCRtpSender.replaceTrack](https://www.w3.org/TR/webrtc/#dom-rtcrtpsender-replacetrack)
- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [MediaStreamTrack content hints](https://www.w3.org/TR/mst-content-hint/)
- [RTCRtpSender 参数](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [Chromium capture 架构](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/media/capture/)

### 移动浏览器分享端边界

截至 2026-08-21，普通手机浏览器不能作为可靠的 Screener Host。当前
MDN Browser Compatibility Data 把 `getDisplayMedia()` 标为 Chrome Android、
Firefox Android 和 Safari iOS 均不支持；Chrome Android 72--88 与 Firefox
Android 66--79 曾暴露方法，但调用恒定以 `NotAllowedError` 失败。屏幕音频在
Chrome Android 也标为不支持。桌面模式、UA 或设备性能不能改变这个平台 API
边界。

Web UI 后续只做最小诚实处理：运行时检查
`navigator.mediaDevices?.getDisplayMedia`，缺失时在建房/发布前明确显示不支持；
方法存在也只表示可以尝试，真实调用失败仍区分 denied/cancelled/capture-failed，
不能按 UA 宣称兼容。移动 Viewer 不需要该 API，继续使用同一响应式 Web 播放端；
relay capacity 与其他普通 Web Viewer 相同。

来源：

- [MDN Browser Compatibility Data: `MediaDevices.getDisplayMedia`](https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json)
- [MDN `getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [W3C Screen Capture](https://w3c.github.io/mediacapture-screen-share/)

### Viewer 后台播放边界

当前 Viewer 使用一个持续存在、可听的 `<video autoplay playsinline>`，播放被浏览器拦截时保留显式用户手势入口；信令心跳由服务端 WebSocket ping 和浏览器原生 pong 完成。Chrome 把可听媒体、WebRTC 和 WebSocket 视为后台保留连接的活动，并允许隐藏页节流视觉更新；页面若被系统冻结或回收，Web 应用本身不能继续执行。WebKit 也会在页面可听时保留 iOS Web 进程。产品契约覆盖已经开始的音频和连接；隐藏页面的视频合成只代表呈现层。

一轮保留的 Chrome 151 双 Viewer 结果与该边界一致：后台标签页的 inbound、decoded 和 Opus RTP 计数继续增长，`requestVideoFrameCallback` 保持不变；前台 Viewer 的逐帧回调正常增长。这只证明该受控桌面样本的接收、解码和音频包连续性，不是可听性或手机生命周期证明。iOS 锁屏、页面回收，以及后台期间换父或重连后出现的新媒体仍进入真机矩阵；LiveKit 的 Safari issue 也区分了持续播放的既有音轨与后台新建音频元素。

来源（访问于 2026-08-21）：[Chrome background tabs](https://developer.chrome.com/blog/background_tabs)、[Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)、[WebKit audible-page process assertion](https://bugs.webkit.org/show_bug.cgi?id=173932)、[WHATWG media elements](https://html.spec.whatwg.org/multipage/media.html)、[LiveKit Safari background audio issue #1751](https://github.com/livekit/client-sdk-js/issues/1751)。

### Viewer 向电视输出边界

截至 2026-08-21，Remote Playback API 仍不能作为 live WebRTC 的可移植输出契约。
W3C Candidate Recommendation 没有定义 `MediaStream`/`srcObject` 的远端播放行为，
把目标兼容性留给 UA；当实现只有 media flinging、媒体源又不是可交给目标的 URL 时，
规范明确允许 `prompt()` 返回 `NotSupportedError`。Chromium `f004e4a` 的实现只为非空、
有效且已判定兼容的 `KURL` 建立 availability URL；Screener 的进程内 `MediaStream`
没有该 URL。仅检测到 `HTMLMediaElement.remote` 因而不等于当前直播可投屏。

Safari 的边界更明确：WebKit `e88b92e` 的
`MediaPlayerPrivateMediaStreamAVFObjC::supportsType()` 对任何非本机 wireless playback
target 直接返回 `IsNotSupported`，而 Apple 的 AirPlay picker 示例使用 URL 型
`<video src="my-video.mp4">`，没有承诺 live WebRTC。当前 Safari AirPlay 媒体按钮和
Chrome Remote Playback 都不能为 Screener 显示一个诚实可用的站内入口；保留本机播放
以及系统级整屏/标签页镜像。

Google Cast `MediaInfo` 的 `contentUrl` 会被用作 media URL，缺失时 `contentId` 自身会
被当作 media URL；当前 P2P Viewer 持有的是进程内 `MediaStream`，没有可供电视 fetch
的 URL。为它新增转码、
HLS/Web Receiver 或私有协议会改变服务器媒体成本和安全边界，当前不做。投屏只属于
Viewer 本地播放输出；无论是否启用，现有 upstream PeerConnection、TURN/SFU/peer
route、Host fanout 和其他 Viewer 均不变。

未来只在浏览器发布说明或实现明确支持 live `MediaStream` wireless playback 后重开
这一切片。先用未合入产品的诊断页分别验证 Safari -> 实体 Apple TV 和 Chrome ->
实体 Chromecast/Google TV：现有 `srcObject` 的动态画面与音频连续播放至少 60 秒，
连接/断开后本机播放恢复，且 upstream PeerConnection identity、route 和 edge count
不变。某一平台单独通过时只支持该平台；通过后产品改动限于现有 `<video>` 的本地
availability 监听、一个用户手势图标按钮、状态/错误和监听清理，不增加媒体 URL、
receiver、信令或服务端路径。

许可证边界：这里只引用规范和官方实现行为，没有复制 Chromium/WebKit 代码或引入
依赖。当前不加载 Google Cast SDK，也不接受其 Additional Developer Terms；若未来改走
Cast sender/receiver，必须先单独完成条款、注册和分发审查。

来源（访问于 2026-08-21）：

- [MDN Remote Playback API](https://developer.mozilla.org/en-US/docs/Web/API/Remote_Playback_API)
- [W3C Remote Playback API](https://www.w3.org/TR/remote-playback/)
- [Apple: Adding an AirPlay button to Safari media controls](https://developer.apple.com/documentation/webkitjs/adding_an_airplay_button_to_your_safari_media_controls)
- [Chromium `RemotePlayback` implementation at `f004e4a`](https://chromium.googlesource.com/chromium/src/+/f004e4a02b0ac1998398ed361d6aa133702b8c61/third_party/blink/renderer/modules/remoteplayback/remote_playback.cc)
- [WebKit live `MediaStream` AVFoundation player at `e88b92e`](https://github.com/WebKit/WebKit/blob/e88b92e29f0753e644abe33fdbc2b78c051ebf59/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateMediaStreamAVFObjC.mm)
- [Google Cast Web Sender integration](https://developers.google.com/cast/docs/web_sender/integrate)
- [Google Cast `chrome.cast.media.MediaInfo`](https://developers.google.com/cast/docs/reference/web_sender/chrome.cast.media.MediaInfo)
- [Google Cast SDK Additional Developer Terms](https://developers.google.com/cast/docs/terms)

### Electron 分享端

Electron 可以固定 Chromium 版本，枚举屏幕/窗口，改善选源、热键和分享状态 UX，并使用 loopback 系统音频。它底层仍是 Chromium，单靠封装不会自动获得 Discord 级捕获质量。

推荐升级顺序：

1. Web 分享端和观看端。
2. Electron 分享端 + Web 观看端。
3. 若音频范围仍有问题，添加很小的 Windows WASAPI process-loopback native helper。
4. 只有实测证明捕获/编码是瓶颈时，才加入 WGC/DDA 纹理和原生 libwebrtc/硬件编码路径。

来源：

- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer/)
- [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [WASAPI loopback](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [Application loopback sample](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
- [Desktop Duplication API](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/desktop-duplication-api)

### Web 与移动观看端

观看端不需要屏幕捕获权限，做成响应式 Web 页面比绑定桌面客户端更符合本项目的便利性目标。首版至少要实测当前 Android Chrome 和 iOS Safari，并处理：

- Web Crypto Level 2 将 `crypto.randomUUID()` 限定在安全上下文，但没有这样限制 `crypto.getRandomValues()`。因此，通过 `http://<lan-ip>` 打开的局域网观看端不能在启动阶段依赖 `randomUUID()`，可改用 `getRandomValues()` 编码 128-bit 不透明标识。该例外只支持本地观看，并不放宽分享端或生产部署的 HTTPS 要求。([W3C Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/)，访问于 2026-08-18)
- 浏览器自动播放策略：先显示明确的“进入并播放”操作，再启动含声音的媒体。
- `playsinline`、横竖屏切换、全屏和安全区域，避免视频被强制弹出或裁切。
- 页面进入后台、锁屏后恢复，以及 Wi-Fi/蜂窝网络切换导致的 ICE restart。
- 手机解码温度与耗电；观看端只接收单路，不启用不必要的视频处理。
- H.264/VP8 能力协商和降档，不能假设桌面分享者选中的高级 codec 在每部手机上都有高效解码。

### 最小访问模型

当前 access boundary 使用 production 必配的 `SITE_ACCESS_PASSWORD` 无状态 cookie 保护建房、Host role 和所有 code-only Viewer 入口；合法未过期的 exact-room fragment grant 可直接观看。没有 grant 时，服务端先要求 site access，再检查 public-watch 或 private room password；房间码只定位，cookie 也不替代私密房间授权。WebSocket upgrade 仍只做 Origin/容量检查并记录 cookie 状态，首条 `authenticate` 完成上述 role/room 授权。该边界不引入账号、JWT、服务端 session Map 或逐人 ACL。

RFC 3986 的规范事实是 fragment 在 URI dereference 前由 user agent 分离；WHATWG WebSockets 进一步规定含 fragment 的 constructor URL 必须抛 `SyntaxError`。因此把 256-bit room grant 放在 `/r/{code}#v=...`，再由页面在首个 WSS application message 发送，可以使它不进入 HTTP 或 WebSocket request-target。RFC 6750 对 OAuth bearer query 的警告并不直接规定本产品，但它提供了适用的安全类比：URI query 高概率被日志记录，不应承载此 grant。W3C Referrer Policy 的算法会从 referrer URL 移除 fragment，production 的 `no-referrer` header 再禁止整个 header；这是传输边界，不是“不会泄漏”的保证。

W3C TAG 的 capability URL 指南指出 URL 仍会出现在地址栏、历史、扩展、同步服务、截图和转发路径中，建议高熵、到期与可撤销。目标因此使用 Node.js `randomBytes(32)` 的加密强随机量、完整 grant 的 SHA-256 摘要、有限期限，以及 Host rotate 或 locked revoke。浏览器首次严格解析后只写 room-scoped `sessionStorage`，立即 `history.replaceState` 到 canonical URL；刷新和页面内 WSS reconnect 可复用。HTML 标准明确新 auxiliary browsing context 可以复制同源 opener 的 session storage；这是已持有 bearer 的本地浏览器上下文转交边界，不是服务器扩大 room/role 权限，因此不增加导航状态机。独立且无 fragment/room key 的访问只进入中性密码路径，没有正确房间密码仍 fail closed。raw grant 不进入 `localStorage`、cookie、query、Referrer、SQLite、应用/代理日志或错误。OWASP 日志指南也明确把 access token、session identifier 和密码列为通常不应直接记录的数据。Fragment 降低服务端泄漏面，但 possession 仍等于该房间 Viewer 权限。

持久化只在现有 `rooms` row 增加 nullable `viewer_grant_digest`；`NULL` 表示 public-watch，非空值以 `CHECK` 约束为 32-byte BLOB。SQLite `STRICT` table 只接受规定的类型名，因此不能声明 `BLOB(32)`；括号长度也不是 SQLite 的长度约束。官方迁移指南支持在 transaction 中完成 schema/data 变更，目标用一个 `BEGIN IMMEDIATE` 给每个 schema v1 旧行写入未生成对应 grant 的 fresh random locked-private digest，再更新 `user_version`。这是项目设计推论，不是 SQLite 自动提供的权限语义。上线前备份 v1；旧 binary 回滚恢复备份，不在 runtime 保留双 schema。

来源（访问于 2026-08-19）：[RFC 3986 section 3.5](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.5)、[WHATWG WebSockets](https://websockets.spec.whatwg.org/#the-websocket-interface)、[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html)、[RFC 6750 section 2.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.3)、[W3C Referrer Policy](https://www.w3.org/TR/referrer-policy/)、[W3C TAG Capability URLs](https://www.w3.org/TR/capability-urls/)、[HTML Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)、[Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/)、[Node.js Crypto](https://nodejs.org/api/crypto.html)、[SQLite STRICT Tables](https://www.sqlite.org/stricttables.html)、[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html) 与 [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)。

WebRTC 媒体本身使用 DTLS-SRTP 加密，但 direct P2P 仍可能让这组可信好友看到彼此网络地址。若房间政策要求完全隐藏 endpoint IP，ordinary direct/peer 不能满足，应使用明确的中央媒体路径或拒绝该连接；selected-edge TURN 仅是 SFU/UDP 失败后的兼容 transport，不是全房隐私开关。

## 编解码策略

- 所有合规 WebRTC 浏览器必须支持 VP8 和 H.264 Constrained Baseline；VP9/AV1 是能力协商项。
- 游戏场景首版通常优先 H.264，因为硬件编码覆盖广；保留 VP8 回退。
- 不要仅凭 codec 名称判断性能。通过 `RTCRtpSender.getCapabilities()` 协商，通过统计确认 `encoderImplementation`、`powerEfficientEncoder`、`totalEncodeTime/framesEncoded` 和 `qualityLimitationReason`。
- 软件 VP9/AV1 可能抢占游戏 CPU；只有端点支持且实测硬件高效时才启用。
- Simulcast/SVC 主要帮助 SFU 按观看者网络选择层。它们不会消除 P2P fan-out 的 `N * B` 上行，还可能增加编码实例。

来源：

- [WebRTC codec requirements RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html)
- [WebRTC SVC](https://www.w3.org/TR/webrtc-svc/)
- [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)

## 可观测性与延迟验收

每个 peer connection 至少采集：

- selected candidate pair 和 `candidateType`
- current/available outgoing bitrate
- RTT、jitter、packets lost、NACK/PLI
- frameWidth、frameHeight、framesPerSecond、framesDropped
- `totalEncodeTime / framesEncoded`
- `encoderImplementation`、`powerEfficientEncoder`
- `qualityLimitationReason` 和各原因累计时长
- jitter buffer delay、decode time 和 total packet send delay

`RTCIceCandidateStats.protocol` 是内部候选传输字段；只有本地 relay candidate 的 `relayProtocol` 才能确认本端到 TURN 的实际传输。规范不向远端暴露 `relayProtocol`，所以不能从 `remoteCandidate.protocol` 推断远端 TURN 传输。当前详情以 `P2P`/`SFU fallback` 表示媒体方式，直连只显示实际 `protocol`，relay 先显示 `TURN`，仅本地 relay 再附加 `/UDP` 等实际值；candidate type 单列为候选路径，不为补齐远端字段扩展信令或遥测。W3C Stats 规定远端 candidate `address` 默认可为 `null`，浏览器也可按隐私策略过滤；诊断 UI 因此只读取当前本地 report 中由 media transport、`selectedCandidatePairId`、`localCandidateId`/`remoteCandidateId` 精确关联的地址与端口，缺失就保持未知，不解析 SDP 补值，也不上传、记录或持久化。

WebRTC 标准没有承诺固定毫秒延迟。工程目标必须带网络条件，并使用画面时间码或高速摄像机测量玻璃到玻璃延迟。60 fps 的单帧周期是 16.7 ms，端到端延迟还包含采集等待、编码、单程网络、jitter buffer、解码和显示。

建议目标：受控 direct/RTT <= 40 ms/丢包 <= 1% 时 p50 <= 150 ms、p95 <= 250 ms；区域 SFU/UDP root p95 <= 350 ms，可选 TURN 单独测量。先测量，再决定原生优化。

## 安全与成本防护

- WebRTC 使用 DTLS-SRTP。TURN 只能看到加密后的媒体包，但仍能看到地址、房间时序和流量元数据。
- P2P 会让房间内双方得知网络地址。熟人首版可以接受，陌生人房间不能默认接受。
- TURN 必须使用短期凭据、速率限制、每用户/房间配额和出口告警，不能提供匿名公共 relay。
- site access password 只控制建房/Host role，不能作为私密观看凭据；private-link 接受 room-scoped grant 或可选逐房间 Viewer 密码，public-watch 的 room code 则明确不提供隐私。这些入口都不改变媒体 fanout/egress 上限。
- raw Viewer grant 与 Host token 等同访问凭据：只保存摘要，禁止日志/遥测/错误/Referrer/SQLite 明文。显示名、room-scoped peer 后缀和 IP 诊断均不参与授权。
- 如果未来使用 SFU 且要求服务器看不到内容，再评估 SFrame/WebRTC Encoded Transform 和群组密钥管理。

## 参考代码优先级

| 项目 | 用途 | 许可证与判断 | 重点代码 |
| --- | --- | --- | --- |
| [MiroTalk BRO](https://github.com/miroslavpejic85/mirotalkbro) | 最贴近一人广播、多名观看；可用部署级开关选择 P2P 或 mediasoup SFU | AGPL-3.0。最快验证概念，闭源前只能研究或另购许可 | [broadcast.js](https://github.com/miroslavpejic85/mirotalkbro/blob/main/public/js/broadcast.js)、[server.js](https://github.com/miroslavpejic85/mirotalkbro/blob/main/app/server.js)、[mediasoup handler](https://github.com/miroslavpejic85/mirotalkbro/blob/main/app/mediasoup-handler.js) |
| [Screego](https://github.com/screego/server) | 极简屏幕分享、P2P fan-out、WebSocket 信令、内置 Pion TURN | GPL-3.0。最适合学习轻控制面和按需 TURN | [useRoom.ts](https://github.com/screego/server/blob/master/ui/src/useRoom.ts)、[ws](https://github.com/screego/server/tree/master/ws)、[turn/server.go](https://github.com/screego/server/blob/master/turn/server.go)、[NAT 文档](https://github.com/screego/server/blob/master/docs/nat-traversal.md) |
| [Tailchat Meeting](https://github.com/msgbyte/tailchat-meeting) | React 捕获生命周期与会议产品交互参考 | Apache-2.0，但媒体基于 mediasoup/SFU，不能作为当前 P2P 拓扑底座 | [ScreenShare.ts](https://github.com/msgbyte/tailchat-meeting/blob/master/app/src/features/ScreenShare.ts)、[media.ts](https://github.com/msgbyte/tailchat-meeting/blob/master/packages/sdk/src/client/media.ts) |
| [WebRTC samples](https://github.com/webrtc/samples) | 官方浏览器 API 最小示例 | BSD 风格。用于理解 API，不是产品框架 | [getDisplayMedia](https://github.com/webrtc/samples/tree/gh-pages/src/content/getusermedia/getdisplaymedia)、[peer connection examples](https://github.com/webrtc/samples/tree/gh-pages/src/content/peerconnection) |
| [PeerJS](https://github.com/peers/peerjs) | 快速 P2P 原型与简单信令抽象 | MIT。原型快，但产品最终可能需要直接控制 RTCPeerConnection 和统计 | [PeerJS server](https://github.com/peers/peerjs-server) |
| [coturn](https://github.com/coturn/coturn) | 当前 STUN 服务与未来 selected-edge TURN | BSD-3-Clause。STUN 当前必需，TURN 仅按异常 edge 可选 | [turnserver 文档](https://github.com/coturn/coturn/blob/master/README.turnserver)、[Docker](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md) |
| [Peer Calls](https://github.com/peer-calls/peer-calls) | 同一应用中的 mesh/SFU 双模式 | Apache-2.0；维护速度较慢，适合参考而非首选底座 | [mesh.go](https://github.com/peer-calls/peer-calls/blob/master/server/mesh.go)、[sfu.go](https://github.com/peer-calls/peer-calls/blob/master/server/sfu.go)、[iceauth.go](https://github.com/peer-calls/peer-calls/blob/master/server/iceauth.go) |
| [Broadcast Box](https://github.com/Glimesh/broadcast-box) | 未来专用一对多 SFU，WHIP 推流/WHEP 播放 | MIT。比会议型 SFU 更贴近单路广播 | [Broadcast.tsx](https://github.com/Glimesh/broadcast-box/blob/main/web/src/components/broadcast/Broadcast.tsx)、[simple watcher](https://github.com/Glimesh/broadcast-box/blob/main/examples/simple-watcher.html) |
| [LiveKit](https://github.com/livekit/livekit) | 生产级区域 SFU、SDK、内置 TURN、鉴权 | Apache-2.0。未来需要稳定 SFU 时的首选完整底座 | [屏幕共享](https://docs.livekit.io/transport/media/screenshare/)、[turn.go](https://github.com/livekit/livekit/blob/master/pkg/service/turn.go) |
| [mediasoup](https://github.com/versatica/mediasoup) | 强定制低层 SFU | ISC。自由度高，但房间、信令、鉴权、TURN 和 UI 都需自建 | [mediasoup demo](https://github.com/versatica/mediasoup-demo) |
| [Valve GameNetworkingSockets](https://github.com/ValveSoftware/GameNetworkingSockets) | Photon/Steam 式控制面与 P2P NAT 模型参考，不是媒体引擎 | BSD-3-Clause。其 P2P 文档同样要求信令、ICE/STUN 和 relay fallback | [README_P2P](https://github.com/ValveSoftware/GameNetworkingSockets/blob/master/README_P2P.md)、[test_p2p.cpp](https://github.com/ValveSoftware/GameNetworkingSockets/blob/master/tests/test_p2p.cpp) |

不建议新项目以休眠的 `ion-sfu` 为底座。Janus 和 Galene 均可用，但分别偏底层网关和完整会议系统，不如上述项目贴合当前边界。

## 2026-08-18 实施基线复核

进入 PoC 实现前再次核对当前官方版本和参考代码：

- 本机原 Node 20 已结束维护；当前实现基线改为 Node 24 LTS。Vite 8 要求 Node `^20.19.0 || >=22.12.0`，仓库应通过 `engines`、`.node-version` 和 CI 固定受支持运行时。
- 使用 React + TypeScript 的官方 Vite SPA 模板，不引入 SSR 或全栈框架。生产环境不能使用 `vite preview`，由同一个 Node HTTP 服务提供静态构建、房间 API 与 WebSocket。
- `ws` 只用于服务端，浏览器使用原生 `WebSocket`。小信令禁用 `perMessageDeflate`、收紧 `maxPayload`，并采用官方 ping/pong heartbeat 模式。
- `ws.close()` 默认会等待关闭握手，不能用“升级成功后发送 close frame”实现公网连接硬上限。总连接和未鉴权连接容量应在 `handleUpgrade()` 前检查，超限直接返回 HTTP 503 并销毁底层 socket。
- Node 的 `IncomingMessage.url` 是未经应用路由解析的 request-target，而 WHATWG `URL` 构造器会拒绝部分输入。upgrade handler 必须捕获解析失败并关闭 socket，不能让未鉴权输入抛到 EventEmitter 顶层。
- coturn 使用 `use-auth-secret` 支持的 TURN REST 短期凭据：`base64(HMAC-SHA1(secret, expiry + ":" + subject))`。coturn 不提供 HTTP 凭据接口，必须由已鉴权的应用服务生成。
- WebRTC 会逐条验证 ICE URL，任一坏项都可能使整个 `RTCPeerConnection` 配置失败。启动预检按原始 URI 语法 fail closed，并要求 selected TURN URI 显式声明小写 `transport=udp`；配置形状验证不能替代公网 relay allocation 测试。
- Node `server.listen()` 省略 host 时可能监听未指定 IPv6 地址或 `0.0.0.0`。单机反向代理基线应显式绑定 loopback，容器或可信 LAN 才通过配置选择宽绑定；进程级 HTTP 健康检查不应同步探测 TURN 或其他外部网络。
- 截至本次复核，coturn 应使用 4.17.2 或更新补丁版本；4.17.2 修复了此前补丁版本的 UDP TTL 回归。
- MiroTalk BRO 当前 P2P 模式仍是 broadcaster 对每位 viewer 建独立连接；Screego 也采用独立 session 和 HMAC TURN 凭据。这验证了拓扑，但两者的静态/长时凭据与轻量恢复策略不直接照搬。
- Screego 的分享生命周期保持简单，当前客户端在分享停止时关闭 peers，未提供 `replaceTrack()` 换源路径，且为 GPL-3.0；本项目只借鉴其边界清晰的生命周期，不复制实现。Tailchat Meeting 使用 Apache-2.0，但其媒体生产者生命周期绑定 mediasoup/SFU；只参考捕获状态，不引入与 ADR-0001 冲突的拓扑。

新增来源，访问日期 2026-08-18：

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Vite Getting Started](https://vite.dev/guide/)
- [Vite static deployment](https://vite.dev/guide/static-deploy.html)
- [ws official README](https://github.com/websockets/ws/blob/master/README.md)
- [coturn 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2)
- [coturn turnserver documentation](https://github.com/coturn/coturn/blob/master/README.turnserver)
- [coturn example configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [Node.js 24 `server.listen`](https://nodejs.org/docs/latest-v24.x/api/net.html#serverlistenport-host-backlog-callback)

## 实施难度与预估

以下以一名熟悉 Web/TypeScript、具备基本网络经验的全职工程师为基准，只用于量级判断：

| 阶段 | 难度 | 预估 | 交付物 |
| --- | --- | --- | --- |
| 技术原型 | 低到中 | 3 至 7 个工作日 | Web 选源、逐观看者 P2P、基础信令、STUN/TURN、统计面板 |
| 可给朋友使用的 MVP | 中 | 4 至 8 周 | 私密房间、短期 TURN 凭据、质量档位、断线恢复、音频提示、测试矩阵和部署 |
| 稳定产品化 | 高 | 2 至 4 个月以上 | Electron 分享端、应用音频、硬编诊断、多地区 TURN、遥测、升级/安全/兼容处理 |
| Discord 级跨平台体验 | 很高 | 多人持续工程 | 原生 media engine、多捕获后端、GPU 零复制、广泛硬件与网络优化、SFU/E2EE |

最大的未知不是信令服务，而是浏览器是否在目标 GPU 上复用硬件编码、用户真实 P2P 直连率、香港/内地/海外路由和应用音频需求。第一里程碑应是一个带完整统计的原型和真实朋友网络测试，而不是先设计大规模后端。

## 最终建议

1. 首版坚持 P2P-first，但明确只服务小房间；默认接入上限为八名、可配置 1 至 16，真实 1:8 测量完成前不把它写成性能承诺。
2. Web 先行，目标 Windows Chrome/Edge；把 1080p60 写成 best effort，同时提供降档。
3. 保留当前 STUN-only 应用配置直到 ADR-0005 迁移 gate 通过。旗舰先验证 direct/peer UDP 与 SFU/UDP roots；只有 controller 选中的异常 edge 才在两者失败后以新连接使用短期 authenticated TURN。普通 Web/Native PeerConnection 始终 STUN-only；coturn 只验证 credential 与 expiry，room/edge/revision 必须由应用重验。
4. 观看端优先做成免安装响应式 Web；分享端先 Web 验证，再按捕获/音频实测升级 Electron。
5. 产品代码优先直接使用浏览器 WebRTC API；借鉴 MiroTalk BRO 和 Screego，不在许可证未定前直接 fork GPL/AGPL 代码。
6. 分享端 hard fanout 为二；一至两名 viewer 走直接 P2P，第三名及以后只通过 ADR-0004 的 bounded peer-assisted spike 验证，不得隐藏回退为更多 host 连接。
7. SFU 保持 root-only、可逆且非整房默认；旗舰部署通过 canary 后由 ADR-0005 控制器自动用作中央兜底。peer-assisted 若未通过逐跳重编码负载、延迟、兼容和换父门槛就整体放弃，不通过 encoded custom media、评分器、多树或自研 RTP 来挽救。
