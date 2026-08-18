# P2P 优先游戏屏幕共享调研与可行性评估

- 调研日期：2026-08-18
- 目标场景：一名玩家向少量熟人私密分享，观看者可用手机/桌面浏览器加入，低延迟，尽量不消耗媒体服务器带宽
- 结论状态：可用于原型立项；人数、音频范围和部署地区仍需实测确认

## 结论

这个想法可行，而且非常适合先做 Web MVP。它的定位不是缩小版 Twitch，而是好友之间临时、私密、低延迟的实时窗口。正确的首版不是“完全没有服务器”，而是把系统拆为轻量控制面和 P2P 优先的数据面；分享者可以先用 Web/Electron，观看者应能直接打开手机或桌面浏览器链接：

```text
                         HTTPS / WSS
分享者 <------------ 房间、鉴权、信令 ------------> 观看者
   |                                               |
   +---- ICE + STUN 尝试直接 UDP WebRTC ----------+
   |
   +---- 仅直连失败的观看者 ---- TURN relay -------+

若未来产品范围超出小房间边界，再单独评估区域 SFU；大规模公开分享直接使用现有直播服务。
```

“让画面跑起来”难度不高；“像 Discord/TeamSpeak 一样在不同 GPU、浏览器、NAT、运营商和弱网中都保持清晰、60 fps、低延迟”难度高。建议把产品分层：

- 原型：Web、P2P、STUN、TURN，验证一至三名观看者。
- 可用 MVP：房间鉴权、短期 TURN 凭据、质量降档、ICE restart、统计与 30 分钟稳定性测试。
- 产品化：Electron 分享端、Web/移动观看端、Windows 应用音频、硬件编码诊断和区域化 TURN。
- Discord 级：原生捕获/编码引擎、多个捕获后端、GPU 零复制、进程树音频、广泛兼容与持续遥测，属于长期工程。

## 竞品事实

| 产品 | 已公开的可靠事实 | 对本项目的含义 |
| --- | --- | --- |
| Discord Go Live | 使用 WebRTC，但媒体发往 Discord RTC Worker 后再转发给观看者；官方明确这是为了路由控制和隐藏用户 IP。桌面端有原生 C++ media engine、自研捕获/编码、多后端回退和硬件编码。 | Discord 的稳定性并不是纯 P2P 或纯浏览器免费获得的。它是未来质量上限参考，不是首版拓扑参考。 |
| TeamSpeak 6 | 官方技术回复说明用 WebRTC/ICE 做 P2P 屏幕分享；Windows 在 DX、Windows Game Capture 与传统捕获路径间选择。2026-04 官方称其 `turn.*` 主机实际仅启用 STUN，server-side SFU 仍在开发。 | 与当前目标最接近，也解释了 direct-only/STUN-only 在严格 NAT 下可能出现“同房间部分人能看、部分人不能看”；本项目必须从首版部署 TURN relay。 |
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
- 候选优先级应表达：direct UDP -> TURN/UDP -> TURN/TCP -> TURN/TLS 443。ICE 可能交错或并发进行候选检查，应用不应手写严格串行计时器；TCP/TLS 能穿过更严格的网络，但丢包时可能产生队头阻塞。

不存在适用于所有用户的权威“P2P 直连率”。CGNAT、endpoint-dependent mapping、校园/企业防火墙、移动网络、IPv6 和地区运营商都会改变结果。首版必须通过 `getStats()` 统计自己的 `host/srflx/prflx/relay` 比例，而不是引用未经验证的行业百分比。

### 为什么会“有人能看，有人看不了”

ICE 是按分享者与每一名观看者的网络组合独立选路，而不是整个房间只做一次连接。一个家庭宽带观看者可能成功 UDP 打洞，另一个处于 CGNAT、对称 NAT、校园网、企业代理或蜂窝网络的观看者却没有可用直连候选。因此同一房间天然可能出现不同结果。

解决方式不是强迫所有人走服务器，也不是继续增加 STUN 地址，而是同时提供有效的 TURN 凭据和多种传输：

