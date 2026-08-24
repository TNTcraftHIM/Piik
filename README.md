# Screener

Screener is a private, low-latency screen-sharing project for one game player and a small group of friends. Its accepted media target is WebRTC P2P-first, with a dedicated LiveKit SFU/UDP virtual parent feeding only the necessary roots when direct/STUN peer paths cannot serve them. Roots continue distributing to bounded peer descendants; this is not an always-SFU conferencing design. Viewers should be able to join from a desktop or mobile browser without installing the sender application.

The first measurable Web proof of concept is implemented. A host captures a screen, window, or browser tab and shares a random four-digit room code plus an independent fragment invitation. During a share, the host can change between three ceiling profiles without reopening the source picker, pause, and switch sources. Browser video is fixed VP8 and leaves the video content hint unset. Code-only entry defaults to `open` after site access; the only other state is `private`, which is invitation-only without a room password and also permits matching code-and-password entry when one is configured. A valid grant enters directly in either state. Rooms are process-memory state with a configurable dormant lease and disappear on restart. Lightweight deployments may keep independent direct WebRTC connections. The flagship deployment enables the all-room controller with bounded peer descendants and one LiveKit Host publication serving admitted Viewer subscriptions. Production admits 20 viewers; that admission limit is not a performance promise.

This is not yet a broadly validated product release; [Current status](./docs/status.md) owns the deployed revision and validation evidence. The deployed flagship boundary is the all-room bounded peer/SFU-UDP controller plus the memory-resident room/access model on `screener-v12`, with ordinary peer ICE kept STUN-only and no TURN or TCP media route. The optional Windows native sender remains source-only and is not a production runtime. Mobile devices are Web viewers only; ordinary Android and iOS browsers do not expose reliable screen capture for a Web Host. Real cross-network SFU media, game audio, a sustained public-network 1:20 session, mobile browser lifecycle behavior, and latency targets still require the documented manual test matrix.

## Run locally

Node.js 24 and npm 11 are required.

```sh
npm ci
npm run dev
```

Production requires an independent 8-128 byte visible-ASCII `SITE_ACCESS_PASSWORD`. It protects room creation, Host role, and code-only Viewer entry. A valid room-scoped fragment grant enters directly without it; otherwise code-only entry needs site access before the room's `open | private` policy is evaluated. Local development and tests may leave it empty.

Open `http://localhost:8787`. The server listens on `0.0.0.0` by default so a
phone on the same LAN can load `http://<computer-lan-ip>:8787`. To generate an
invite that the phone can open while the host keeps using secure-context
`localhost` capture, set `PUBLIC_BASE_URL` to that LAN URL and include both
origins in `ALLOWED_ORIGINS`. LAN viewers can join over HTTP; the sharing page
must remain on `localhost` or HTTPS because screen capture requires a secure
context. The local default has no STUN, so cross-network use still requires
HTTPS and the production ICE configuration documented separately.

`SITE_ACCESS_PASSWORD` supplies site access; valid room fragment grants bypass
that gate only for the exact Viewer role, while code-only entry requires site
access before code policy is evaluated. Ordinary ICE contains only self-hosted
STUN. LiveKit supplies bounded SFU/UDP subscriptions when direct/peer paths
cannot serve an edge; Screener configures no TURN or TCP media route. HTTPS/WSS
remains TLS/TCP independently.

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
