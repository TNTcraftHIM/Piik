# Current Status

Last updated: 2026-08-24

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact deployed application/runtime revision `679fe3e7af634309322bea83b316641f51ad3d09`, release `679fe3e`, wire `screener-v11`, from `/opt/screener/releases/679fe3e`; that revision is integrated in canonical `main`. Its immutable runtime ZIP SHA-256 is `fc96137f0fdc4dc4d8e083513d8fe99b9c55f7067a8b1de9202551edc3776c50`, and its 38-file manifest SHA-256 is `73f67c530acd5d4c77b546c19b5752c066f82682a584a72cd7ca596d6c5bec7e`.
- `screener`, LiveKit, coturn, and nginx are active/running; local/public `/` and `/healthz` return 200, all six served assets match the immutable release, and all four services report `NRestarts=0`. `assets/index-CGzoJSvs.js` has SHA-256 `31cf628d96be88f373cd0c3ac09e4966929fe320414aa1f0f9841264708d5a7e`; the retired v10 asset `assets/index-BtFMxoNI.js` returns 404, and stale v10 authentication receives `INVALID_MESSAGE` with close 1008 before room authority.
- The service process resolves its working directory to exact release `679fe3e`; it has no writable room `StateDirectory` or SQLite runtime.
- Production admits one Host plus 20 Viewers, applies endpoint capacity `2`, rejects stale Browser and executable-sender wires before room authority, and runs the one-controller exact-candidate route model with one staged total deadline. Rooms use random free four-digit codes, a 24-hour dormant lease, restart loss, local Host creation preferences, independent Viewer grants, and `open | password | disabled` code entry. LiveKit remains dedicated with `room.auto_create: false`, `max_participants: 21`, and global admission `1` publication ingress / `20` subscription egress.
- Production media ports remain STUN-only UDP 3478 and LiveKit UDP 7882; coturn TCP/TLS, port 5349, media TCP, and relay ranges are disabled. The public Web ingress remains TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are internal-only. The nft ruleset SHA-256 is `a895f0bb7b66ffe21071ee18acd84d4ea43ca16d4bca9517e6272e14d0ecced4`.
- SFU subscribers reconcile Host screen publications across connect, activation, participant arrival, track publication, and reconnect. LiveKit runs at `warn`/Pion `error`, and the Screener unit waits boundedly for the same-host LiveKit control listener before startup. Postflight found zero warning-level Screener journal entries and an empty LiveKit namespace, so physical direct, browser-relay, and SFU codec behavior remains an open current-release gate.
- Production Browser SFU PCs currently inherit the LiveKit join response's external STUN endpoint. Under the reproducing Mihomo TUN path, isolated Host publication succeeded only `2/8`; server input/output hooks counted return-path work while Browser ICE received no response. The accepted Browser SFU ICE-server isolation is not deployed.
- Production leaves video `contentHint` unset, keeps audio `contentHint = "music"`, and fixes Browser direct, browser-relay, and SFU video to VP8 without codec UI, quality state, wire fields, or fallback media codecs.

## Current Source

