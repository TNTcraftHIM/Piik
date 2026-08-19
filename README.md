# Screener

Screener is a private, low-latency screen-sharing project for one game player and a small group of friends. Its accepted media target is WebRTC P2P-first, with an SFU virtual parent feeding only the necessary roots and optional authenticated TURN for explicitly supported restrictive networks. Roots continue distributing to bounded peer descendants; this is not an always-SFU conferencing design. Viewers should be able to join from a desktop or mobile browser without installing the sender application.

The first measurable Web proof of concept is implemented. A host captures a screen, window, or browser tab and shares a numeric room code; friends can open `/r/{code}` directly or enter the code at `/join`, with no separate viewer token. During a share, the host can change between three ceiling profiles without reopening the source picker: 1080p60 at 8 Mbps, 1080p30 at 5 Mbps, and 720p30 at 3 Mbps. The host can also temporarily pause the picture or switch sources. Rooms are random and temporary by default. A password-protected deployment can optionally use SQLite-backed room numbers starting at `1`, reusable links, and a waiting state after sharing stops. Each viewer currently receives an independent WebRTC connection, so direct and TURN-relayed paths can coexist in one room. The default room capacity is eight viewers and deployments may configure 1 through 16, but that admission limit is not a performance promise.

This is not yet a production release. Public TURN/UDP and TURN/TCP relay paths are verified, but real cross-network Screener media, game audio, a sustained 1:8 room, mobile browser lifecycle behavior, and latency targets still require the documented manual test matrix.

## Run locally

Node.js 24 and npm 11 are required.

```sh
npm ci
npm run dev
```

`ACCESS_PASSWORD` is optional. Leaving it empty makes the site public; setting it gates both hosting and viewing behind one site-wide password. Internet deployments intended to stay private should set it, because in public mode the numeric room code is the only viewing capability and does not provide strong privacy by itself.

Open `http://localhost:8787`. The server listens on `0.0.0.0` by default so a
phone on the same LAN can load `http://<computer-lan-ip>:8787`. To generate an
invite that the phone can open while the host keeps using secure-context
`localhost` capture, set `PUBLIC_BASE_URL` to that LAN URL and include both
origins in `ALLOWED_ORIGINS`. LAN viewers can join over HTTP; the sharing page
must remain on `localhost` or HTTPS because screen capture requires a secure
context. The default has no STUN or TURN, so cross-network use still requires
HTTPS and the production ICE configuration documented separately.

The current production release still requires STUN plus separate TURN/UDP and
TURN/TCP URLs. Do not remove them from an existing deployment yet. The accepted
but unimplemented flagship target is direct/peer UDP, then one SFU publication
feeding normally one or two roots, then optional generation-bound TURN only for
a selected exceptional edge, followed by a clear bounded failure. The exact
optional media-TCP/TLS transport and port remain subject to the documented
exact-room canary; HTTPS/WSS continues to use TLS/TCP independently.

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
