# Current Status

Last updated: 2026-08-25

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact deployed application/runtime revision `c4962f54443ad5f98bc65861195a3d9c74a48996`, release `c4962f5`, wire `screener-v11`, from `/opt/screener/releases/c4962f5`; that revision is integrated in canonical `main`. Its immutable runtime ZIP SHA-256 is `734815479a03728bb81b44ce5dc04fe010323acdbb91cdbea0e806548278164c`, and its 38-file manifest SHA-256 is `aefc414238655e9cb33d33975813bcc44afd22c5ad4e056ab719fae6c20aed47`.
- `screener`, LiveKit, coturn, and nginx are active/running; local/public `/healthz` return 200 and all four services report `NRestarts=0`. The served main Browser asset is `assets/index-DQgIVwby.js` with SHA-256 `f819df6c94652d0c5847daa602431384f7b6bf58aa38615fa327526755ede4ef`.
- The service process resolves its working directory to exact release `c4962f5`; it has no writable room `StateDirectory` or SQLite runtime.
- Production admits one Host plus 20 Viewers, applies endpoint capacity `2`, rejects stale Browser and executable-sender wires before room authority, and runs the one-controller exact-candidate route model with one staged total deadline. Rooms use random free four-digit codes, a 24-hour dormant lease, restart loss, local Host creation preferences, independent Viewer grants, and `open | password | disabled` code entry. LiveKit remains dedicated with `room.auto_create: false`, `max_participants: 21`, and global admission `1` publication ingress / `20` subscription egress.
- Production media ports remain STUN-only UDP 3478 and LiveKit UDP 7882; coturn TCP/TLS, port 5349, media TCP, and relay ranges are disabled. The public Web ingress remains TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are internal-only. The nft ruleset SHA-256 is `a895f0bb7b66ffe21071ee18acd84d4ea43ca16d4bca9517e6272e14d0ecced4`.
- SFU subscribers reconcile Host screen publications across connect, activation, participant arrival, track publication, and reconnect. LiveKit runs at `warn`/Pion `error`, and the Screener unit waits boundedly for the same-host LiveKit control listener before startup. Postflight found healthy unchanged services and the owner physically verified current SFU fallback media. Full direct/browser-relay/SFU codec and real-network acceptance remain open.
- Production Browser SFU publisher and subscriber PCs explicitly use empty external ICE-server lists while retaining LiveKit-signaled UDP candidates. The owner verified that the deployed isolation fixes the reported SFU connection failure; the prior P1 core-route hold is closed.
- Production leaves video `contentHint` unset, keeps audio `contentHint = "music"`, and fixes Browser direct, browser-relay, and SFU video to VP8 without codec UI, quality state, wire fields, or fallback media codecs.

## Current Source

- Canonical root `main` is the integration truth; auxiliary branches and older worktrees do not supersede it. Current source uses the single strict Browser `screener-v12` wire and rejects every other wire before room authority. Production remains the older exact v11 revision stated above.
- Current source implements one Host plus up to `20` Viewers, one steady outbound media-copy cap for every non-server endpoint (default `2`, static `1/2/3`), and the process-memory room model with random four-digit codes, a default 24-hour dormant lease, exact-Host resume, restart loss, local Host preference replay, exactly `open | private` code entry, and no SQLite runtime. Every room defaults to `open` without a room password and independently receives a Viewer grant: one 22-character opaque value bound to that room incarnation. Private rooms without a password are invitation-only; configuring a password additionally permits matching code-only entry. Unallocated/reclaimed/expired code-only entry returns `ROOM_NOT_FOUND` without a password prompt.
- One event-driven controller owns the committed graph and at most one room-serial child operation. It uses one deterministic candidate list/cursor and one total direct-then-SFU deadline; exact admission and physical resources remain charged through drain, and the pending candidate commits only after an exact-generation decoded-frame proof. A short-lived 100 ms stats observer proves only that candidate inside the existing deadline, while the 2-second sampler remains responsible for active-path diagnostics and decoded-frame stalls. Healthy edges remain sticky and current-path quality does not authorize reparenting.
- Ordinary peer ICE is STUN-only and the only application fallback is the dedicated LiveKit SFU over UDP. SFU generations use explicit no-default ingress/egress capacities, exact `reserved | committed | draining` accounting, delete-plus-absence release, one Host publication, and exact Viewer subscription handles. No Screener TURN, ICE/TCP, media TCP, or TLS-relayed media route exists.
- Current Browser SFU publisher and subscriber connects supply fresh `autoSubscribe: false` plus `rtcConfig: { iceServers: [] }` options. Ordinary peers retain deployment STUN; LiveKit signaling candidates, server-side public-IP discovery, route deadlines, ports, and retry behavior are unchanged.
- Current source leaves video `contentHint` unset and keeps audio `contentHint = "music"`. Browser direct and browser-relay offers contain VP8 as their only media codec, and SFU publication explicitly uses VP8 with no backup codec. Codec UI, quality state, wire fields, fallback media codecs, and share-lifetime codec branches are absent. Live 64/128/256 kbps audio-ceiling mutation remains unchanged; ordinary Host and SFU publisher metrics now select the exact current audio sender track and reset their baseline when that identity changes or disappears.
- Current source implements typed first-frame Viewer presentation and recovery, Chinese user-facing route/access failures, local connection details without a diagnostic-file export, authenticated Host-only on-demand route snapshots for automatic acceptance, explicit missing-room presentation, and responsive entry controls. Host invitation controls remain independent from two-state room-code entry.
- Recommended quality remains exactly `1080p60`, `1080p30`, and `720p30`; current source defaults to `1080p30`. Advanced resolution adds `480p` as `854x480` without adding a fourth preset, and advanced FPS and bitrate remain independent.
- Current v12 source passed repository hygiene, TypeScript, all 609 Web tests in 44 files, both production builds, and focused independent review. The exact predecessor's SFU, Chrome access/privacy, 20-Viewer loopback, and responsive visual evidence remains separately bounded in [verification status](./verification-status.md). V12 is not deployed.

## Current Milestone

1. Release the accepted strict v12 source atomically and verify stale-wire rejection, health, invitation/access behavior, and unchanged direct/SFU operation. Private rooms without a password remain invitation-only, and a configured password additionally permits matching code-only entry; no deployment has occurred at this checkpoint.
2. Physically validate the corrected live screen-audio statistics and 64/128/256 kbps ceilings with known audible content across direct, browser-relay, and SFU paths.
3. Physically verify fixed-VP8/no-video-hint direct, browser-relay, and SFU paths from actual codec, capture, outbound, and decoded stats.
4. Finish representative ICE/STUN/SFU acceptance including mobile networks. Browser port prediction, NAT classification, TCP probing, fake page keepalive, and quality-driven reparenting remain outside the accepted model.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- The desktop Host background/minimized report is deferred until a current-production real-game reproduction supplies synchronized media and CPU/GPU evidence. Mobile Viewer background playback and relay survival remain a separate Accepted Later lifecycle gate.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current Browser milestone and are not built or run.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Room lifetime, authorization/storage semantics, restart loss, and routing remain aligned, while current source is strict v12 and production remains strict v11 until an explicitly authorized atomic application release. The prior application-only cutover reused unchanged infrastructure and configuration and does not maintain a full rollback/configuration backup; any future infrastructure or irreversible-state change requires recovery scoped to the surfaces it actually changes.
- Real SFU recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

There is no active core-route hold. Native/executable work and broad repository
cleanup remain outside the current evidence boundary.
