# Screener

Screener is a private, low-latency screen-sharing project for one game player and a small group of friends. Its media path is WebRTC P2P-first, with authenticated TURN fallback for network pairs that cannot connect directly. Viewers should be able to join from a desktop or mobile browser without installing the sender application.

The first measurable Web proof of concept is implemented. A host captures a screen, window, or browser tab and creates an expiring invitation for up to three viewers. The host can change the shared source without replacing healthy peer connections. Each viewer receives an independent WebRTC connection, so direct and TURN-relayed paths can coexist in one room. The Node.js service carries only room, authentication, ICE credential, and signaling traffic.

This is not yet a production release. Real cross-network TURN behavior, game audio, mobile browser lifecycle behavior, and latency targets still require the documented manual test matrix.

## Run locally

Node.js 24 and npm 11 are required.

```sh
npm ci
npm run dev
```

Open `http://localhost:8787`. The server listens on `0.0.0.0` by default so a
phone on the same LAN can load `http://<computer-lan-ip>:8787`. To generate an
invite that the phone can open while the host keeps using secure-context
`localhost` capture, set `PUBLIC_BASE_URL` to that LAN URL and include both
origins in `ALLOWED_ORIGINS`. LAN viewers can join over HTTP; the sharing page
must remain on `localhost` or HTTPS because screen capture requires a secure
context. The default has no STUN or TURN, so cross-network use still requires
HTTPS and the production ICE configuration documented separately.

Production startup requires separate TURN/UDP, TURN/TCP, and
TURN/TLS-on-TCP-443 URLs; this is a configuration preflight, not evidence that
the external relay path works.

Run the complete automated validation with:

```sh
npm run check
```

Start here:

- [Requirements](./docs/需求理解.md)
- [WebRTC PoC design](./docs/方案设计.md)
- [Deployment and TURN setup](./docs/deployment.md)
- [Feasibility research](./docs/research/webrtc-p2p-screen-sharing.md)
- [Current project memory](./docs/project-memory.md)
- [Current status](./docs/status.md)
- [Architecture decision](./docs/adr/0001-p2p-first-media-topology.md)
- [Contributing and Git workflow](./CONTRIBUTING.md)
- [Documentation index](./docs/README.md)
