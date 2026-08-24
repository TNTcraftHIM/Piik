# Current Verification Status

Last updated: 2026-08-24

## Purpose

This is the demand-loaded ledger for cross-cutting validation evidence and open proof boundaries that do not fit one requirement, ADR, research note, or deployment guide. It is current state, not a release diary: replace superseded facts in place, move durable specialist conclusions to their owning documents, and let Git history retain completed timelines.

Capacity and routing entries below describe the exact tested source or release only. Product direction and executable work are owned by [project memory](./project-memory.md) and [the TODO ledger](./todo.md).

## Deployment Evidence

- Production runs exact `39fcf93bae057fcbb1002702c3be6b90bac9027f`, release `39fcf93`, wire `screener-v9`, from `/opt/screener/releases/39fcf93`. The immutable runtime ZIP SHA-256 is `28190c3a69ec937d39ab5d49fdbc8db6a07e6013c2ddd5f5590bf8249bf6bce6`.
- `/opt/screener/backups/39fcf93-pre-v9-20260824T004257Z` retains the exact pre-v9 current target plus application environment, systemd, LiveKit, coturn, nft, and nginx boundary; its internal manifest SHA-256 is `1f741f29022f5eb1eb311a24f87f5f48598dca7b1879b88f9033c331fa06bd37`.
- The 2026-08-24 v9 postflight found `screener`, LiveKit, coturn, and nginx active with zero restarts and local/public health at 200. Public root and all referenced assets returned 200; `assets/index-DLLdorRt.js` matched the release artifact SHA-256 `891b1fc861b12655d53a38c1dbf56d8981fa4ed24643760ed8d7838efcbf46f3` and contains the single `screener-v9` wire with no `screener-v8` literal.
- A public stale-v8 signaling probe reached the v9 server and received the fatal stale-client result before role or room authority. The probe created no room, and the service remained healthy with zero restart.
- GitHub Actions run `32677084865` for integration commit `39fcf93` started no step (`runner_id=0`) because account payment or spending-limit state prevented runner allocation. It has no logs, was not retried, and is neither validation evidence nor a source failure; the exact local gates below remain the available source evidence.
- Production uses endpoint capacity `2`, room admission `20`, random free four-digit memory rooms, `ROOM_LEASE_SECONDS=86400`, a dedicated LiveKit instance with `room.auto_create: false` and `max_participants: 21`, and global SFU admission `1` ingress / `20` egress. Room authority is process-memory-only. Coturn is `stun-only`, `no-tcp`, and `no-tls`; only UDP 3478 listens, and nft exposes only UDP 3478/7882 for Screener media.
- The production service orders Screener after LiveKit and boundedly waits for its control listener. Current journals use warn/Pion-error logging, contain zero `PublisherOffer` record, and the current/rollback release regular-file sets share zero inodes.
- This postflight proves archive identity, atomic application/assets, stale-wire rejection, process health, listener/firewall continuity, log sentinels, and rollback readiness only. It did not create a current v9 media room or exercise direct, peer-relay, SFU, audio, codec, mobile, quality, or endurance behavior.
- A historical v8 production canary forced one peer and two active 1920x1080 SFU roots over LiveKit UDP and decoded all three Viewers. It remains dated infrastructure/path evidence, not a current v9 media acceptance result.

## Retained Functional Evidence

- Exact Browser v9 source `d543f38aacad3df5ef65fde1055cc8e733972afe`, integrated by deployed main `39fcf93bae057fcbb1002702c3be6b90bac9027f`, passed repository hygiene, TypeScript typecheck, client and server production builds, all 670 Web tests in 48 files, the access/privacy Browser gate, and the production-dependency audit with zero vulnerability. This covers the in-memory room/access boundary, v9 protocol, one serialized exact-candidate route controller, generation-bound first-decoded-frame proof, physical resource retention, SFU lifecycle and admission, paused codec transition/rollback/source authority, live media-setting mutation, on-demand route observability, Viewer presentation state, and entry UI. These are local source/state-machine/build gates, not heterogeneous-network, target-device quality, or real LiveKit packet-flow proof.
- The same exact v9 source passed the required one-Host/20-Viewer local Browser gate with endpoint cap `2`; report SHA-256 is `EB879256C13C75FF1C7F3BC313DE1681FC5D89FC1F51D63B96ECD3ECB93DD09F`. Queue, candidate, first-frame, and final timing each recorded `20/0` populated/missing values. The sorted millisecond evidence is:

  | Timing | Raw values (ms) | p50 / p95 / max (ms) |
  | --- | --- | --- |
  | Queue | `1, 975, 1170, 1339, 1691, 1814, 2008, 2258, 2508, 2749, 2998, 3237, 3467, 3695, 3795, 4037, 4268, 4498, 4629, 4862` | `2749 / 4629 / 4862` |
  | Candidate | `2, 976, 1171, 1339, 1692, 1814, 2008, 2258, 2509, 2749, 2998, 3237, 3467, 3695, 3795, 4037, 4268, 4498, 4629, 4863` | `2749 / 4629 / 4863` |
  | First frame | `1334, 1349, 1421, 1708, 1824, 2062, 2258, 2506, 2749, 3017, 3239, 3478, 3706, 3835, 4036, 4272, 4508, 4641, 4874, 5104` | `3017 / 4874 / 5104` |
  | Final | `1334, 1349, 1421, 1708, 1824, 2062, 2258, 2506, 2749, 3017, 3239, 3478, 3706, 3835, 4036, 4272, 4508, 4641, 4874, 5104` | `3017 / 4874 / 5104` |

  This gate used local direct loopback media and observed no SFU route. It proves bounded local direct convergence at exact admission `20`; it does not prove public-network traversal, SFU fallback, visual quality, target-device resources, or endurance.
