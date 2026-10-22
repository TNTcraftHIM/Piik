# Piik App

[English](./README.md) · 简体中文 · [上手指南](../../docs/guide/getting-started.zh-CN.md)

Piik App 通过系统浏览器中的 Piik 网页界面，提供本地房间与原生屏幕采集。

## 运行程序包

完整解压对应平台的程序包。Windows 和 Linux 保留 App 程序旁的 `runtime` 目录，
分别运行 `piik-app.exe` 或 `./piik-app`。
macOS 打开 `Piik App.app`，也可以将整个 `.app` 移到「应用程序」。
首次打开被拦截时，按 [Mac 打开说明](../../docs/guide/troubleshooting.zh-CN.md#macos-提示已损坏或无法验证开发者)处理。
启动页会在系统浏览器中打开。Linux 原生采集所需的系统依赖见
[Linux 采集指南](../../native/capture/linux/README.md)。

网页没有自动打开时，可手动打开终端中显示的地址，或在终端按 **O** 重试。
使用网页期间，请保持 App 运行。

目前主要测试 Windows 版 Piik App 和浏览器分享。macOS 与 Linux 版 Piik App 仍需更多实机测试，
欢迎试用并[反馈结果](https://github.com/TNTcraftHIM/Piik/issues)。macOS 原生采集需要
Apple 芯片或 Intel Mac，以及 macOS 13 或更新版本。

## 运行模式

- 不传模式参数时，App 打开启动页，等待已授权站点使用。选择 **本地房间** 或
  **公网邀请**，可在这台设备上启动房间服务，进入通常的房主页面。
  在启动页点亮已授权站点旁的星标，下次就会直接打开该站点；取消星标后恢复启动页。
  取消该站点的授权也会清除它的星标。
- 启动页会记住上次点击 **进入 Piik** 确认的模式。
  没有已保存的本地/公网选择时，默认选中公网邀请；确认后才启动。
- 默认启动页打开后会检查官方发布，优先使用 GitHub，GitHub 不可用时使用 Gitee。
  点击更新按钮下载对应平台的 ZIP，没有匹配包时打开发布页。
  **版本说明** 可单独查看；发现新的大版本时会显示升级提示。App 不会自行安装或替换程序。

### 本地房间

选择 **本地房间**，在设备间可互相访问的局域网中使用。房间仅在本次 App 运行期间有效。

本地邀请会自动选择唯一的活动地址或唯一的私有 IPv4 地址。仍有多个可能地址时，
请在启动页选择网卡和 IP。公网邀请和搭配站点使用时无需选择局域网地址。
App 会在启动时再次检查所选地址；它用于本地 HTTPS 入口和邀请链接，媒体路径仍由 ICE 独立选择。
房主继续使用 HTTP 本机页面；朋友首次打开 HTTPS 邀请时，需与 App 终端核对
[本地证书](../../docs/guide/troubleshooting.zh-CN.md#本地-https-证书提示)。证书只保存在内存中，重启后更换。

### 公网邀请

临时公网分享时，打开 App 启动页，选择 **公网邀请**，在随后打开的浏览器中创建房间，
发送通常的邀请链接即可。随机的 `trycloudflare.com` 来源仅在本次 App 运行期间有效，
下次启动会创建新链接。Cloudflare Quick Tunnels 不保证持续可用；
需要持久的控制服务或 SFU 兜底时，请使用配置好的站点。

公网邀请通过程序包中的 Cloudflare Tunnel 辅助程序，为同一个房间服务提供临时 HTTPS 地址。
画面和声音在参与者之间传输（P2P），不经过隧道。本地房间和公网邀请都需要可用的 UDP 媒体路径，
没有媒体服务器转发（SFU）或 TURN 中继兜底。连接机制见
[路由参考](../../docs/standards/routing-transport.md)。

公网邀请使用 Cloudflare、小米和 Bilibili 的 STUN 服务发现可连接地址。
被联系的服务商能看到你的公网 IP、端口和请求时间；这些请求不包含分享画面、声音、
聊天或房间密码。NAT 增强会自动使用同一组地址。公网邀请可在启动 App 前通过
`PIIK_STUN_URLS` 替换 STUN 服务，示例见 [App 配置](../../docs/standards/configuration.md#piik-app-configuration)。
搭配已授权站点时使用站点的 `STUN_URLS`；App 本地房间不配置公共 STUN。

### 已授权站点

使用 Piik 站点时，保持 App 运行，点击站点顶部的 **App**，在本机确认页核对网址并允许使用。
App 会记住各个已授权站点，可在启动页分别打开或取消授权。取消授权只结束该站点的 App 连接，
其他站点和本地房间不受影响。点击站点上已连接的 **App** 按钮可重开启动页；
站点打不开时，可使用 App 终端中的 **App 启动页** 地址。同一浏览器记住启用选择，
之后访问站点即可继续使用 App，同时使用该站点的房间和已启用的 SFU 兜底。
没有 App 时仍可使用浏览器采集，详见[连接步骤](../../docs/guide/getting-started.zh-CN.md#通过已有站点使用-app)。

## 采集

房主页面提供浏览器、摄像头采集，以及可用的原生窗口或屏幕，请明确选择来源。
Windows 原生采集提供 VP8/Auto/H264，Auto 会为本次分享选定一种编码。
macOS 和 Linux 原生采集需要硬件 H264。可选来源与音频支持取决于平台，设置要求见
[Windows](../../native/capture/windows/README.md)、[macOS](../../native/capture/darwin/README.md)
和 [Linux](../../native/capture/linux/README.md) 采集指南。
原生采集使用房主当前的画质设置；编码选择、分享中修改设置与编码复用由
[媒体质量参考](../../docs/standards/media-quality.md)说明，实测边界见
[验证状态](../../docs/verification-status.md)。

Windows App 检测到采集能力支持时，选源器的 **程序 / 窗口** 和 **屏幕** 页会出现
**显示采集边框** 开关，默认关闭。
选取或切换来源时可以修改，本次房主页面会记住选择。
Windows 10、系统策略或其他正在进行的采集可能让黄框保持可见，分享仍可正常进行。
Windows 10 的可选处理方法见[采集边框问题排查](../../docs/guide/troubleshooting.zh-CN.md#windows-分享时出现黄框)。

## 配置与命令行

App 配置保存可选的本地站点口令。留空表示本地站点开放进入；需要口令时，在启动页填写后再启动。
观众邀请独立授予对应房间的访问权，详见[房间与访问](../../docs/standards/rooms-access.md)。

保存的偏好、配置路径与环境变量见
[App 配置](../../docs/standards/configuration.md#piik-app-configuration)。
开发或自动化运行时，可直接指定模式，跳过启动页：

| 参数 | 模式 |
| --- | --- |
| `--local` | 本地房间；有多个可能的局域网地址时，添加 `--lan-address <address>` |
| `--link` | 临时公网邀请 |
| `--site <origin>` | 保存并打开 Piik 站点 |

## 终端与关闭

终端显示当前模式、入口链接与启动状态，语言跟随启动页和已启用 App 的页面。
按 `o` 重新打开浏览器，按 `q` 或 Ctrl+C 结束本地房间，停止本地服务与临时公网链接。
纯文本输出时使用 Ctrl+C。Linux 桌面入口也会打开此终端。关闭站点标签页后，App 仍会继续运行。
App 在独立 Windows 控制台中启动时，启动或运行错误会保留在窗口中，按 Enter 后退出。
正常关闭、在已有终端中运行、重定向输出或自动化运行时，会直接退出。

## 问题排查

### Chromium WebRTC 连接

**为什么网页能打开、屏幕也能采集，却无法分享或观看？**

浏览器设置、扩展或管理策略可能阻止 WebRTC UDP，包括本机网页与 App 之间的媒体连接。
按文档中心的 [浏览器 WebRTC 排查](../../docs/guide/troubleshooting.zh-CN.md#浏览器限制了-webrtc)操作。
特定编码失败时，另见 [Windows H264 排查](../../docs/guide/troubleshooting.zh-CN.md#windows-上-h264-分享失败)。

### 诊断

在启动房间或连接站点前，先在启动页开启 **诊断启动**，复现问题后在交互终端按 `D` 导出本地 ZIP。
启动页出现前就失败时，使用 `--debug`。导出不会停止分享或上传文件。
浏览器诊断通过主题按钮后的 **帮助 → 诊断** 开启：确认重新加载后，使用 **帮助 → 网页报告** 下载。
调查浏览器与 App 配合的问题时，请提供同一次复现的两份报告。
[诊断参考](../../docs/standards/configuration.md#diagnostics)说明日志位置、导出命令、保留规则与隐私边界。

## 开发者参考

[App 开发指南（英文）](./DEVELOPMENT.md)集中说明源码构建、打包、桌面图标与验证入口。
维护者的 Release 发布流程见[部署与发布（英文）](../../docs/deployment.md)。