1. 将 direct UDP 设为最高优先级，成功者保持零媒体服务器路径。
2. 同时提供有效的 TURN/UDP、TURN/TCP 与 `turns` TLS 443 candidates，由 ICE 连通性检查和优先级选择路径。
3. 通过统计确认最终选中的 candidate pair，而不是从应用计时顺序推断路径。
4. 网络切换或候选对失效时执行 ICE restart，超时后重建该 peer connection。
5. 在 UI 和诊断中区分“直连”“服务器中继”“正在恢复”和明确失败原因。

这种混合房间里，一名观看者走 TURN 不会迫使其他观看者也中继。TURN/TLS 443 能显著覆盖严格网络，但仍无法穿过所有认证代理、深度检测或管理员策略，因此产品还需要连接自检和可操作的失败信息，不能承诺 100% 网络可达。

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
| SFU | 约 `B` | `B` 入 + `N * B` 出 | 分享者轻松，但服务器承担全部观看流量 |
| MCU | 约 `B` | 另有解码、合成、重编码 | 本场景没有合成需求，不采用 |

以 `8 Mbps` 的 1080p60 目标流为例：

| 观看者 | 分享者上行 | 每小时分享者发送量 |
| ---: | ---: | ---: |
| 1 | 8 Mbps | 3.6 GB |
| 2 | 16 Mbps | 7.2 GB |
| 3 | 24 Mbps | 10.8 GB |
| 4 | 32 Mbps | 14.4 GB |
| 5 | 40 Mbps | 18.0 GB |

实际高动态 1080p60 可以把首版目标区间设为约 6 至 10 Mbps，因此四名观看者需要约 24 至 40 Mbps 持续上行，再加协议和重传余量。对光纤用户这并非不可行，但不能假设所有用户都具备该条件。

把同一 `MediaStreamTrack` 加到多个 `RTCPeerConnection` 会产生多个独立 `RTCRtpSender`、拥塞控制状态和码率目标。标准不保证跨连接只编码一次；浏览器可能优化，也可能创建多个编码上下文。因此分享端 CPU/GPU 容量必须实测。即使未来原生实现单次编码、多 peer packet fan-out，上行仍然是 `N * B`。

IETF 对 mesh/SFU 的拓扑说明见 [RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html)。

## 推荐的拓扑策略

MVP（也是预期的正常产品形态）：

- 一至三名观看者默认 P2P。
- 当前 PoC 明确拒绝第四名观看者；收集可用上行、实际发送码率、`qualityLimitationReason`、编码耗时和发送队列后，再决定后续版本是否放宽。
- 每条链路独立使用 ICE；只有失败的链路走 TURN。
- 若一开始就有多条 `relay`，应提示服务器带宽正在增加。
- 桌面和手机观看者使用同一个 Web 播放端；分享者不要求朋友安装完整客户端。

本项目不以 SFU 作为正常扩容路径；超过小房间上限时直接建议使用外部直播服务。只有以后改变产品范围时，才根据遥测重新评估房间级 SFU，观察项包括：

- 正常工作负载需要多于三名观看者。
- 第一名或多名观看者已使用 TURN，继续 P2P 会重复占用服务器上行。
- 分享者上行安全余量不足。
- 分享者因 CPU/encoder 限制降质。
- 产品开始要求隐藏好友之间的 IP。

