# Verification Status

Last updated: 2026-08-27

This file owns only cross-module physical evidence that still changes how the
current product may be described. [Status](./status.md) owns exact source and
production identity; product modules and ADRs own accepted behavior; tests and
Git own completed implementation evidence.

## Route And Network

Still required on representative public networks:

- direct Host-to-Viewer P2P;
- Peer-fed and SFU-fed Browser relay, including a second-level child;
- Host and Viewer TUN/VPN cases;
- relay-ingress failure with subtree retention;
- disconnect and effective-capacity drain;
- two simultaneous rooms with independent SFU publications;
- measured endpoint upload and server ingress/egress during steady routing and
  make-before-break overlap;
- 20-Viewer queue tail, route depth, resource use, and endurance; and
- all-UDP-blocked bounded failure.

The route model, capacity `C=1..3`, first-frame commit, rollback, SFU admission,
and managed-room lifecycle have automated invariant coverage. That coverage does
not prove target-network quality, latency, or interoperability. See
[ADR-0005](./adr/0005-automatic-hybrid-media-routing.md) and the
[routing contract](./product/routing-transport.md).

## Media Quality

Still required:

- real games at 720p30, 1080p30, and 1080p60 on weaker Hosts;
- actual H.264/VP8 encoder paths and sustained CPU/GPU contention on Windows,
  macOS, and Linux;
- mixed P2P/SFU quality and recovery on heterogeneous public networks;
- screen-audio presence, stereo correctness, weak-network behavior, and A/V
  synchronization after SFU RED was disabled; and
- long-running encode/decode cost, thermals, frame delivery, and resource
  admission at the 20-Viewer bound.

Current controlled Browser evidence supports the H.264/VP8 gate, `motion`
content intent, startup-quality workaround, and LiveKit-owned SFU adaptation.
It does not establish a quality-driven topology trigger. See
[media quality](./product/media-quality.md) and
[realtime quality research](./research/realtime-quality-adaptation.md).

## Browser Lifecycle

Still required on physical Android Chrome and iOS Safari:

- autoplay and user-gesture recovery;
- foreground/background audio;
- foreground video recovery after background or lock;
- page reclamation and BFCache behavior;
- rotation and viewport changes;
- Wi-Fi/cellular migration; and
- survival or controller recovery when the mobile Viewer is a relay.

Desktop Host background/minimized capture also remains unconfirmed under a
current-production real game. Web code cannot promise OS background execution,
page retention, or capture keepalive. See
[presentation and lifecycle](./product/presentation-lifecycle.md) and
[background capture research](./research/browser-background-capture.md).

## Interpretation Rules

- Configuration, unit tests, loopback, and synthetic signaling prove invariants,
  not target-network or device behavior.
- Missing RTCStats fields are unknown, not zero.
- Requested quality values are ceilings; actual sender/receiver stats are truth.
- A page-lifecycle correction is recovery logic, not a keepalive guarantee.
- Expensive evidence remains applicable only while its protocol, component,
  configuration, environment, and acceptance boundary remain materially the
  same.
