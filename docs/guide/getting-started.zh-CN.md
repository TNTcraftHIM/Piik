# 第一次用 Piik

[English](./getting-started.md) · 简体中文 · [文档中心](./README.zh-CN.md)

- [观看朋友的分享](#加入朋友的房间)
- [用浏览器分享](#用浏览器分享屏幕)或[用 Piik App 分享](#用-piik-app-分享)

## 加入朋友的房间

1. 用手机或电脑的浏览器打开朋友发来的邀请链接。观看无需安装 Piik App，也无需注册。
2. 如果打开链接就看到 **站点口令**，请向朋友索取这个站点的口令。如果房间显示 **输入房间密码**，点击按钮，填入这个房间的密码，再点击 **加入**。朋友发来的是 **免密邀请** 时，打开链接即可进房。
3. 如果朋友的画面上有 **播放** 按钮，点击它。轻点画面或将鼠标移到画面上，可以打开[播放控制栏](./sharing.zh-CN.md#播放控制)。

如果朋友只发了四位房间号，先问对方要 Piik 站点地址。打开该地址，按提示输入 **站点口令**，再点击 **加入房间**，填入四位房间号并点击箭头。如果提示输入房间密码，向朋友索取密码；如果房间只接受邀请，请朋友发完整邀请链接。

![四格房间号输入框及提交房间号的箭头。](../assets/guide/join-code.zh-CN.png#gh-light-mode-only)
![四格房间号输入框及提交房间号的箭头。](../assets/guide/join-code.zh-CN.dark.png#gh-dark-mode-only)

![展开「输入房间密码」后显示密码框和「加入」按钮。](../assets/guide/join-password.zh-CN.png#gh-light-mode-only)
![展开「输入房间密码」后显示密码框和「加入」按钮。](../assets/guide/join-password.zh-CN.dark.png#gh-dark-mode-only)

[加入或观看遇到问题](./troubleshooting.zh-CN.md#常见问题)。

<a id="使用在线版"></a>

## 用浏览器分享屏幕

1. 用浏览器打开 [demo.piik.tv](https://demo.piik.tv)。无需注册或下载就能分享。
2. 点击 **开始分享**。选择 **浏览器** 可以分享屏幕、窗口或标签页，选择 **摄像头** 可以分享镜头画面。选好要分享的画面，如果选择器提供音频选项，可按需开启。
3. 预览出现画面后，在 **准入方式** 里点 **复制**，把邀请链接发给朋友。朋友在旁边时，可以点链接旁的 **二维码** 让对方扫码。
4. 朋友观看时，保持分享标签页打开。结束时点击 **停止分享**。

使用 iPhone 或 iPad 时，请查看 [Safari 屏幕分享说明](./sharing.zh-CN.md#iphone-与-ipad-屏幕分享)。如果无法开始分享，请查看[分享问题排查](./troubleshooting.zh-CN.md#开始分享)。

![上方是「复制」，下方显示示例邀请链接、二维码按钮和「免密邀请」开关。](../assets/guide/invite-copy.zh-CN.png#gh-light-mode-only)
![上方是「复制」，下方显示示例邀请链接、二维码按钮和「免密邀请」开关。](../assets/guide/invite-copy.zh-CN.dark.png#gh-dark-mode-only)

![「邀请二维码」会在小面板里打开。请朋友扫描你的房间里显示的二维码。](../assets/guide/invite-qr.zh-CN.png#gh-light-mode-only)
![「邀请二维码」会在小面板里打开。请朋友扫描你的房间里显示的二维码。](../assets/guide/invite-qr.zh-CN.dark.png#gh-dark-mode-only)

## 用 Piik App 分享

使用 iPhone 或 iPad 时，请在 [Safari 中使用在线版](#用浏览器分享屏幕)。

1. 从 [GitHub Releases](https://github.com/TNTcraftHIM/Piik/releases) 或
   [AtomGit 镜像](https://atomgit.com/TNTcraftHIM/Piik/releases)下载以 **`piik-app`** 开头、
   对应平台的程序包。安卓手机或平板直接安装 APK。
   桌面端完整解压并保留目录结构。
2. Windows 打开 `piik-app.exe`，macOS 打开 `Piik App.app`，Linux 运行 `./piik-app`。
   安卓手机或平板安装后打开 Piik。启动页会在系统浏览器里打开。
3. 邀请不在同一局域网的朋友时，选择 **公网邀请**，再点击 **进入 Piik**。
   其他模式的用途见下方说明。
4. 点击 **开始分享**，按可用选项选择 **浏览器**、**摄像头**、**程序 / 窗口** 或 **屏幕**，
   选好要分享的画面。想让朋友听到声音时，可按需开启声音选项。
5. 点击邀请链接旁的 **复制**，把邀请链接发给朋友。分享期间保持 App 和分享标签页打开。

![App 选源界面：浏览器、摄像头、程序 / 窗口和屏幕四种来源，下方为窗口预览与来源声音开关。](../assets/guide/share-source.zh-CN.png#gh-light-mode-only)
![App 选源界面：浏览器、摄像头、程序 / 窗口和屏幕四种来源，下方为窗口预览与来源声音开关。](../assets/guide/share-source.zh-CN.dark.png#gh-dark-mode-only)

macOS 首次打开被拦截时，按 [Mac 打开说明](./troubleshooting.zh-CN.md#macos-提示已损坏或无法验证开发者)处理。

<details>
<summary>该下载哪个程序包？</summary>

| 文件名包含 | 适用平台 |
| --- | --- |
| `windows-amd64` | Windows x64 |
| `darwin-arm64` | Apple 芯片；原生采集需 macOS 13 及以上 |
| `darwin-amd64` | Intel Mac；原生采集需 macOS 13 及以上 |
| `linux-amd64` | Linux x64 |
| `linux-arm64` | Linux ARM64 |
| `android-universal` | Android 10 及以上；一个 APK 包含 ARM64 和 x64 |

Linux 原生采集还需要[系统组件](../../native/capture/linux/README.md)。
程序包与启动参数的细节见 [App 指南](../../cmd/piik-app/README.zh-CN.md)。

</details>

### 选择 App 模式

![App 模式选择：已选中公网邀请，也可以选择本地房间。](../assets/guide/app-modes.zh-CN.png#gh-light-mode-only)
![App 模式选择：已选中公网邀请，也可以选择本地房间。](../assets/guide/app-modes.zh-CN.dark.png#gh-dark-mode-only)

- **公网邀请：** 给异地朋友发一个临时网页链接。需要互联网连接，关闭 App 后链接失效。
- **本地房间：** 朋友在同一局域网或虚拟局域网，对方需要能连接到你的电脑。
  多网卡时，可展开 **局域网邀请地址**，选择朋友所在的网络。

本地房间和公网邀请可展开 **站点口令** 设置可选的访问口令。
如果浏览器弹出警告，请先向房主确认本地邀请再继续。[如何确认本地邀请](./troubleshooting.zh-CN.md#本地-https-证书提示)

<details>
<summary>回到启动页或更换模式</summary>

房间服务启动后，点击网页右上角已就绪的 **App**，可回到启动页管理授权或重新进入房间；
App 终端也保留 **App 启动页** 地址。更换本地房间／公网邀请模式时，关闭并重新打开 App 后选择。
这会结束原有房间，公网邀请地址也会重新生成。

</details>

### 通过已有站点使用 App

1. 保持 Piik App 运行，在浏览器打开 Piik 站点。如果站点要求口令，先输入口令；
   项目提供的[在线版](https://demo.piik.tv)无需站点口令。App 启动页无需选择房间模式。
2. 点击站点顶部的 **App**。浏览器询问本地网络权限时，请允许访问。
   找到 App 后，点击 **打开 App 页面**。
3. 在本机确认页核对站点网址，点击 **允许使用**。
4. 返回站点，点击 **开始分享**，选择 **程序 / 窗口** 或 **屏幕**，
   选好来源后，将新房间的邀请链接发给朋友。

也可以在 **开始分享** 的选源窗口里点击 **连接 Piik App**，连接后列表会直接显示 App 来源。
连接失败时，App 按钮旁会提供 **重试** 和 **下载 App**；仍可继续使用浏览器分享和观看。

已授权站点与启动收藏可在[App 启动页管理](../../cmd/piik-app/README.zh-CN.md#已授权站点)。
画面连不上时，查看[网络排查指南](./network.zh-CN.md)。

### 版本升级

App 与站点需要使用同一大版本，**2.x 与 1.x 不能混用**。
替换 App 或更新已有站点时，按[升级步骤](../../cmd/piik-app/README.zh-CN.md#升级)操作。

## 使用已有站点分享

使用朋友或管理员提供的 HTTPS Piik 站点。自行搭建时，按[自部署指南](../operations/self-hosting.zh-CN.md)操作。

1. 打开 Piik 站点。如果站点设置了口令，先输入口令。
2. 点击 **开始分享**，选择 **浏览器** 后在浏览器弹窗里选择屏幕、窗口或标签页；
   浏览器支持时，电脑和手机也可选择 **摄像头**。如需来源声音且选择器提供该选项，启用音频。
3. 预览出现画面后，点击邀请链接旁的 **复制**，把邀请链接发给朋友。
4. 保持分享标签页打开。需要时使用 **暂停分享**、**切换来源** 或 **停止分享**。

浏览器屏幕采集需要 HTTPS 站点或 `localhost`。
弹窗里有哪些画面和声音可选，取决于浏览器与操作系统。
拿到邀请链接的人可以进入这个房间，请把它发给你想邀请的人。

想在同一站点使用 App 采集，可按[通过已有站点使用 App](#通过已有站点使用-app)的步骤操作。
站点负责房间与邀请，App 提供原生采集。
如果站点能为无法直连的观众转发画面，房主可在开始分享前关闭 **隐私模式** 来允许转发。

## 接下来可以做什么

- [分享与播放](./sharing.zh-CN.md)：画面设置、摄像头与来源声音。
- [聊天、语音与远程控制](./room-tools.zh-CN.md)：聊天互动，或让朋友接手操作。
- [问题排查](./troubleshooting.zh-CN.md)：按遇到的现象寻找处理步骤。