不要在 MVP 做观看者转发树。浏览器对收到的 WebRTC track 再发布可能发生解码/重编码，增加负载、质量损失和一跳延迟；真正的数据包级转发还需要自定义密钥、拥塞、故障切换和原生网络层。

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
parameters.degradationPreference = "maintain-framerate";
await sender.setParameters(parameters);
```

这些参数是偏好或上限，不能绕过浏览器拥塞控制，也不能保证目标码率。

来源：

- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/)
- [W3C RTCRtpSender.replaceTrack](https://www.w3.org/TR/webrtc/#dom-rtcrtpsender-replacetrack)
- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [MediaStreamTrack content hints](https://www.w3.org/TR/mst-content-hint/)
- [RTCRtpSender 参数](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [Chromium capture 架构](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/media/capture/)

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

“私密”首先来自房间鉴权、高熵且过期的邀请、发布/观看权限分离和不录制。WebRTC 媒体本身使用 DTLS-SRTP 加密；但 direct P2P 仍会让这组可信好友看到彼此网络地址，若需要隐藏 IP，必须允许强制 TURN，这会增加服务器带宽。

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

`RTCIceCandidateStats.protocol` 表示 ICE candidate 的 UDP/TCP；只有本地 relay candidate 的 `relayProtocol` 才表示本端到 TURN 的 UDP/TCP/TLS。规范要求远端 candidate 不暴露 `relayProtocol`，所以本端只能确认远端使用 relay，不能从 `remoteCandidate.protocol` 推断其 TURN 传输。首版分别展示 ICE protocol 与本地 TURN protocol，不为补齐远端字段扩展信令或遥测。

WebRTC 标准没有承诺固定毫秒延迟。工程目标必须带网络条件，并使用画面时间码或高速摄像机测量玻璃到玻璃延迟。60 fps 的单帧周期是 16.7 ms，端到端延迟还包含采集等待、编码、单程网络、jitter buffer、解码和显示。

建议原型目标：受控 direct/RTT <= 40 ms/丢包 <= 1% 时 p50 <= 150 ms、p95 <= 250 ms；区域 TURN/UDP p95 <= 350 ms。先测量，再决定是否需要原生或 SFU。

## 安全与成本防护

- WebRTC 使用 DTLS-SRTP。TURN 只能看到加密后的媒体包，但仍能看到地址、房间时序和流量元数据。
- P2P 会让房间内双方得知网络地址。熟人首版可以接受，陌生人房间不能默认接受。
- TURN 必须使用短期凭据、速率限制、每用户/房间配额和出口告警，不能提供匿名公共 relay。
- 房间链接应高熵、可过期；发布和观看权限分离。
- 如果未来使用 SFU 且要求服务器看不到内容，再评估 SFrame/WebRTC Encoded Transform 和群组密钥管理。

## 参考代码优先级

| 项目 | 用途 | 许可证与判断 | 重点代码 |
| --- | --- | --- | --- |
| [MiroTalk BRO](https://github.com/miroslavpejic85/mirotalkbro) | 最贴近一人广播、多名观看；可用部署级开关选择 P2P 或 mediasoup SFU | AGPL-3.0。最快验证概念，闭源前只能研究或另购许可 | [broadcast.js](https://github.com/miroslavpejic85/mirotalkbro/blob/main/public/js/broadcast.js)、[server.js](https://github.com/miroslavpejic85/mirotalkbro/blob/main/app/server.js)、[mediasoup handler](https://github.com/miroslavpejic85/mirotalkbro/blob/main/app/mediasoup-handler.js) |
| [Screego](https://github.com/screego/server) | 极简屏幕分享、P2P fan-out、WebSocket 信令、内置 Pion TURN | GPL-3.0。最适合学习轻控制面和按需 TURN | [useRoom.ts](https://github.com/screego/server/blob/master/ui/src/useRoom.ts)、[ws](https://github.com/screego/server/tree/master/ws)、[turn/server.go](https://github.com/screego/server/blob/master/turn/server.go)、[NAT 文档](https://github.com/screego/server/blob/master/docs/nat-traversal.md) |
| [Tailchat Meeting](https://github.com/msgbyte/tailchat-meeting) | React 捕获生命周期与会议产品交互参考 | Apache-2.0，但媒体基于 mediasoup/SFU，不能作为当前 P2P 拓扑底座 | [ScreenShare.ts](https://github.com/msgbyte/tailchat-meeting/blob/master/app/src/features/ScreenShare.ts)、[media.ts](https://github.com/msgbyte/tailchat-meeting/blob/master/packages/sdk/src/client/media.ts) |
| [WebRTC samples](https://github.com/webrtc/samples) | 官方浏览器 API 最小示例 | BSD 风格。用于理解 API，不是产品框架 | [getDisplayMedia](https://github.com/webrtc/samples/tree/gh-pages/src/content/getusermedia/getdisplaymedia)、[peer connection examples](https://github.com/webrtc/samples/tree/gh-pages/src/content/peerconnection) |
| [PeerJS](https://github.com/peers/peerjs) | 快速 P2P 原型与简单信令抽象 | MIT。原型快，但产品最终可能需要直接控制 RTCPeerConnection 和统计 | [PeerJS server](https://github.com/peers/peerjs-server) |
| [coturn](https://github.com/coturn/coturn) | 生产 STUN/TURN fallback | BSD-3-Clause。P2P-first 必需基础设施 | [turnserver 文档](https://github.com/coturn/coturn/blob/master/README.turnserver)、[Docker](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md) |
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
- RFC 7065/5928 将 `turn` + UDP、`turn` + TCP 和 `turns` + TCP 分别映射到客户端至 TURN 的 UDP、TCP 和 TLS 传输。WebRTC 会逐条验证 ICE URL，任一坏项都可能使整个 PeerConnection 配置失败，因此启动预检先按原始 URI 语法 fail closed，再要求三类目标 URL 显式声明小写 `transport`，且 TLS URL 显式使用 TCP 443；这只能验证配置形状，不能替代公网 relay allocation 测试。
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
- [TURN URI scheme RFC 7065](https://www.rfc-editor.org/rfc/rfc7065.html)
- [TURN TCP/TLS allocations RFC 5928](https://www.rfc-editor.org/rfc/rfc5928.html)
- [Node.js 24 `server.listen`](https://nodejs.org/docs/latest-v24.x/api/net.html#serverlistenport-host-backlog-callback)

## 实施难度与预估

以下以一名熟悉 Web/TypeScript、具备基本网络经验的全职工程师为基准，只用于量级判断：

| 阶段 | 难度 | 预估 | 交付物 |
| --- | --- | --- | --- |
| 技术原型 | 低到中 | 3 至 7 个工作日 | Web 选源、1:3 P2P、基础信令、STUN/TURN、统计面板 |
| 可给朋友使用的 MVP | 中 | 4 至 8 周 | 私密房间、短期 TURN 凭据、质量档位、断线恢复、音频提示、测试矩阵和部署 |
| 稳定产品化 | 高 | 2 至 4 个月以上 | Electron 分享端、应用音频、硬编诊断、多地区 TURN、遥测、升级/安全/兼容处理 |
| Discord 级跨平台体验 | 很高 | 多人持续工程 | 原生 media engine、多捕获后端、GPU 零复制、广泛硬件与网络优化、SFU/E2EE |

最大的未知不是信令服务，而是浏览器是否在目标 GPU 上复用硬件编码、用户真实 P2P 直连率、香港/内地/海外路由和应用音频需求。第一里程碑应是一个带完整统计的原型和真实朋友网络测试，而不是先设计大规模后端。

## 最终建议

1. 首版坚持 P2P-first，但明确只服务小房间，硬上限为三名观看者；测量完成前不开放第四名。
2. Web 先行，目标 Windows Chrome/Edge；把 1080p60 写成 best effort，同时提供降档。
3. 从第一天部署 coturn，并验证 direct、TURN/UDP、TURN/TCP、TURN/TLS 443 以及移动网络切换；这是避免“部分好友永远看不了”的必要条件。
4. 观看端优先做成免安装响应式 Web；分享端先 Web 验证，再按捕获/音频实测升级 Electron。
5. 产品代码优先直接使用浏览器 WebRTC API；借鉴 MiroTalk BRO 和 Screego，不在许可证未定前直接 fork GPL/AGPL 代码。
6. 正常人数超过产品上限时引导使用现有直播服务，不为了假设规模提前搭 SFU；若范围以后改变，首选 Broadcast Box 或 LiveKit，不从零写 SFU。
7. 不做客户端转发树和自定义视频协议；它们会把项目从中等难度推到接近自研 Parsec 的高难度。
