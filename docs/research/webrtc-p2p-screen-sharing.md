# WebRTC P2P 屏幕共享可行性

- 最后复核：2026-08-27
- 范围：浏览器采集与播放、WebRTC 可达性、一对多成本、移动端、
  codec 和安全边界
- 性质：通用研究证据，不定义任何产品的当前路由或部署状态

## 结论

浏览器可以用 `getDisplayMedia()`、`RTCPeerConnection` 和轻量信令完成
低延迟屏幕共享。P2P 能显著降低中央媒体带宽，适合少量互信观看者；它不等于
无服务器，也不能保证穿过所有 NAT、防火墙或移动网络。

一份可用系统至少仍需要 HTTPS/WSS、房间鉴权、SDP/ICE candidate 交换、STUN、
容量保护和明确失败。无法直连时只能接受不可达，或使用 TURN/SFU 等服务器媒体
路径。浏览器 API 能快速验证需求，但不承诺固定捕获规格、跨连接共享编码、
手机后台执行或原生采集器级性能。

## Browser Capture And Playback

### 捕获合同

- `getDisplayMedia()` 只在安全上下文中可用，并且每次调用都需要瞬态用户激活；
  授权不能持久化，应用也不能用约束静默锁定指定窗口。
- 浏览器可以返回低于请求的尺寸或帧率，屏幕音频也可能缺失。成功后必须读取
  `MediaStreamTrack.getSettings()`，并把音频存在性视为结果而非保证。
- 受保护内容、系统安全桌面、独占全屏、最小化窗口和平台捕获后端会影响结果。
  1080p60 是 best effort，不是 Web API 服务等级。
- `RTCRtpSender.replaceTrack()` 可在无需重新协商时换同类来源；若新轨超出已协商
  envelope 或改变不兼容的媒体属性，浏览器可以拒绝，调用方必须保留旧轨或重建
  该连接。
- `contentHint = "motion"` 可表达高动态游戏内容；`setParameters()` 的码率、帧率
  与 degradation preference 是上限或偏好，不能覆盖拥塞控制。

### 发送与接收

把同一 track 加入多个 `RTCPeerConnection` 会产生独立的 sender、ICE/DTLS、
拥塞控制和反馈状态。标准不保证它们共享编码实例；CPU/GPU 和实际码控必须按目标
浏览器、GPU、分辨率和 fan-out 实测。

Viewer 只需要接收一个 `MediaStream` 并绑定到带 `autoplay playsinline controls` 的
媒体元素。含声音的自动播放可能要求显式手势；应用不能用虚假“已播放”状态掩盖
autoplay rejection 或尚未解码的媒体。

## ICE, NAT And Reachability

WebRTC 不规定信令协议。应用信令只交换会话描述、ICE candidates 和身份；媒体
可在协商后直接流经端点。

- STUN 发现公网映射并产生 server-reflexive candidate，不承载媒体，也不保证
  穿过 endpoint-dependent mapping、CGNAT 或严格防火墙。
- ICE 在一个 exact peer connection 内检查 host、server-reflexive、peer-reflexive
  和 relay candidates，并按优先级 nomination；Trickle ICE 允许候选生成时立即交换。
- TURN 提供 relay candidate 并转发完整媒体。它提高可达性，但不降低 Host 的每
  Viewer 媒体副本数，并给服务器增加每条边的入口与出口流量。
- 网络接口或映射变化可通过 ICE restart 重新收集和检查候选；应用层 timeout 不能
  推断一个尚未尝试的远端节点是否可达。

同一房间中的每一对端点都有独立 NAT 组合，因此可能同时存在成功和失败的 P2P
连接。不存在可移植的“行业直连率”；家庭宽带、蜂窝网络、校园/企业网络、IPv4、
IPv6 和地区运营商必须分别取样。实际路径应由 selected candidate pair 与 transport
stats 确认，而不是从等待时长、IP 文本或客户端自报 NAT 类型推断。

## Bandwidth Conservation

设完整媒体码率为 `B`，Viewer 数量为 `N`，单端点下游上限为 `C`。表中未计 RTP/IP
头、音频、RTX、FEC 和拥塞余量。

| 拓扑 | Host 上行 | 中央媒体流量 | 关键代价 |
| --- | ---: | ---: | --- |
| P2P 星型 | `N * B` | 接近零 | Host sender/编码和上行随 Viewer 线性增长 |
| P2P + TURN | `N * B` | 每条 relay 约 `B` 入 + `B` 出 | 只改善可达性 |
| Peer tree | 最多约 `C * B` | direct edge 接近零 | 全房仍约 `N * B`，浏览器 relay 通常逐跳重编码 |
| SFU | 约 `B` | 约 `B` 入 + `N * B` 出 | Host 轻，服务器出口线性增长 |
| MCU | 约 `B` | 另有集中媒体流量 | 解码、合成和重编码成本最高 |

以 `8 Mbps` 为例，四个星型 Viewer 需要约 `32 Mbps` 持续 Host 上行，并在一小时内
发送约 `14.4 GB`，还未包含重传和协议开销。Peer tree 重新分配这些副本，不会消除
最后一跳的 `N * B` 守恒。原生 shared encoder 可以降低编码次数，但同样不能消除
网络副本。

