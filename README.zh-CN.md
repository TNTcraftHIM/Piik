# Screener

[English](./README.md) | 简体中文

Screener 是面向一位游戏玩家和最多 20 位已获授权好友的私密、低延迟屏幕分享工具。
观看者只需浏览器，无须安装。媒体自动选择路径，优先 P2P，支持有容量限制的浏览器中继和
内置 SFU/UDP 后备路径。Hosted Go 进程统一承载信令、STUN 和已授权的 SFU 媒体。

当前阶段以 Windows Client 和浏览器为验收目标。macOS、Linux 保留源码和构建支持，
实机验收另行进行。[当前状态](./docs/status.md) 区分源码能力、发布准备情况和最近记录的生产部署。

## 使用 Screener Client

拿到相互匹配的 Client 程序包后：

1. 完整解压，保留可执行文件旁的 `runtime` 目录。
2. Windows 运行 `screener-client.exe`，Linux 运行 `./screener-client`，
   macOS 打开 `Screener Client.app`。
3. 选择模式和分享来源，将房间邀请链接发给好友。

Client 使用系统浏览器展示界面，没有内嵌浏览器界面。程序包包含 Go 应用以及原生采集、
公网链接所需的辅助程序，运行时无须安装 Node.js、npm 或 Go。Linux 原生采集依赖系统的
Portal、PipeWire 和 GStreamer，详见 [Client 指南](./cmd/screener-client/README.md)。

- **Local：** 与同一局域网中的设备分享。
- **Public link：** 通过普通邀请链接分享。Cloudflare Quick Tunnel 只承载房间访问和信令，
  媒体仍通过 P2P 传输，不提供 SFU。链接只在本次 Client 运行期间有效，重启会创建新的临时链接，
  Quick Tunnel 不保证持续可用。
- **Site：** 打开已保存的 Screener 站点，并使用正在运行的 Client 进行原生采集或媒体转发。
  站点可以提供 SFU 后备路径。

在来源选择器中选择浏览器、应用窗口或屏幕。原生屏幕音频来自默认系统输出；支持时，
窗口音频来自选中的应用。音频有独立开关。Windows 原生采集提供 VP8、Auto、H264 选项，
其他原生平台目前使用硬件 H.264。

原生节点复用适合直属观看者的编码输出，仅在需要时生成缺少的较低输出。每个节点的持续
向外发送份数有上限，默认两份；不兼容的弱连接可以使用独立的本地编码输出。原生 SFU 发布
复用同一来源。纯浏览器采集和中继仍使用正常的 WebRTC 发送器；编码复用属于原生节点能力。
行为和边界见 [媒体质量](./docs/product/media-quality.md)。

媒体需要可用的 UDP 路径，P2P 不保证任意两个网络都能互通。浏览器或操作系统挂起、网络策略
都可能中断分享。Client 本地站点默认开放，可在启动器中设置可选访问密码；这不会改变已保存
Site 的访问规则。

Chromium 系浏览器无法建立媒体连接时，请查看
[Chromium WebRTC 常见问题](./cmd/screener-client/README.md#chromium-webrtc-connections)。
反馈问题时，以 `--debug` 启动 Client，复现后在终端按 `D` 导出本地诊断 ZIP。
浏览器诊断单独导出，详见 [诊断与导出](./docs/reference/configuration.md#diagnostics)。

## 自行部署

服务器程序包运行 `screener-server`，浏览器资源已嵌入 Go 可执行文件。首次部署、配置及内置
媒体服务的协同切换见 [自托管指南](./docs/operations/self-hosting.md)；匹配的构建产物、
后续更新与恢复见 [部署与恢复](./docs/deployment.md)。文档中的流程不代表已经发布了公开的
GitHub Release 或 Docker 镜像。
[可选容器方案](./docs/operations/self-hosting.md#optional-container) 使用同一套已验证的服务器构建产物。

## 本地开发

需要 Node.js 24、npm 11 和 Go 1.26。

```sh
npm ci
npm run dev
```

在另一个终端启动 Go 服务。以下为 POSIX shell 写法，PowerShell 使用对应的 `$env:` 变量设置：

```sh
PORT=8788 PUBLIC_BASE_URL=http://localhost:8787 go run ./cmd/screener-server
```

打开 `http://localhost:8787`。开发服务器监听 `0.0.0.0`，同一局域网设备可访问
`http://<电脑局域网地址>:8787`；屏幕采集需在 `localhost` 或 HTTPS 上运行。
需要不同邀请地址时，按 [配置参考](./docs/reference/configuration.md) 设置来源和访问规则。
生产环境要求独立的 `SITE_ACCESS_PASSWORD`，实际凭据不要提交到仓库。

```sh
npm run check
npm run check:client
```

## 文档与许可

- [文档地图](./docs/README.md)
- [产品摘要](./docs/project-memory.md)
- [当前工作](./docs/todo.md)
- [贡献流程](./CONTRIBUTING.md)

Screener 自有代码采用 [MIT 许可](./LICENSE)。分发的第三方组件保留各自许可和声明，
详见 [第三方许可](./licenses/README.md)。软件按“现状”提供，不作担保；性能和连通性取决于
使用的设备、浏览器和网络。
