# Piik App

[English](./README.md) · 简体中文 · [上手指南](../../docs/guide/getting-started.zh-CN.md)

Piik App 通过系统浏览器中的 Piik 网页界面，提供本地房间与原生屏幕采集。

## 运行程序包

完整解压对应平台的程序包，保留 App 程序旁的 `runtime` 目录。
Windows 运行 `piik-app.exe`，Linux 运行 `./piik-app`，macOS 打开 `Piik App.app`。
启动页会在系统浏览器中打开。Linux 原生采集所需的系统依赖见
[Linux 采集指南](../../native/capture/linux/README.md)。

网页没有自动打开时，可手动打开终端中显示的地址，或在终端按 **O** 重试。
使用网页期间，请保持 App 运行。

目前主要测试 Windows 版 Piik App 和浏览器分享。macOS 与 Linux 版 Piik App 尚未经过实机测试，
欢迎试用并[反馈结果](https://github.com/TNTcraftHIM/Piik/issues)。macOS 原生采集需要
Apple 芯片及 macOS 13 或更新版本。构建程序包与公开发布 Release 是两个独立步骤，
详见[部署与发布](../../docs/deployment.md)。

## 运行模式

- 不传模式参数时，App 在系统浏览器中打开启动页。选择本地房间、临时公网 HTTPS 邀请
  或已保存的站点后，进入通常的房主页面。
- 启动页会记住上次点击 **进入 Piik** 确认的模式，以及保存的站点地址。
  没有已保存的模式时，有站点地址就默认选中站点，否则选中公网邀请；确认后才启动。
  模式偏好保存在配置旁的 `client.json.mode` 中；保存项与自定义路径见
  [App 配置](../../docs/standards/configuration.md#piik-app-configuration)。
- `--site`、`--local` 和 `--link` 用于在 CI 或开发时直接选择模式。
- 默认启动页打开后会检查官方发布，优先使用 GitHub，GitHub 不可用时使用 Gitee。
  有对应平台的 ZIP 时直接打开下载地址，否则打开发布页。App 不会自行安装或替换程序。

本地房间仅在本次 App 运行期间有效，适用于设备间可互相访问的局域网。
**公网邀请** 通过程序包中的 Cloudflare Tunnel 辅助程序，为同一个房间服务提供临时 HTTPS 地址。
画面和声音在参与者之间传输（P2P），不经过隧道。这两种模式都需要可用的 UDP 媒体路径，
没有媒体服务器转发（SFU）或 TURN 中继兜底。连接机制见
[路由参考](../../docs/standards/routing-transport.md)。

本地邀请会自动选择唯一的活动地址或唯一的私有 IPv4 地址。仍有多个可能地址时，
请在启动页选择网卡和 IP。公网邀请和站点模式无需选择局域网地址。
通过 `--local` 跳过启动页时，可用 `--lan-address <address>` 指定地址来解决多地址歧义。
App 会在启动时再次检查所选地址；它只影响本地邀请链接，媒体路径仍由 ICE 独立选择。

站点模式使用所配置站点的房间，以及该站点已启用的 SFU 兜底。
通过 App 打开的站点会记住原生功能的启用选择，之后打开该站点的页面可继续使用正在运行的 App。
没有 App 时仍可使用浏览器采集，详见[进入流程](../../docs/standards/presentation-lifecycle.md#product-surface)。

房主页面提供浏览器采集及可用的原生窗口或屏幕，请明确选择来源。
Windows 原生采集提供 VP8/Auto/H264，Auto 会为本次分享选定一种编码。
macOS 和 Linux 原生采集需要硬件 H264。可选来源与音频支持取决于平台，设置要求见
[Windows](../../native/capture/windows/README.md)、[macOS](../../native/capture/darwin/README.md)
和 [Linux](../../native/capture/linux/README.md) 采集指南。
原生采集使用房主当前的画质设置；编码选择、分享中修改设置与编码复用由
[媒体质量参考](../../docs/standards/media-quality.md)说明，实测边界见
[验证状态](../../docs/verification-status.md)。

App 配置保存可选的本地站点口令。留空表示本地站点开放进入；需要口令时，在启动页填写后再启动。
观众邀请独立授予对应房间的访问权，详见[房间与访问](../../docs/standards/rooms-access.md)。

终端显示当前模式、入口链接与启动状态，语言跟随启动页和已启用 App 的页面。
按 `o` 重新打开浏览器，按 `q` 或 Ctrl+C 结束本地房间，停止本地服务与临时公网链接。
纯文本输出时使用 Ctrl+C。关闭站点标签页后，App 仍会继续运行。
App 在独立 Windows 控制台中启动时，启动或运行错误会保留在窗口中，按 Enter 后退出。
正常关闭、在已有终端中运行、重定向输出或自动化运行时，会直接退出。

临时公网分享时，打开 App 启动页，选择 **公网邀请**，在随后打开的浏览器中创建房间，
发送通常的邀请链接即可。随机的 `trycloudflare.com` 来源仅在本次 App 运行期间有效，
下次启动会创建新链接。Cloudflare Quick Tunnels 不保证持续可用；
需要持久的控制服务或 SFU 兜底时，请使用配置好的站点。

## 问题排查

### Chromium WebRTC 连接

**为什么屏幕采集成功了，媒体连接却失败？**

基于 Chromium 的浏览器可能通过浏览器设置、扩展或管理策略限制 WebRTC UDP。
禁止未经代理的 UDP，甚至会阻止本机浏览器与 App 之间的媒体连接；
采集成功或页面能打开，并不能证明这条独立连接可用。

检查浏览器的 WebRTC/IP 处理策略，以及扩展中的 WebRTC 或 IP 泄露保护设置。
恢复允许 WebRTC UDP 的策略，重新加载 Piik，再确认没有其他扩展或管理策略覆盖该选择。
各浏览器的设置名称与可用选项不同。例如，Vivaldi 提供
**Settings > Privacy and Security > WebRTC IP Handling > Broadcast IP for Best WebRTC Performance**。
修改这项策略可能向 WebRTC 对端暴露网络地址，请不要同时关闭无关保护。

参考 [Chromium 扩展策略 API](https://developer.chrome.com/docs/extensions/reference/api/privacy#property-network)、
[Vivaldi 设置说明](https://help.vivaldi.com/desktop/privacy/privacy-settings/)和
[已核验的策略机制与实际案例](../../docs/research/native-client-lifecycle.md)。

### 诊断

在启动页开启 **诊断启动**，进入 Piik 并复现问题，再在交互终端按 `D` 导出本地 ZIP。
启动页出现前就失败时，使用 `--debug`。导出不会停止分享或上传文件。
浏览器诊断通过主题按钮后的 **诊断** 芯片图标开启：确认重新加载后，使用 **网页报告** 下载。
调查浏览器与 App 配合的问题时，请提供同一次复现的两份报告。
[诊断参考](../../docs/standards/configuration.md#diagnostics)说明日志位置、导出命令、保留规则与隐私边界。

## 开发

Node/npm/Go 版本见[从源码运行](../../docs/README.md#run-from-source)。
程序会内嵌浏览器资源，请先在仓库根目录构建：

```sh
npm ci
npm run build:web
```

Linux 或 macOS：

```sh
go run ./cmd/piik-app
```

Windows 使用固定的可执行文件路径，便于系统防火墙识别：

```powershell
go build -o build/dev/piik-app.exe ./cmd/piik-app
./build/dev/piik-app.exe
```

这些命令只构建 App。体验浏览器采集时，选择 **本地房间** 或配置好的站点。
原生采集和 **公网邀请** 需要各自的辅助程序，可用 `--capture-process` / `--tunnel-process`
指定已构建的程序，或按[打包](#打包)步骤生成完整程序包。

本地与 CI 共用的仓库级检查入口是：

```sh
npm run check:go
```

在 Windows 上，该入口将 App、采集及媒体测试程序写入已忽略的仓库 `build/go-check`
目录，并在下次运行时复用路径，保持系统防火墙识别的可执行文件身份稳定。
这些文件是本地构建输出，不会打包或提交。

检查包括 Go 格式、单元测试、vet，以及禁用 cgo 的 Windows/Linux 交叉构建。
Darwin App 和 peer gate 仅在安装 SDK 的 macOS 上启用 cgo 构建；其他系统会明确报告跳过该平台。
固定版本的媒体依赖在 Darwin 上通过 cgo 调用 Mach API 获取 CPU 统计，
因此 Windows 或 Linux 上的核心检查不能证明 Darwin 构建通过。
检查会编译当前平台的独立采集程序，并验证有界的能力响应。macOS 还会在内存中编码一个硬件 H.264
IDR；Linux 会探测 Portal/PipeWire/GStreamer 适配层。真实采集、GPU 归因、浏览器解码
和公网路径由明确的实机验证负责，不作为依赖环境的单元测试。

App 与托管站点共用 Go 房间服务。浏览器界面通过 App 的本地控制服务协调原生采集，
以及观众接收与中继；即使本机没有可用的原生采集编码器，观众接收与中继仍可使用。
源码职责见[模块地图](../../docs/standards/engineering.md#module-map)和
[接口地图](../../docs/standards/engineering.md#contract-map)。候选打包脚本会检查采集辅助程序
是否匹配 App 的协议。

打包版本会在终端和诊断中报告产品版本与源码 SHA。[版本规则](../../docs/standards/versioning.md)
说明构建身份与更新提示，[GitHub 运维](../../docs/operations/github.md)说明自动发布。

## 打包

从干净的源码版本开始，构建应用发布产物，再在目标平台的操作系统上运行候选打包脚本。
脚本会构建采集程序、验证固定版本的公网链接辅助程序，并组装和检查 App：

```sh
node scripts/package-server-release.mjs /outside/repository/app-release
node scripts/package-app-candidate.mjs /outside/repository/app-release windows-amd64 /outside/repository/app-candidate
```

支持的目标为 `windows-amd64`、`linux-amd64` 和 `darwin-arm64`，请替换命令中的目标名称。
Darwin 组装需要原生 macOS runner 与 SDK，并启用 cgo；Windows 与 Linux 组装禁用 cgo。
结果是 ZIP 程序包和 SHA-256 文件。手动组装辅助程序、显式 CI 打包、Release 发布与更新，
见[部署与发布](../../docs/deployment.md)；创建候选包不会将它发布。

解压后的目录包含：

```text
piik-app[.exe]
REVISION
LICENSE
THIRD-PARTY-NOTICES.txt
runtime/native/piik-capture[.exe] # 支持原生媒体的程序包
runtime/tunnel/cloudflared[.exe] # 支持 --link 的程序包
```

App 内嵌所用应用发布产物的浏览器资源，程序内的完整 Git 版本与包内 `REVISION` 一致。
App 与站点之间的互操作遵循[公开兼容规则](../../docs/standards/versioning.md#public-compatibility-promise)。

Windows App 通过 `cmd/piik-app/piik_windows_amd64.syso` 资源内嵌共享的 Piik 标识；
平台后缀使该 Windows 资源不参与 Linux 和 macOS 构建。
Linux 程序包包含标准的 `share/applications` 桌面入口与 hicolor 图标。
macOS 程序包包含一个带 ICNS 资源的轻量 `Piik App.app` 启动器，原始 Go 程序仍保留在它旁边。

执行原生房主冒烟检查时，启动 App，在房主页面选择一个窗口，再用另一台设备打开邀请。
按[运行模式](#运行模式)说明选择适合该网络的模式。

## 验证入口

Local gate 会启动已打包进程，在 Chromium 中加载真实构建的页面，验证启动访问与局域网
邀请构造，并检查进程和浏览器配置的完整清理。loopback gate 分别验证授予和未授予
Chromium Local Network Access 权限时的站点访问。以下环境变量语法用于 POSIX shell；
Windows 请使用等效的环境变量设置方式。

```sh
PIIK_CLIENT_LOCAL_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_EXE=/path/to/piik-app \
PIIK_CLIENT_GATE_LAN_ADDRESS=192.168.1.10 \
npm run gate:app-local

PIIK_CLIENT_LOOPBACK_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_EXE=/path/to/piik-app \
npm run probe:app-loopback

PIIK_CLIENT_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:app-media

PIIK_CLIENT_NATIVE_HOST_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
npm run gate:app-native-host

PIIK_CLIENT_NATIVE_HOST_GATE=true \
PIIK_CLIENT_CROSS_NAT_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
PIIK_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:app-native-host

PIIK_CLIENT_NATIVE_HOST_GATE=true \
PIIK_CLIENT_LINK_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
PIIK_GO=/path/to/go \
PIIK_CLOUDFLARED=/path/to/cloudflared \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
npm run gate:app-native-host

PIIK_CLIENT_LINK_GATE=true \
PIIK_GO=/path/to/go \
PIIK_CLOUDFLARED=/path/to/cloudflared \
PIIK_REMOTE_HOST=<public-test-host> \
PIIK_REMOTE_USER=<ssh-user> \
PIIK_REMOTE_SSH_KEY=/path/to/key \
npm run gate:app-link
```

Windows media gate 验证一个硬件 H.264 采集代次、共享 Pion 来源、浏览器解码、PLI 恢复和
STUN 候选收集。native Host gate 验证房间创建及当前路由上的原生视频传输；
能力探测与目标系统支持时，也包含原生音频。

跨 NAT 变体仅将临时反向 SSH 路径用于信令，并要求选中的媒体候选对包含 `srflx` 或 `prflx`；
媒体不会经过 SSH。公网邀请媒体变体通过 App 临时公网来源传送相同信令，
并要求将媒体直接传给独立的 Linux 对端。原生 P2P 质量证据与内嵌 SFU 传输有各自的验证入口。
macOS 和 Linux 采集仍需实机桌面与媒体验证，CI 编译及程序包冒烟检查不能替代这些验证。