- Chrome 151 synthetic `1/3/5/8` and 720p30 runs preserved bounded fanout and decoding. A `9461e20`-era three-Viewer rerun kept Host2/Browser Viewer1, decoded every Viewer, and recovered a hard first-level relay departure in 5,380 ms; it did not exercise quality-triggered MBB. Sixteen-Viewer cap2/cap3 loopbacks decoded all Viewers and a ten-second follow-up recorded guarded sender and aggregate Chromium CPU evidence, but resolution/FPS remained low and the ordinary-PC data cannot rank caps, select product policy, or prove sustainable heterogeneous-network quality. See [peer-assisted media](./research/peer-assisted-media.md).
- Chrome 151 with local LiveKit 1.13.5/client 2.22.0 proved one SFU/UDP root after `q,f` -> `q,h`: decoded frames advanced 3 -> 23, rendered frames reached 26, Host used one edge, and leaves were clean. This is functional evidence only. See [low-server media routes](./research/low-server-media-routes.md).
- Host A+B and authenticated P2P Viewer C evidence is sanitized, generation-bound, diagnostic-only, and closed for stale or ambiguous reports. Production can expose a Host-local current SFU `h` snapshot and clears it on publisher identity changes; raw media metadata is not retained. See [realtime quality adaptation](./research/realtime-quality-adaptation.md).
- Chrome H.264 loopback proves negotiation and decode interoperability, not encoder performance or hardware attribution. Native WGC/MF has a one-Viewer Windows proof with 203 rendered 1280x720 frames, 500 Opus packets, and nonzero process/LUID-correlated `VideoEncode`. See [Native H.264](./research/native-h264-hardware-decision.md) and [Native shared encode](./research/native-shared-encode-sender.md).
- Native Windows 11 process audio is source-only and default-off. A retained run isolated the target by about 4018x and delivered 495 Opus packets to one Viewer; package download, game sync, Windows 10, and other routes remain open. See [ADR-0008](./adr/0008-window-scoped-audio-capture.md).

## Open Proof Boundaries

- Routing: exact v9 local direct loopback covers admission-20 initial ingress and exact-candidate first-frame commit timing. Still verify rollback, direct-stage exhaustion and SFU admission, relay-ingress reparent with subtree retention, disconnect/effective-capacity drain, pause/resume, and bounded failure on real browser/media paths. Silent control partitions may wait 30 to 60 seconds for heartbeat detection before the default five-second grace; a non-paused decoded-frame stall may invalidate only that exact child edge.
- Quality: production startup blur remains unclassified. One same-`balanced` local A/B retained route/PC/SSRC/track while 720p rose to 1080p, but natural ramp prevents causal, production, or SFU conclusions. Correlate Host capture/encode/send with Viewer receive/decode before changing policy.
- Relay resources: v9 source and production expose the authenticated `1/2/3` endpoint-cap boundary, and local loopback evidence covers 20 Viewers at cap `2`. CPU/GPU/upload and heterogeneous-network measurements remain diagnostics, not authority to change the contract.
- Room scale: v9 source and production admit 20 Viewers plus one Host, and the exact v9 local Browser convergence gate covers that bound on direct loopback. A real public-network 1:20 session, quality, and sustained resource matrix remain open.
- SFU: production uses one Host publication with exact Viewer subscriptions and no fixed root-count or room-wide lease rule. Real LiveKit lifecycle/JWT replay, shaped packet-flow, BWE downshift/recovery, resource use, and SFU-fed first-child evidence remain open. Use Linux `tc` or an authorized public canary for per-leaf shaping, never CDP throttling.
- Audio: verify the 64/128/256 kbps Share settings, negotiated/observed bitrate, audible music quality, route changes, and game A/V synchronization. Bitrate settings are ceilings, not quality proof.
- Observability: the v9 Viewer stage, local stats/export plumbing, identity-bound relayed-detail retention, export freshness guards, and on-demand Host route snapshot are deployed. Target-browser availability and actual values remain unverified for Host SFU sender evidence, codec/fmtp and encoder implementation/power efficiency, media-source and encoded FPS, A/V playout/jitter/concealment, selected candidate endpoints, and bounded same-pair STUN-response observation. All fields diagnose and have no recovery authority; they do not by themselves prove hardware encode, synchronization quality, or route quality.
- Mobile: Android/iOS remain Viewer-only. Autoplay, rotation, iOS lock-screen/page reclamation, background reconnection, and network changes need device evidence. AirPlay/system mirroring is Viewer-local output, not a portable in-app WebRTC output contract.
- Native: ADR-0006 has one-Viewer evidence only. Viewer2/FIFO, hardware diversity, endurance, downloaded-package/public-host, game A/V, and browser diversity remain open.
- Access and operations: exact v9 source passed the access/privacy Browser gate, and production passed atomic v9 cutover/postflight plus stale-v8 rejection before authority. Restart-wide room loss, password-profile creation, grant/code orthogonality, rotate/revoke, memory-only runtime, and exact current journal/nginx sentinel checks retain their focused evidence. Headful same-browser preference replay and the isolated VM/IP clean-port matrix remain open; shared-IP smoke cannot approve them.

## Evidence Rules

- Target-device and production measurements drive performance decisions. Ordinary-PC synthetic runs prove only correctness or interoperability.
- Record expensive evidence with exact source, environment, result, and applicability. When a relevant media path changes, replace or invalidate the corresponding entry; unrelated documentation changes do not require rerunning it.
- Keep architecture-splitting candidates out of this ledger unless a proven consumer boundary makes them active work; file length alone is not evidence.
