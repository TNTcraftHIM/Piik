# Screener

Screener is a private, low-latency screen-sharing tool for one game player and
up to 20 authenticated friends. Web Viewers need no installation. Media is
automatic and P2P-first, with bounded Browser relay and one dedicated LiveKit
SFU/UDP fallback rather than an always-SFU conference topology.

[Project memory](./docs/project-memory.md) is the compact product map.
[Current status](./docs/status.md) owns the exact source and production state;
this README intentionally does not mirror release details.

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
