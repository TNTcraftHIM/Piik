# Screener

Screener is a private, low-latency screen-sharing tool for one game player and
up to 20 authenticated friends. Web Viewers need no installation. Media is
automatic and P2P-first, with bounded Browser relay and one dedicated LiveKit
SFU/UDP fallback rather than an always-SFU conference topology.

[Project memory](./docs/project-memory.md) is the compact product map.
[Current status](./docs/status.md) owns the exact source and production state;
this README intentionally does not mirror release details.

## Screener Client

The Client opens the same interface in your system browser. The Windows package
includes its runtime; you do not need to install Node.js separately.

- **Local:** share with devices on the same LAN.
- **Public link:** send an ordinary invitation link. Cloudflare Quick Tunnel
  carries room access and signaling; media travels between peers without an SFU.
- **Site:** open a saved Screener server and use the running Client for native
  capture or compatible media forwarding. The Site can provide its SFU fallback.

Choose Browser, application/window, or screen in the source picker. Native
screen audio uses the default system output; window audio uses the selected
application when supported. Audio has a separate sharing switch. Native capture
on Windows offers VP8, Auto, and H264 in the same controls as Browser capture.
Other native platform adapters currently use hardware H.264.

P2P is best effort, not a guarantee that every network pair connects. The
[current status](./docs/status.md) lists platform acceptance and open Client
issues. Client access is open by default; its launcher can set an optional
site-access password. This does not change access rules on a saved Site.

## Local Development

Node.js 24 and npm 11 are required.

```sh
npm ci
npm run dev
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
