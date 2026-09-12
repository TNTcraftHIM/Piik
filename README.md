<p align="center"><img src="./public/favicon.svg" width="64" height="64" alt="Piik mascot"></p>
<h1 align="center">Piik</h1>
<p align="center"><strong>Good things. Shared.</strong><br>Private screen sharing for you and up to 20 friends.</p>
<p align="center">
  <a href="https://piik.tv">Website</a> ·
  <a href="https://github.com/TNTcraftHIM/Piik/releases">Download</a> ·
  <a href="https://gitee.com/TNTcraftHIM/Piik/releases">Gitee mirror</a> ·
  <a href="https://demo.piik.tv">Try the demo</a> ·
  <a href="./docs/README.md">Documentation</a>
</p>
<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-36564f?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/viewers-up_to_20-36564f?style=flat-square" alt="Up to 20 viewers">
  <img src="https://img.shields.io/badge/media-P2P_first-36564f?style=flat-square" alt="P2P-first media">
</p>
<p align="center">English · <a href="./README.zh-CN.md">简体中文</a></p>

Share a game, a drawing or something you just found. Open a room, send an
invitation, and your friends can watch in their browsers.

<details open>
<summary>A little room · Show / hide animation</summary>

<p align="center"><img src="./site/assets/living-room.svg" width="720" height="472" alt="A host with a little gold crown plays a television's island-hopping game while friends watch from the sofa."></p>

</details>

[Features](#features) · [Get started](#get-started) · [Self-hosting](#self-hosting) · [Contributing](#contributing)

## Features

- **Watch without installing.** Friends join by invitation in a desktop or mobile browser.
- **Share from a browser or Piik App.** Capture a screen, window or browser tab; available sources and audio depend on the platform.
- **P2P first.** Media travels between participants where possible. A self-hosted server can provide automatic SFU fallback.
- **Rooms you control.** Invitations, room codes and optional passwords, for one host and up to 20 viewers.
- **A little room for everyone.** Light and dark themes, playback controls, picture-in-picture and a view of the connections behind the picture.
- **A single server binary.** Web UI, signaling, STUN and optional media forwarding in one Go process.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/room-en-dark.png">
    <img src="./docs/assets/room-en-light.png" width="860" alt="Piik room: a shared game, playback controls and friends on a sofa. The host wears a small gold crown.">
  </picture><br>
  <sub>Interface preview · Sample room with a generated game scene</sub>
</p>

## Get started

**To watch:** open the invitation your friend sends you. Select **Play** if the
picture does not start automatically. No App installation is needed.

**To share:**

<p align="center"><img src="./docs/assets/quickstart.svg" width="640" alt="Choose a screen, send an invitation, watch together."></p>

1. Open a Piik site, or [download Piik App](https://github.com/TNTcraftHIM/Piik/releases) and choose a room mode on launch.
2. Select **Start sharing**, then choose the picture and audio to share.
3. Copy the invitation and send it to your friends. Keep the sharing tab open.

Piik uses icon controls by default; select **EN** in the header to show labels.
The App offers a local room, a temporary public link, or a connection to your own
site. Keep the App running while sharing through it.

| App package | Platform |
| --- | --- |
| `windows-amd64` | Windows x64 |
| `darwin-arm64` | macOS, Apple silicon |
| `linux-amd64` | Linux x64 |

[**Full setup guide →**](./docs/guide/getting-started.md) · [**Open the demo →**](https://demo.piik.tv)

Browser capture requires HTTPS or `localhost`. Windows App and desktop browser
sharing are the primary tested paths; macOS/Linux native capture still needs
physical-device acceptance. P2P-only modes, including the App's temporary public
link and the demo, may not connect on restrictive networks.

## Self-hosting

Piik Server is a standalone binary with the web interface built in.
Download the Linux x64 Server package, extract it, and run:

```sh
./piik-server
```

Open `http://localhost:8787` to try it locally. For a public site, configure your
domain, HTTPS reverse proxy and STUN address. No separate database or media server
is required; room data is stored in SQLite.

[**Deploy your own site →**](./docs/operations/self-hosting.md) · [Configuration](./docs/reference/configuration.md) · [Run from source](./docs/README.md#run-from-source)

## Contributing

Bug reports, documentation improvements and pull requests are welcome.
Start with [CONTRIBUTING.md](./CONTRIBUTING.md), or see the
[repository layout](./docs/reference/engineering.md#repository-layout) to find your way around.

## License

Piik-owned code is [MIT licensed](./LICENSE). Dependencies retain their own
[licenses and notices](./licenses/README.md).
