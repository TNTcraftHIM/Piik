# Screener

Screener is a private, low-latency screen-sharing project for one game player and a small group of friends. Its accepted media target is WebRTC P2P-first, with an SFU virtual parent feeding only the necessary roots and optional authenticated TURN for explicitly supported restrictive networks. Roots continue distributing to bounded peer descendants; this is not an always-SFU conferencing design. Viewers should be able to join from a desktop or mobile browser without installing the sender application.

The first measurable Web proof of concept is implemented. A host captures a screen, window, or browser tab and shares a numeric room code. Rooms default to a private fragment invitation whose capability authorizes only one room; a Host may explicitly choose public watching by room code after site access. During a share, the host can change between three ceiling profiles without reopening the source picker: 1080p60 at 8 Mbps, 1080p30 at 5 Mbps, and 720p30 at 3 Mbps. The host can also temporarily pause the picture or switch sources. Rooms are random and temporary by default. A site-access-protected deployment can optionally use SQLite-backed room numbers starting at `1`, reusable links, and a waiting state after sharing stops. Lightweight deployments may keep independent direct WebRTC connections. The flagship deployment enables the all-room controller with bounded peer descendants and LiveKit SFU roots; short-lived TURN may be authorized only for a controller-selected exceptional media edge. The default room capacity is eight viewers and deployments may configure 1 through 16, but that admission limit is not a performance promise.

This is not yet a broadly validated production release. Production runs exact `fd76277b05d491af8840b28f3132b7ff445d3cbe` with the all-room bounded peer/SFU-UDP controller; ordinary peer ICE remains STUN-only, and short-lived TURN is configured only for controller-selected exceptional media edges. Native Windows and Android senders remain source-only and are not production runtimes. Real cross-network SFU/TURN media, game audio, a sustained 1:8 room, mobile browser lifecycle behavior, and latency targets still require the documented manual test matrix.

## Run locally

Node.js 24 and npm 11 are required.

```sh
npm ci
npm run dev
```

Production requires an independent 8-128 byte visible-ASCII `SITE_ACCESS_PASSWORD`. It protects room creation, Host role, and code-only Viewer entry. A valid room-scoped fragment grant enters directly without it; otherwise public-watch needs site access plus the room code, and private code-only entry additionally needs the room password. Local development and tests may leave it empty.

Open `http://localhost:8787`. The server listens on `0.0.0.0` by default so a
phone on the same LAN can load `http://<computer-lan-ip>:8787`. To generate an
invite that the phone can open while the host keeps using secure-context
`localhost` capture, set `PUBLIC_BASE_URL` to that LAN URL and include both
origins in `ALLOWED_ORIGINS`. LAN viewers can join over HTTP; the sharing page
must remain on `localhost` or HTTPS because screen capture requires a secure
context. The local default has no STUN, so cross-network use still requires
HTTPS and the production ICE configuration documented separately.

Production keeps a stopped v1 SQLite backup and restore boundary as documented
in [Deployment](./docs/deployment.md). `SITE_ACCESS_PASSWORD` supplies site access;
valid private fragment grants bypass that gate, while code-only entry requires site access before
public/private room policy is evaluated. The release has no v1 parser, old cookie, or
dual-schema runtime. Ordinary ICE contains only self-hosted STUN. LiveKit serves
normally one or two SFU/UDP roots; the controller may authorize short-lived TURN
only for a selected exceptional media edge. HTTPS/WSS remains TLS/TCP independently.

Run the complete automated validation with:

```sh
npm run check
```

Start here:

- [Requirements](./docs/需求理解.md)
- [WebRTC PoC design](./docs/方案设计.md)
- [Deployment and media transport](./docs/deployment.md)
- [Feasibility research](./docs/research/webrtc-p2p-screen-sharing.md)
- [Current project memory](./docs/project-memory.md)
- [Current status](./docs/status.md)
- [Architecture decision](./docs/adr/0001-p2p-first-media-topology.md)
- [Contributing and Git workflow](./CONTRIBUTING.md)
- [Documentation index](./docs/README.md)
