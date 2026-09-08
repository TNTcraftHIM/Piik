# Screener

English | [简体中文](./README.zh-CN.md)

Screener is a private, low-latency screen-sharing tool for one game player and
up to 20 authenticated friends. Web Viewers need no installation. Media is
automatic and P2P-first, with bounded Browser relay and one embedded SFU/UDP
fallback. The Hosted Go process owns signaling, STUN, and admitted SFU media.

Windows Client and Browser are the current acceptance targets. macOS and Linux
have source/build support; their physical acceptance is separate. See
[current status](./docs/status.md) for release readiness and the distinction
between current source and the last recorded production deployment.

## Screener Client

For a matching Client bundle:

1. Extract the whole package, keeping its `runtime` directory beside the executable.
2. Run `screener-client.exe` on Windows, `./screener-client` on Linux, or
   `Screener Client.app` on macOS.
3. Choose a mode, select a source, and send the room invitation to your friends.

The Client opens the interface in your system browser; it has no embedded
browser UI. The package carries the Go application and native capture/public-link
helpers. Running the package does not require Node.js, npm, or Go. Linux native
capture uses system Portal/PipeWire/GStreamer dependencies; see the
[Client guide](./cmd/screener-client/README.md).

- **Local:** share with devices on the same LAN.
- **Public link:** send an ordinary invitation link. Cloudflare Quick Tunnel
  carries room access and signaling; media travels between peers without an SFU.
  The link lasts for that Client run. Relaunching creates a new temporary link;
  Quick Tunnel provides no uptime guarantee.
- **Site:** open a saved Screener server and use the running Client for native
  capture or compatible media forwarding. The Site can provide its SFU fallback.

Choose Browser, application/window, or screen in the source picker. Native
screen audio uses the default system output; window audio uses the selected
application when supported. Audio has a separate sharing switch. Native capture
on Windows offers VP8, Auto, and H264 in the same controls as Browser capture.
Other native platform adapters currently use hardware H.264.

Native parents reuse encoded outputs for compatible direct children and derive
a missing lower output only when needed. Each endpoint has a bounded outgoing-copy
capacity, default two; incompatible weak paths can use separate local outputs.
Native SFU publication uses that same source. Ordinary Browser capture and relay
retain WebRTC senders; encoded reuse is a Native capability. See
[media quality](./docs/product/media-quality.md) for the behavior and bounds.

Media requires a working UDP path; P2P does not guarantee connectivity between
every network pair. Browser/OS suspension and network policy can interrupt a
share. Client access is open by default; its launcher can set an optional
site-access password. This does not change access rules on a saved Site.

If a Chromium-based Browser cannot establish media connections, see the
[Chromium WebRTC FAQ](./cmd/screener-client/README.md#chromium-webrtc-connections).

For feedback, start the Client with `--debug`, reproduce the problem, and press
`D` in its terminal to export a local diagnostic ZIP. Browser diagnostics are
separate; see [diagnostics and export](./docs/reference/configuration.md#diagnostics).

## Self-Hosting

The server package runs `screener-server` with the Browser assets embedded in
the binary. Initial setup, configuration and coordinated embedded-media cutover
are documented in [self-hosting](./docs/operations/self-hosting.md).
[Deployment and recovery](./docs/deployment.md) covers matching artifacts and
later application updates. These instructions do not imply that a public
GitHub Release or Docker image has already been published.
An [optional container recipe](./docs/operations/self-hosting.md#optional-container)
uses the same verified Server release.

## Local Development

Node.js 24, npm 11, and Go 1.26 are required.

```sh
npm ci
npm run dev
```

In a second terminal, run the application server that the dev server proxies.
The command below uses POSIX environment syntax; PowerShell uses the corresponding
`$env:` variables.

```sh
PORT=8788 PUBLIC_BASE_URL=http://localhost:8787 go run ./cmd/screener-server
```

Open `http://localhost:8787`. The development server listens on `0.0.0.0`, so a
phone on the same LAN may use `http://<computer-lan-ip>:8787`. Screen capture
must remain on `localhost` or HTTPS. Set `PUBLIC_BASE_URL` and
`ALLOWED_ORIGINS` when generated invitations need a different LAN origin.

Production requires an independent visible-ASCII `SITE_ACCESS_PASSWORD`; local
development and tests may leave it empty. Cross-network setup is documented in
[self-hosting](./docs/operations/self-hosting.md) and
[configuration reference](./docs/reference/configuration.md). Never commit real
credentials.

Run complete automated validation with:

```sh
npm run check
npm run check:client
```

## Documentation

- [Product and repository map](./docs/README.md)
- [Rooms and access](./docs/product/rooms-access.md)
- [Routing and transport](./docs/product/routing-transport.md)
- [Capture and media quality](./docs/product/media-quality.md)
- [Presentation and lifecycle](./docs/product/presentation-lifecycle.md)
- [Current work](./docs/todo.md)
- [Contributing workflow](./CONTRIBUTING.md)

## License

Screener's own code is [MIT licensed](./LICENSE). Redistributed components retain
their own licenses and notices; see [third-party licensing](./licenses/README.md).
The software is provided "AS IS", without warranty; performance and connectivity
depend on the devices, Browsers and networks in use.
