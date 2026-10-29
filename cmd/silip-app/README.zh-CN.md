# Silip App

[English](./README.md) · 简体中文 · [上手指南](../../docs/guide/getting-started.zh-CN.md)

Silip App 通过系统浏览器中的 Silip 网页界面，提供本地房间与原生屏幕采集。

## 运行程序包

安卓 APK 安装与共用的浏览器操作流程见[上手指南](../../docs/guide/getting-started.zh-CN.md#用-silip-app-分享)。
下方程序包、终端与命令行说明适用于桌面 App。

完整解压对应平台的程序包。Windows 和 Linux 保留 App 程序旁的 `runtime` 目录，
分别运行 `silip-app.exe` 或 `./silip-app`。
macOS 打开 `Silip App.app`，也可以将整个 `.app` 移到「应用程序」。
首次打开被拦截时，按 [Mac 打开说明](../../docs/guide/troubleshooting.zh-CN.md#macos-提示已损坏或无法验证开发者)处理。
启动页会在系统浏览器中打开。Linux 原生采集所需的系统依赖见
[Linux 采集指南](../../native/capture/linux/README.md)。

网页没有自动打开时，可手动打开终端中显示的地址，或在终端按 **O** 重试。
使用网页期间，请保持 App 运行。

macOS 原生采集需要 macOS 13 或更新版本。目前主要测试 Windows App 与浏览器分享，
欢迎 macOS/Linux 用户[反馈使用结果](https://github.com/P4-aaaul/Silip/issues)。

## 运行模式

选择 **本地房间** 或 **公网邀请**，点击 **进入 Silip** 启动房间服务。
搭配已有站点使用采集时，保持启动页打开，[授权该站点](#已授权站点)即可。

App 会记住上次确认的房间模式。首次使用默认选中 **公网邀请**，确认后才启动；
有收藏站点时，启动后直接打开该站点。

启动页不检查更新。替换为新版 App 的操作见[升级步骤](#升级)。

### 本地房间

选择 **本地房间**，在设备间可互相访问的局域网中使用。房间仅在本次 App 运行期间有效。

App 自动选择唯一的活动地址或私有 IPv4；有多个地址时，在启动页的 **局域网邀请地址** 中选择。
使用[虚拟局域网](../../docs/guide/network.zh-CN.md#可选虚拟局域网)时，选择对应的虚拟 IPv4。

朋友使用该地址下的 HTTPS 邀请，房主使用本机页面。朋友首次访问时，需与 App 终端核对
[证书指纹](../../docs/guide/troubleshooting.zh-CN.md#本地-https-证书提示)；App 重启后重新确认。

### 公网邀请

选择 **公网邀请**，在打开的浏览器中创建房间，再发送邀请链接。
程序包中的 Cloudflare Tunnel 提供临时 `trycloudflare.com` HTTPS 地址，App 关闭后失效，
下次启动会生成新地址。需要固定地址时，请使用配置好的 Silip 站点。

本地房间和公网邀请的画面、声音通过 P2P 传输，不经过网页隧道；需要可用的 UDP 媒体路径，
没有服务器媒体转发（SFU）或 TURN 中继。隧道或媒体连接失败时，查看
[网络排查](../../docs/guide/network.zh-CN.md)与[公网邀请排查](../../docs/guide/troubleshooting.zh-CN.md#公网邀请创建失败或出现-1033)。

公网邀请使用 Cloudflare、小米和 Bilibili 的 STUN 服务发现可连接地址。
被联系的服务商能看到你的公网 IP、端口和请求时间；这些请求不包含分享画面、声音、
聊天或房间密码。公网邀请可在启动 App 前通过
`SILIP_STUN_URLS` 替换 STUN 服务，示例见 [App 配置](../../docs/standards/configuration.md#silip-app-configuration)。
搭配已授权站点时使用站点的 `STUN_URLS`；App 本地房间不配置公共 STUN。

### 已授权站点

保持 App 运行，点击 Silip 站点顶部的 **App**，在本机确认页核对网址并允许使用。
详细操作见[连接步骤](../../docs/guide/getting-started.zh-CN.md#通过已有站点使用-app)。

启动页会列出已授权站点：

- 点击站点打开，**×** 取消该站点的 App 连接，其他站点与本地房间继续运行。
- **☆** 选择一个下次启动时打开的站点；取消星标可恢复启动页，撤销对应授权也会清除星标。
  授权新站点会保留已有授权。
- 点击站点上已连接的 **App** 按钮可重开启动页，也可使用终端中的 **App 启动页** 地址。

浏览器会记住启用选择；换浏览器、使用无痕窗口或清除站点数据后需重新连接。
新的公网邀请网址需要单独授权。房间与已启用的 SFU 转发仍由站点提供。

## 采集

房主页面提供浏览器、摄像头采集，以及可用的原生窗口或屏幕，请明确选择来源。
Windows 原生采集提供 VP8/Auto/H264，Auto 会为本次分享选定一种编码。
macOS 和 Linux 原生采集需要硬件 H264。可选来源与音频支持取决于平台，设置要求见
[Windows](../../native/capture/windows/README.md)、[macOS](../../native/capture/darwin/README.md)
和 [Linux](../../native/capture/linux/README.md) 采集指南。
原生采集的画质可在[分享设置](../../docs/guide/sharing.zh-CN.md#画面与声音设置)中调整。

Windows App 检测到采集能力支持时，选源器的 **程序 / 窗口** 和 **屏幕** 页会出现
**显示采集边框** 开关，默认关闭。
选取或切换来源时可以修改，本次房主页面会记住选择。
Windows 10、系统策略或其他正在进行的采集可能让黄框保持可见，分享仍可正常进行。
Windows 10 的可选处理方法见[采集边框问题排查](../../docs/guide/troubleshooting.zh-CN.md#windows-分享时出现黄框)。

## 配置与命令行

App 配置保存可选的本地站点口令。留空表示本地站点开放进入；需要口令时，在启动页填写后再启动。
观众邀请独立授予对应房间的访问权，详见[房间与访问](../../docs/standards/rooms-access.md)。

保存的偏好、配置路径与环境变量见
[App 配置](../../docs/standards/configuration.md#silip-app-configuration)。
开发或自动化运行时，可直接指定模式，跳过启动页：

| 参数 | 模式 |
| --- | --- |
| `--local` | 本地房间；有多个可能的局域网地址时，添加 `--lan-address <address>` |
| `--link` | 临时公网邀请 |
| `--site <origin>` | 保存并打开 Silip 站点 |

## 升级

App 与站点需要使用同一大版本，**2.x 与 1.x 不能混用**。
不同 2.x 版本保留已有的分享和观看功能，新功能需要相关 App 与站点支持。

1. 拉取最新源码并重新构建；发布版本后，也可查看 [GitHub](https://github.com/P4-aaaul/Silip/releases/latest) 上的版本说明。
2. 使用本地房间或公网邀请时，停止分享并关闭 App，完整解压新版程序包，重新启动后发送新邀请。
3. 使用已有站点时，由管理员先[更新 Server](../../docs/operations/service-management.zh-CN.md)，
   再更新连接的 App，并刷新所有分享与观看页面。

重启 App 或 Server 会中断当前分享。

## 终端与关闭

终端显示当前模式、入口链接与启动状态，语言跟随启动页和已启用 App 的页面。
按 `o` 重新打开浏览器，按 `q` 或 Ctrl+C 结束本地房间，停止本地服务与临时公网链接。
纯文本输出时使用 Ctrl+C。Linux 桌面入口也会打开此终端。关闭站点标签页后，App 仍会继续运行。
App 在独立 Windows 控制台中启动时，启动或运行错误会保留在窗口中，按 Enter 后退出。
正常关闭、在已有终端中运行、重定向输出或自动化运行时，会直接退出。

## 问题排查

### Chromium WebRTC 连接

浏览器设置、扩展或管理策略可能阻止 WebRTC UDP，包括本机网页与 App 之间的媒体连接。
按文档中心的 [浏览器 WebRTC 排查](../../docs/guide/network.zh-CN.md#浏览器限制了-webrtc)操作。
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