标准浏览器把收到的远端 track 再发布时，通常从解码后的 raw frames 建立新的 sender
pipeline，增加 CPU、逐跳延迟和 generational loss。Encoded forwarding、striping 或
network coding 属于新的媒体数据面，不是普通 `RTCPeerConnection` 的免费能力。

## Mobile And Viewer Boundaries

- 普通移动浏览器不能被假定为可移植 Host。必须先 feature-detect
  `navigator.mediaDevices?.getDisplayMedia`，再以真实调用结果为准；桌面模式或 UA
  不能创造平台未提供的 capture API。
- Android Chrome 和 iOS Safari 可作为普通 Viewer，但首次含声音播放、全屏、旋转、
  安全区和原生 controls 必须真机验证。
- Page Visibility 只报告可见性。后台、锁屏、页面 freeze/discard、WebContent 回收和
  OS 内存压力可暂停视频合成、JavaScript、网络或整个页面，网页不能承诺后台转发。
- 页面恢复时应重新证明当前媒体进展；隐藏期间没有回调不等于网络或 route 已失败。
- Wi-Fi/蜂窝迁移可能改变 candidate pair，需要依赖 WebRTC reconnect/ICE restart，
  不能按设备类型硬编码恢复路径。
- Remote Playback 规范没有给 `MediaStream/srcObject` 一个跨浏览器的电视输出合同；
  URL 型 flinging、系统镜像和 live stream 投放是不同能力。

## Codec And Quality

RFC 7742 要求 WebRTC 浏览器支持 VP8 和 H.264 Constrained Baseline 互通，但 codec 名称
不证明特定硬件 encoder/decoder、稳定帧率或低 CPU。VP9、AV1、HEVC 和硬件路径必须按
目标端点实际协商与统计验证。

可用证据包括实际 codec/profile、`framesEncoded/framesDecoded`、bitrate、resolution、
`totalEncodeTime`、`qualityLimitationReason`、implementation 和 power-efficiency 字段。
这些字段也可能缺失，缺失时保持 unknown。Simulcast/SVC 能让 SFU 选择 representation，
但不会消除 P2P 的多 sender 上行，并可能增加编码负载。

## Security Boundary

- WebRTC media 使用 DTLS-SRTP；信令仍需独立 HTTPS/WSS、Origin 校验、鉴权、消息与
  资源上限。
- Direct P2P 会向对端网络栈暴露可达地址。mDNS candidate 或 stats filtering 不构成
  完整的 endpoint-IP 隐藏合同；需要隐藏 IP 时必须使用中央 relay 或拒绝 direct。
- TURN/SFU 能看到流量元数据；普通 SFU 还终止两侧媒体安全会话。要防 media operator
  读取内容，需要另行设计端到端加密、密钥分发、成员变更和丢包恢复。
- 房间 grant 与 Host token 是 bearer credentials：使用高熵随机值、有限授权、明确
  撤销与过期，并避免出现在 query、日志、遥测、错误、Referrer 或持久明文存储。
- URL fragment 不进入 HTTP request-target，但仍会出现在地址栏、历史、扩展、截图和
  用户转发中；它缩小服务端泄漏面，不改变 possession 即权限的事实。

## Evidence Gates

在宣称可用前，应在目标设备与真实网络上分别证明：capture settings、首帧时间、
selected pair、RTT/loss/jitter、发送与接收码率、编码/解码 cadence、CPU/GPU、后台恢复、
网络迁移和失败终态。Loopback 能验证状态机，不代表 NAT、移动生命周期或公网质量。

以下结论不能由浏览器 API 名称推出：所有网络可达、固定 1080p60、跨连接单次编码、
移动 Host、后台 relay、无线投屏、硬件 codec 或应用 E2EE。

## Primary Sources

- [Screen Capture](https://www.w3.org/TR/screen-capture/),
  [WebRTC](https://www.w3.org/TR/webrtc/),
  [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/), and
  [MediaStreamTrack Content Hints](https://www.w3.org/TR/mst-content-hint/).
- [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html),
  [Trickle ICE, RFC 8838](https://www.rfc-editor.org/rfc/rfc8838.html),
  [WebRTC transport, RFC 8835](https://www.rfc-editor.org/rfc/rfc8835.html), and
  [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html).
- [RTP topologies, RFC 7667](https://www.rfc-editor.org/rfc/rfc7667.html) and
  [WebRTC video codecs, RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html).
- [Page Visibility](https://www.w3.org/TR/page-visibility-2/),
  [HTML media elements](https://html.spec.whatwg.org/multipage/media.html),
  [Remote Playback](https://www.w3.org/TR/remote-playback/), and
  [Web Cryptography](https://www.w3.org/TR/WebCryptoAPI/).
- [URI fragments, RFC 3986 section 3.5](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.5),
  [WebSocket URL rules](https://websockets.spec.whatwg.org/), and
  [Capability URLs](https://www.w3.org/TR/capability-urls/).
- [Chromium capture architecture](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/media/capture/),
  [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
  and [Android process lifecycle](https://developer.android.com/guide/components/activities/process-lifecycle).
