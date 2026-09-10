# Embedded Media Evaluation

Reviewed: 2026-09-07. Status: evaluation, not a deployed transport decision.
Baseline: `3da8ecd22a3499e660f498e527ad4ffbaef08c82`.

## Goal

The owner requests source/library-level STUN and SFU inside the Piik Go
process. Bundled coturn/LiveKit executables, automatic installers, subprocess
supervision and embedding the full LiveKit service do not meet this goal.
The owner has also agreed to [node-local adaptive reuse](./node-local-adaptation.md):
each parent derives missing lower outputs for its direct children and reuses
them locally. That file owns the agreed model and unresolved encoding policy.
nginx/TLS replacement and capture-picker changes are outside this experiment.
The existing release/configuration candidate remains separate and untouched.

## Invariants

Keep one room authority and the P2P-first, single-graph, single-operation router.
The fallback retains one Host publication feeding server-side fanout to many
Viewers. Framework-managed simulcast may use bounded representations within
that publication; Viewer count must not add Host encoders or independent Host
uploads. Ordinary TURN forwarding of one Host connection per Viewer does not
meet this requirement and is not an SFU replacement candidate.
Retain H264/VP8, Opus, per-subscriber adaptation, retransmission, recovery and
the existing three STUN destinations. Do not trade weak-Viewer experience for a
smaller package, invent an application quality score or add a media ladder.
The media library, not Piik, must own congestion and layer decisions.
No recording, mixing, TURN relay, public port scanning or production test.
Selective local transcoding is now in research scope under the agreed model;
the existing fanout-only probe does not establish that capability.

## Evaluation Order

1. Audit library APIs, license, dependencies and H264/simulcast feedback paths.
2. Implement a small in-process STUN owner using Pion. Check Binding responses,
   no relay allocation, occupied-port rollback and complete socket shutdown.
3. Exercise one publisher and two receivers through an SFU library on loopback.
   Check fixed Host publication count, actual media, clean teardown and the library's adaptation ownership;
   frame forwarding alone is not acceptance of a LiveKit replacement.
4. Compare added dependencies and binary size, then remove unnecessary glue.
   A production adapter/wire cutover needs a decision supported by these results.

No new production dependency or alternate runtime transport is accepted merely
because its example compiles. Keep test executables under the worktree's stable
`build/` path and avoid native GPU capture probes.

## Initial Candidates

- Pion STUN/TURN is already in the dependency graph and explicitly supports
  embedding. Only STUN is needed; TURN allocations must remain unavailable.
- ion-sfu is library-oriented, but its inspected module still uses Pion WebRTC
  v3 and ICE v2. Do not introduce another older media stack by default.
- inlivedev/sfu uses Pion WebRTC v4 and exposes room/client APIs. Its README
  explicitly warns that its API is early-stage; listed features are claims to
  verify, not proof of Piik's required behavior.
- Galene is useful architectural reference, not yet an accepted library adapter.

## Current Evidence

- The 2026-09-07 local STUN check passed three independent Binding responses,
  zero TURN allocations, port release on shutdown and occupied-port rollback.
  The adapter uses Pion's existing STUN-only server, not a new STUN parser.
- `inlivedev/sfu` is pinned for evaluation at
  `v0.0.0-20260307060053-14b2448a8982` (MIT). A loopback Pion publisher with one
  H264 RTP sender fed two receivers, each receiving 12 RTP packets in the check.
  No extra Host sender was created for the second receiver. The source was a
  synthetic 2x2 H264 sample, so this is not Browser decode, game quality, latency,
  resource-drain or adaptive-layer acceptance.
- The candidate is imported only by the probe test. There is no production
  adapter or signaling change. Its dependency graph also adds TURN v4 alongside
  the existing v5 and upgrades `x/net` from 0.50.0 to 0.51.0; evaluate that cost
  before selecting it. No fork or patch of the library has been introduced.
- Candidate source contains Pion GCC, RTCP feedback and simulcast switching.
  It also requires publisher-layer/bitrate agreement and has application-oriented
  defaults. A demand-driven publisher contract equivalent to our current behavior
  has not yet been established. README feature lists alone do not close this gap.

Reproduction uses `go test -c -o build/embedded-media/<name>.test.exe` for
`./internal/server/stun` and `./internal/server/sfuprobe`, then executes each
binary with `-test.v -test.timeout=15s`. Quote the dotted flags in PowerShell.

## Transport Direction

One-to-many distribution is not tied to the LiveKit implementation. Keep WebRTC
as the primary Browser media path while evaluating a lighter embedded engine.
RTMP/RTSP/SRT distribution can also fan out one input, but a Browser-facing
gateway/player pipeline and equivalent media adaptation would still be needed.
Do not add that second transport merely to change the service's name.

WHIP is HTTP signaling for WebRTC ingest, not a replacement media transport.
Its no-renegotiation constraint must be checked against live audio/source changes;
it is not adopted merely because the request/response looks simpler. The current
Piik signaling owner remains authoritative during this evaluation.

## Sources

- [Pion embeddable STUN/TURN](https://github.com/pion/turn)
- [ion-sfu module](https://github.com/ionorg/ion-sfu/blob/master/go.mod)
- [inLive SFU API and caveats](https://github.com/inlivedev/sfu)
- [inLive dependency contract](https://github.com/inlivedev/sfu/blob/main/go.mod)
- [Galene architecture](https://galene.org/README.html)
- [Browser-facing MediaMTX playback](https://mediamtx.org/docs/read/web-browsers)
- [SRT protocol](https://github.com/Haivision/srt)
- [WHIP media and signaling contract](https://www.rfc-editor.org/rfc/rfc9725.html)

## 中文范围

本阶段是库级替换实验，不是把外部程序藏进安装包。先核实成熟模块能否保持
现有观影体验，再决定接入。仅转发成功不代表自动降级、重传和恢复已验收；
必须保留一次 Host 发布、服务端多观众分发；不能用逐观众 TURN 上行替代。
尚未修改生产路由、协议或部署。
