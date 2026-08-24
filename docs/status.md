# Current Status

Last updated: 2026-08-24

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact integrated main `39fcf93bae057fcbb1002702c3be6b90bac9027f`, release `39fcf93`, wire `screener-v9`, from `/opt/screener/releases/39fcf93`. Its immutable runtime ZIP SHA-256 is `28190c3a69ec937d39ab5d49fdbc8db6a07e6013c2ddd5f5590bf8249bf6bce6`; `/opt/screener/backups/39fcf93-pre-v9-20260824T004257Z` is the verified rollback boundary and its `SHA256SUMS` hash is `1f741f29022f5eb1eb311a24f87f5f48598dca7b1879b88f9033c331fa06bd37`.
- `screener`, LiveKit, coturn, and nginx are active/running; local/public `/` and `/healthz` return 200 and all four services report `NRestarts=0`. Every served client file matches the immutable release, `assets/index-DLLdorRt.js` has SHA-256 `891b1fc861b12655d53a38c1dbf56d8981fa4ed24643760ed8d7838efcbf46f3`, contains one `screener-v9` literal and no `screener-v8`, and the retired v8 asset returns 404.
- The release is root-owned, has no group/world-writable real file or directory, has no dangling or escaping symlink, and shares zero regular-file inodes with release `8f5b3f1`. The service process resolves its working directory to exact release `39fcf93`; it has no writable room `StateDirectory` or SQLite runtime.
- Production admits one Host plus 20 Viewers, applies endpoint capacity `2`, rejects stale Browser and executable-sender wires before room authority, and runs the one-controller exact-candidate route model with one staged total deadline. Rooms use random free four-digit codes, a 24-hour dormant lease, restart loss, local Host creation preferences, independent Viewer grants, and `open | password | disabled` code entry. LiveKit remains dedicated with `room.auto_create: false`, `max_participants: 21`, and global admission `1` publication ingress / `20` subscription egress.
- Production media ports are STUN-only UDP 3478 and LiveKit UDP 7882; coturn TCP/TLS and relay ranges are disabled. The public Web ingress remains TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are internal-only. These deployment facts do not close the real heterogeneous-network, SFU, mobile, or endurance evidence boundaries.
- SFU subscribers reconcile Host screen publications across connect, activation, participant arrival, track publication, and reconnect. LiveKit runs at `warn`/Pion `error`, and the Screener unit waits boundedly for the same-host LiveKit control listener before startup. Postflight created no v9 media room, so physical direct, peer-relay, and SFU behavior remains an open current-release gate.

## Current Source

- Canonical root `main` is the source and integration truth. It contains the deployed Browser runtime checkpoint `39fcf93bae057fcbb1002702c3be6b90bac9027f` plus the current docs-only truth checkpoints; auxiliary branches and older worktrees do not supersede it.
- The single Browser `screener-v9` boundary rejects stale clients before room authority. Current source implements one Host plus up to `20` Viewers, one steady outbound media-copy cap for every non-server endpoint (default `2`, static `1/2/3`), and the process-memory room model with random four-digit codes, a default 24-hour dormant lease, exact-Host resume, restart loss, local Host preference replay, independent token invitations, `open | password | disabled` code entry, and no SQLite runtime.
- One event-driven controller owns the committed graph and at most one room-serial child operation. It uses one deterministic candidate list/cursor and one total direct-then-SFU deadline; exact admission and physical resources remain charged through drain, and the pending candidate commits only after an exact-generation decoded-frame proof. A short-lived 100 ms stats observer proves only that candidate inside the existing deadline, while the 2-second sampler remains responsible for active-path diagnostics and decoded-frame stalls. Healthy edges remain sticky and current-path quality does not authorize reparenting.
- Ordinary peer ICE is STUN-only and the only application fallback is the dedicated LiveKit SFU over UDP. SFU generations use explicit no-default ingress/egress capacities, exact `reserved | committed | draining` accounting, delete-plus-absence release, one Host publication, and exact Viewer subscription handles. No Screener TURN, ICE/TCP, media TCP, or TLS-relayed media route exists.
- Current source implements live 64/128/256 kbps audio-ceiling mutation for current and future Host/relay/SFU senders. It also implements paused `automatic | H.264 | VP8` switching as one generation-fenced prepare/Resume/source-ack/proof transaction with a server-monotonic `resumeAttempt`, authoritative re-pause, bounded rollback preparation, and no automatic Resume.
- Current source implements typed first-frame Viewer presentation and recovery, Chinese user-facing route/access failures, privacy-safe failed-page export, authenticated Host-only on-demand route snapshots, neutral `ROOM_ACCESS_DENIED` room-code admission, and responsive entry controls. The unused parent-edge quality-proof protocol is absent.
- Recommended quality remains exactly `1080p60`, `1080p30`, and `720p30`; current source defaults to `1080p30`. Advanced resolution adds `480p` as `854x480` without adding a fourth preset, and advanced FPS and bitrate remain independent.
- Exact runtime source `d543f38aacad3df5ef65fde1055cc8e733972afe`, integrated without runtime changes by main `39fcf93bae057fcbb1002702c3be6b90bac9027f`, passed 670 Web tests in 48 files, TypeScript typecheck, client/server production builds, the access/privacy gate, production-dependency audit, and repository hygiene. Its exact one-Host/20-Viewer Chrome loopback passed every gate with all Viewers decoding and Host/relay fanout bounded by cap `2`; all observed media routes were local direct peers and no SFU publication appeared. This is source, state-machine, build, privacy, and direct-loopback evidence, not public-network, SFU, mobile, physical audio/codec, H.264 performance, or Host-background evidence.

## Current Milestone

1. Replace the current codec transaction with the accepted pre-share-only selector, VP8 default, fixed per-share codec preference, and ordinary `shareGeneration`-fenced Pause/Resume. Integrate and deploy it atomically on one new Browser wire version with no v9 compatibility path.
2. Validate live audio ceilings on physical direct, peer-relay, and SFU paths, then reproduce the Host background/minimized report under controlled conditions while recording the actual negotiated codec.
3. Finish representative ICE/STUN/SFU acceptance including mobile networks. Browser port prediction, NAT classification, TCP probing, fake page keepalive, and quality-driven reparenting remain outside the accepted model.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current Browser milestone and are not built or run.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- GitHub Actions run `32677084865` for the v9 integration did not start a step (`runner_id=0`) because the account payment or spending limit blocked runner allocation. It produced no code evidence and was not retried; the exact local gates remain the current source evidence.
- Room lifetime, authorization/storage semantics, restart loss, Browser v9 entry/presentation, and rollback restoration are aligned between exact main and production.
- Real SFU recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

There is no active P0/P1 source or deployment hold. Browser v9 is integrated, locally gated, atomically
deployed, and postflight-clean, but its codec transaction is no longer the accepted product contract.
The accepted simplification is truth-only until the next atomic Browser release; source and production
must not be reported as simplified before that cutover. Physical audio, heterogeneous-network, SFU,
background, and mobile evidence remains open. Native/executable work and broad repository cleanup
remain outside the current evidence boundary.