- Canonical root `main` is the integration truth; auxiliary branches and older worktrees do not supersede it. Current source keeps strict Browser `screener-v11`, rejects every other wire before room authority, and adds Browser SFU ICE-server isolation implementation `ae09c760adec76fd26da611d4928486d105c6d3b` beyond deployed application revision `679fe3e7af634309322bea83b316641f51ad3d09`.
- Current source implements one Host plus up to `20` Viewers, one steady outbound media-copy cap for every non-server endpoint (default `2`, static `1/2/3`), and the process-memory room model with random four-digit codes, a default 24-hour dormant lease, exact-Host resume, restart loss, local Host preference replay, independent token invitations, `open | password | disabled` code entry, and no SQLite runtime.
- One event-driven controller owns the committed graph and at most one room-serial child operation. It uses one deterministic candidate list/cursor and one total direct-then-SFU deadline; exact admission and physical resources remain charged through drain, and the pending candidate commits only after an exact-generation decoded-frame proof. A short-lived 100 ms stats observer proves only that candidate inside the existing deadline, while the 2-second sampler remains responsible for active-path diagnostics and decoded-frame stalls. Healthy edges remain sticky and current-path quality does not authorize reparenting.
- Ordinary peer ICE is STUN-only and the only application fallback is the dedicated LiveKit SFU over UDP. SFU generations use explicit no-default ingress/egress capacities, exact `reserved | committed | draining` accounting, delete-plus-absence release, one Host publication, and exact Viewer subscription handles. No Screener TURN, ICE/TCP, media TCP, or TLS-relayed media route exists.
- Current Browser SFU publisher and subscriber connects supply fresh `autoSubscribe: false` plus `rtcConfig: { iceServers: [] }` options. Ordinary peers retain deployment STUN; LiveKit signaling candidates, server-side public-IP discovery, route deadlines, ports, and retry behavior are unchanged.
- Current source leaves video `contentHint` unset and keeps audio `contentHint = "music"`. Browser direct and browser-relay offers contain VP8 as their only media codec, and SFU publication explicitly uses VP8 with no backup codec. Codec UI, quality state, wire fields, fallback media codecs, and share-lifetime codec branches are absent. Live 64/128/256 kbps audio-ceiling mutation and ordinary `shareGeneration`-fenced Pause/Resume remain unchanged.
- Current source implements typed first-frame Viewer presentation and recovery, Chinese user-facing route/access failures, privacy-safe failed-page export, authenticated Host-only on-demand route snapshots, neutral `ROOM_ACCESS_DENIED` room-code admission, and responsive entry controls.
- Recommended quality remains exactly `1080p60`, `1080p30`, and `720p30`; current source defaults to `1080p30`. Advanced resolution adds `480p` as `854x480` without adding a fourth preset, and advanced FPS and bitrate remain independent.
- Exact v11 implementation `f5a295c52e0ac7d18e5a7949217861c7aa74e9c9`, integrated into deployed application/runtime revision `679fe3e7af634309322bea83b316641f51ad3d09` and canonical `main`, passed the current automated source gates. Deployment postflight passed, but no physical direct, browser-relay, or SFU codec path was exercised; retained v10 loopback evidence applies only to that older source. Exact results are owned by [verification status](./verification-status.md).
- Exact SFU isolation implementation `ae09c760adec76fd26da611d4928486d105c6d3b` passed repository hygiene, TypeScript, all 605 Web tests in 45 files, client/server production builds, and three independent code reviews with no finding. It is not deployed and has no exact product Viewer first-frame evidence.

## Current Milestone

1. Deploy the source-complete Browser SFU ICE-server isolation, then prove exact Host publication and Viewer first-frame media under the reproducing TUN path and a mobile network.
2. Diagnose the reported screen-audio `1 kbps` readout and physically validate live audio ceilings.
3. Physically verify the deployed `screener-v11` fixed-VP8/no-video-hint direct, browser-relay, and SFU paths from actual codec, capture, outbound, and decoded stats.
4. Refine the Host invitation controls without changing grant semantics implicitly.
5. Finish representative ICE/STUN/SFU acceptance including mobile networks. Browser port prediction, NAT classification, TCP probing, fake page keepalive, and quality-driven reparenting remain outside the accepted model.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- The desktop Host background/minimized report is deferred until a current-production real-game reproduction supplies synchronized media and CPU/GPU evidence. Mobile Viewer background playback and relay survival remain a separate Accepted Later lifecycle gate.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current Browser milestone and are not built or run.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Room lifetime, authorization/storage semantics, restart loss, entry/presentation, and the Browser v11 wire remain aligned between source and production; Browser SFU ICE-server isolation is source-only until the next application release. The prior application-only cutover reused unchanged infrastructure and configuration and does not maintain a full rollback/configuration backup; any future infrastructure or irreversible-state change requires recovery scoped to the surfaces it actually changes.
- Real SFU recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

Production has an active P1 core-route hold: Browser SFU initial ICE is
intermittent under the reproduced Mihomo TUN path; the best-supported cause is
the PC's external-STUN/SFU association conflict. Browser SFU ICE-server
isolation is source-validated but must be deployed and physically proven before
the route hold closes. Native/executable work and broad repository cleanup
remain outside the current evidence boundary.
