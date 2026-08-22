# Current Verification Status

Last updated: 2026-08-22

## Purpose

This is the demand-loaded ledger for cross-cutting validation evidence and open proof boundaries that do not fit one requirement, ADR, research note, or deployment guide. It is current state, not a release diary: replace superseded facts in place, move durable specialist conclusions to their owning documents, and let Git history retain completed timelines.

## Deployment Evidence

- Production runs exact `aa870c51a57a51166a605c734cbb03263a72d12d`, release `aa870c51a57a`, with `01a77ae331de` retained for rollback.
- Local/public health return 200; `screener`, LiveKit, coturn, and nginx are active; `screener` reports zero restarts. SQLite v3 has five rooms, SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner `screener:screener`, and mode 0600.
- Room admission defaults to eight and accepts explicit limits from one through sixteen. The endpoint-cap environment is unset, so the deployment default yields Host2/ordinary Browser Viewer1; active, provisional, selected, and Host SFU publication edges count. Ordinary peer ICE stays STUN-only, SFU roots stay <=2, and selected-edge UDP authority is bounded to one `peer-selected` lease per room excluding Host ingress.
- The deployed SFU path enforces the controller/token root cap, Host-publication edge accounting, zero-child assignment/subscriber retention, and `dynacast: false`. The tagged local gate covers these invariants; real shaped LiveKit packet flow, BWE downshift/recovery, resources, and root-with-children behavior remain unverified.
- Share audio presets and local-only Host SFU, codec/encoder, A/V, and selected-candidate diagnostics are deployed. Their target-browser field availability and actual media values remain unverified.
- The bounded pre-share self-check, privacy-safe local JSON export, and peer-quality MBB are deployed. An ordinary Viewer with a peer or SFU upstream may own the provisional child; Host provisional children and sibling MBB remain open. Real-route behavior remains part of the routing gate.
- Earlier exact-`16f6eab` evidence proves active Host ingress only; it does not prove the current release, initial Viewer ingress, healthy reselection, last-mile quality, or TURN performance.

## Retained Functional Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 runs preserved bounded fanout and decoding. Sixteen-Viewer cap2/cap3 loopbacks decoded all Viewers and a ten-second follow-up recorded guarded sender and aggregate Chromium CPU evidence, but resolution/FPS remained low and the ordinary-PC data cannot rank the caps. These are historical experiments that prove function, not sustainable capacity, heterogeneous-network quality, or authority to lift the Host2/ordinary Browser Viewer1 release policy. See [peer-assisted media](./research/peer-assisted-media.md).
- Chrome 151 with local LiveKit 1.13.5/client 2.22.0 proved one SFU/UDP root after `q,f` -> `q,h`: decoded frames advanced 3 -> 23, rendered frames reached 26, Host used one edge, leaves were clean, and TURN was absent. This is functional evidence only. See [low-server media routes](./research/low-server-media-routes.md).
- Host A+B and authenticated P2P Viewer C evidence is sanitized, generation-bound, read-only, and closed for stale, ambiguous, or SFU-fed reports. Production can expose a Host-local current SFU `h` snapshot and clears it on publisher identity changes; raw media metadata is not retained. See [realtime quality adaptation](./research/realtime-quality-adaptation.md).
- The built-in peer TURN canary was rejected after allocation passed but the direct Host/Pion Viewer path failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations. See [built-in peer ICE TURN](./research/built-in-peer-ice-turn.md).
- Chrome H.264 loopback proves negotiation and decode interoperability, not encoder performance or hardware attribution. Native WGC/MF has a one-Viewer Windows proof with 203 rendered 1280x720 frames, 500 Opus packets, and nonzero process/LUID-correlated `VideoEncode`. See [Native H.264](./research/native-h264-hardware-decision.md) and [Native shared encode](./research/native-shared-encode-sender.md).
- Native Windows 11 process audio is source-only and default-off. A retained run isolated the target by about 4018x and delivered 495 Opus packets to one Viewer; package download, game sync, Windows 10, and other routes remain open. See [ADR-0008](./adr/0008-window-scoped-audio-capture.md).
- The local access gate proves pre-DOM fragment clearing, room-scoped session isolation, no site/grant transport-log hits, no raw room-password SQLite sentinel, and rotate/revoke behavior. It is headless loopback evidence only. See [ADR-0002](./adr/0002-persistent-protected-rooms.md).

## Open Proof Boundaries

- Routing: verify current-release initial ingress, `peer-selected` expiry/failure, corroborated bad-relay reassignment, one-root healthy SFU reselection, silent partitions, and bounded failure on real browser/media paths. Silent control partitions may wait 30 to 60 seconds for heartbeat detection before the default five-second grace.
- Quality: production startup blur remains unclassified. One same-`balanced` local A/B retained route/PC/SSRC/track while 720p rose to 1080p, but natural ramp prevents causal, production, or SFU conclusions. Correlate Host capture/encode/send with Viewer receive/decode before changing policy.
- Relay resources: production is Host2/ordinary Browser Viewer1 and rejects any Viewer child2 regardless of advertised capacity. Two-child relay corroboration is therefore a future-capacity experiment, while the triggering child's edge-local MBB remains active. Relay CPU/GPU/upload cost and heterogeneous-network behavior remain unverified. Finish the role-aware matrix before the 20-viewer gate or any future capacity-tier change.
- SFU: production deploys ordered `q,h`, roots <=2, and Dynacast off. Real zero-child shaped LiveKit packet flow, BWE downshift/recovery, resource cost, and root-with-children behavior remain open. Use Linux `tc` or a public canary for per-leaf shaping, never CDP throttling.
- Audio: verify the 64/128/256 kbps Share settings, negotiated/observed bitrate, audible music quality, route changes, and game A/V synchronization. Bitrate settings are ceilings, not quality proof.
- Observability: the UI and local stats plumbing are deployed, but target-browser availability and actual values remain unverified for Host SFU sender evidence, codec/fmtp and encoder implementation/power efficiency, media-source and encoded FPS, A/V playout/jitter/concealment, and selected candidate endpoints. These fields diagnose; they do not by themselves prove hardware encode, synchronization quality, or route quality.
- Mobile: Android/iOS remain Viewer-only. Autoplay, rotation, iOS lock-screen/page reclamation, background reconnection, and network changes need device evidence. AirPlay/system mirroring is Viewer-local output, not a portable in-app WebRTC output contract.
- Native: ADR-0006 has one-Viewer evidence only. Viewer2/FIFO, hardware diversity, endurance, downloaded-package/public-host, game A/V, and browser diversity remain open.
- Access and operations: run headful/production checks for fragment consumption, rotate/revoke, and request/nginx/journal/SQLite leakage. The isolated VM/IP gate remains required before clean-port migration; shared-IP smoke cannot approve it.

## Evidence Rules

- Target-device and production measurements drive performance decisions. Ordinary-PC synthetic runs prove only correctness or interoperability.
- Record expensive evidence with exact source, environment, result, and applicability. When a relevant media path changes, replace or invalidate the corresponding entry; unrelated documentation changes do not require rerunning it.
- Keep architecture-splitting candidates out of this ledger unless a proven consumer boundary makes them active work; file length alone is not evidence.
