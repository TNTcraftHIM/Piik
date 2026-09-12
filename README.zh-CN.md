<p align="center"><img src="./public/favicon.svg" width="64" height="64" alt="Piik 吉祥物"></p>
<h1 align="center">Piik</h1>
<p align="center"><strong>来，给你看个好东西。</strong><br>私密屏幕共享，叫上最多 20 位朋友一起看。</p>
<p align="center">
  <a href="https://piik.tv">官网</a> ·
  <a href="https://github.com/TNTcraftHIM/Piik/releases">下载</a> ·
  <a href="https://gitee.com/TNTcraftHIM/Piik/releases">Gitee 镜像</a> ·
  <a href="https://demo.piik.tv">在线演示</a> ·
  <a href="./docs/README.md">文档</a>
</p>
<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-36564f?style=flat-square" alt="MIT 许可"></a>
  <img src="https://img.shields.io/badge/viewers-up_to_20-36564f?style=flat-square" alt="最多 20 位观众">
  <img src="https://img.shields.io/badge/media-P2P_first-36564f?style=flat-square" alt="优先使用 P2P 连接">
</p>
<p align="center"><a href="./README.md">English</a> · 简体中文</p>

打游戏、画画、折腾新玩意儿。开个房间，把邀请发给朋友，
对方用浏览器就能围观。

<details open>
<summary>客厅小剧场 · 展开 / 收起动画</summary>

<p align="center"><img src="./site/assets/living-room.svg" width="720" height="472" alt="戴着小金冠的房主操纵游戏里的小电视在浮岛间跳跃，朋友们坐在沙发上围观。"></p>

</details>

[功能](#功能) · [开始使用](#开始使用) · [自行部署](#自行部署) · [参与贡献](#参与贡献)

## 功能

- **观看无须安装。** 朋友通过邀请链接，用电脑或手机浏览器加入。
- **浏览器和客户端都能分享。** 支持屏幕、窗口和浏览器标签页；可选来源与音频能力取决于平台。
- **优先 P2P 连接。** 画面优先在参与者之间传输，自建站点可启用 SFU 自动兜底。
- **房间由你管理。** 支持邀请链接、房间号和可选口令，一位房主、最多 20 位观众。
- **一起看，也各自方便。** 深浅主题、播放控制、画中画，以及能展开查看的连接拓扑。
- **一个程序就能建站。** 网页、信令、STUN 和可选的媒体转发集成在同一个 Go 进程中。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/room-zh-dark.png">
    <img src="./docs/assets/room-zh-light.png" width="860" alt="Piik 房间：共享的游戏画面、播放控件和坐在沙发上的朋友，房主戴着小金冠。">
  </picture><br>
  <sub>界面预览 · 示例房间与生成的游戏画面</sub>
</p>

## 开始使用

**来当观众：** 打开朋友发来的邀请链接。画面没有自动播放时，点一下**播放**即可，无须安装客户端。

**想分享画面：**

<p align="center"><img src="./docs/assets/quickstart.svg" width="640" alt="选择画面，发送邀请，一起观看。"></p>

1. 打开一个 Piik 站点；也可[下载 Piik App](https://github.com/TNTcraftHIM/Piik/releases)，启动后先选择房间模式。
2. 点击**开始分享**，选择要分享的画面和声音。
3. 复制邀请链接，发给朋友。分享期间保持标签页打开。

Piik 默认使用图示按钮；点击顶部的**中**可显示文字。
客户端提供本地房间、临时公网邀请和连接已有站点三种模式，分享期间需保持 App 运行。

| 客户端程序包 | 适用平台 |
| --- | --- |
| `windows-amd64` | Windows x64 |
| `darwin-arm64` | macOS，Apple 芯片 |
| `linux-amd64` | Linux x64 |

[**完整使用教程 →**](./docs/guide/getting-started.zh-CN.md) · [**打开在线演示 →**](https://demo.piik.tv)

浏览器采集需要 HTTPS 或 `localhost`。目前重点验证 Windows App 和桌面浏览器分享，
macOS/Linux 原生采集仍待实机验收。客户端公网邀请和演示站使用纯 P2P 连接，
在受限网络下可能无法连通。

## 自行部署

Piik Server 是一个内置网页界面的独立程序。
下载 Linux x64 服务端程序包，解压后运行：

```sh
./piik-server
```

打开 `http://localhost:8787` 即可在本机试用。对外提供服务时，
再配置域名、HTTPS 反向代理和 STUN 地址。无须另装数据库或媒体服务器，房间数据保存在 SQLite 中。

[**部署自己的站点 →**](./docs/operations/self-hosting.zh-CN.md) · [配置参考](./docs/reference/configuration.md) · [从源码运行](./docs/README.md#run-from-source)

## 参与贡献

欢迎提交问题、改进文档或参与开发。
修改前请阅读[贡献指南](./CONTRIBUTING.md)，也可以从
[项目目录说明](./docs/reference/engineering.md#repository-layout)了解代码结构。

## 许可

Piik 自有代码采用 [MIT 许可](./LICENSE)，依赖保留各自的[许可与声明](./licenses/README.md)。
