# Current Status

Last updated: 2026-08-24

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact integrated main `2726edde9b87f31fd76e749de47972ef817a9bd5`, release `2726edd`, wire `screener-v10`, from `/opt/screener/releases/2726edd`. Its immutable runtime ZIP SHA-256 is `07fa6500300bfedc9cedccb0db761b70a9ada8dd77608153728e34835f4e1b78`; `/opt/screener/backups/2726edd-pre-v10-20260824T025357Z` is the verified rollback boundary and its `SHA256SUMS` hash is `62d19aa0a3ec400477a4c76121eb0e9e4d553d024404f3da054fa1e95f251939`.
- `screener`, LiveKit, coturn, and nginx are active/running; local/public `/` and `/healthz` return 200 and all four services report `NRestarts=0`. Every served client file matches the immutable release, `assets/index-BtFMxoNI.js` has SHA-256 `885b9e50c57c64ac92cc8ffe5488d597bbb6fde6423e7a0b328efb9d1e943ad2`, contains one `screener-v10` literal and no `screener-v9`, and the retired v9 asset returns 404.
- The release is root-owned, has no group/world-writable real file or directory, has no dangling or escaping symlink, and shares zero regular-file inodes with release `39fcf93`. The service process resolves its working directory to exact release `2726edd`; it has no writable room `StateDirectory` or SQLite runtime.
- Production admits one Host plus 20 Viewers, applies endpoint capacity `2`, rejects stale Browser and executable-sender wires before room authority, and runs the one-controller exact-candidate route model with one staged total deadline. Rooms use random free four-digit codes, a 24-hour dormant lease, restart loss, local Host creation preferences, independent Viewer grants, and `open | password | disabled` code entry. LiveKit remains dedicated with `room.auto_create: false`, `max_participants: 21`, and global admission `1` publication ingress / `20` subscription egress.
- Production media ports are STUN-only UDP 3478 and LiveKit UDP 7882; coturn TCP/TLS and relay ranges are disabled. The public Web ingress remains TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are internal-only. These deployment facts do not close the real heterogeneous-network, SFU, mobile, or endurance evidence boundaries.
- SFU subscribers reconcile Host screen publications across connect, activation, participant arrival, track publication, and reconnect. LiveKit runs at `warn`/Pion `error`, and the Screener unit waits boundedly for the same-host LiveKit control listener before startup. Postflight left the LiveKit namespace empty, so physical direct, peer-relay, and SFU behavior remains an open current-release gate.
- Production sets video `contentHint = "motion"` and audio `contentHint = "music"`; the no-video-hint source change is not deployed.

## Current Source

- Canonical root `main` is the integration truth; auxiliary branches and older worktrees do not supersede it. Exact source implementation `f5a295c52e0ac7d18e5a7949217861c7aa74e9c9` uses one strict Browser `screener-v11` boundary and rejects every other wire before room authority. Production remains exact release `2726edd` on v10; v11 is implemented but not deployed.
- Current source implements one Host plus up to `20` Viewers, one steady outbound media-copy cap for every non-server endpoint (default `2`, static `1/2/3`), and the process-memory room model with random four-digit codes, a default 24-hour dormant lease, exact-Host resume, restart loss, local Host preference replay, independent token invitations, `open | password | disabled` code entry, and no SQLite runtime.
- One event-driven controller owns the committed graph and at most one room-serial child operation. It uses one deterministic candidate list/cursor and one total direct-then-SFU deadline; exact admission and physical resources remain charged through drain, and the pending candidate commits only after an exact-generation decoded-frame proof. A short-lived 100 ms stats observer proves only that candidate inside the existing deadline, while the 2-second sampler remains responsible for active-path diagnostics and decoded-frame stalls. Healthy edges remain sticky and current-path quality does not authorize reparenting.
- Ordinary peer ICE is STUN-only and the only application fallback is the dedicated LiveKit SFU over UDP. SFU generations use explicit no-default ingress/egress capacities, exact `reserved | committed | draining` accounting, delete-plus-absence release, one Host publication, and exact Viewer subscription handles. No Screener TURN, ICE/TCP, media TCP, or TLS-relayed media route exists.
- Current source leaves video `contentHint` unset and keeps audio `contentHint = "music"`. Browser direct and browser-relay offers contain VP8 as their only media codec, and SFU publication explicitly uses VP8 with no backup codec. Codec UI, quality state, wire fields, fallback media codecs, and share-lifetime codec branches are absent. Live 64/128/256 kbps audio-ceiling mutation and ordinary `shareGeneration`-fenced Pause/Resume remain unchanged.
- Current source implements typed first-frame Viewer presentation and recovery, Chinese user-facing route/access failures, privacy-safe failed-page export, authenticated Host-only on-demand route snapshots, neutral `ROOM_ACCESS_DENIED` room-code admission, and responsive entry controls.
- Recommended quality remains exactly `1080p60`, `1080p30`, and `720p30`; current source defaults to `1080p30`. Advanced resolution adds `480p` as `854x480` without adding a fourth preset, and advanced FPS and bitrate remain independent.
- Exact v11 source implementation `f5a295c52e0ac7d18e5a7949217861c7aa74e9c9` passed the current automated source gates. It has no deployment or physical direct, browser-relay, or SFU codec evidence; retained v10 loopback evidence applies only to that older source. Exact results are owned by [verification status](./verification-status.md).

## Current Milestone

1. Deploy the validated `screener-v11` fixed-VP8/no-video-hint Browser source atomically, then verify direct, browser-relay, and SFU paths from actual codec stats. Production remains v10 with the pre-share selector and video `motion` until that cutover.
2. Diagnose the reported screen-audio `1 kbps` readout and validate live audio ceilings, then refine the Host invitation controls without changing grant semantics implicitly.
3. Reproduce the Host background/minimized report under controlled conditions while recording the actual negotiated codec.
4. Finish representative ICE/STUN/SFU acceptance including mobile networks. Browser port prediction, NAT classification, TCP probing, fake page keepalive, and quality-driven reparenting remain outside the accepted model.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current Browser milestone and are not built or run.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Room lifetime, authorization/storage semantics, restart loss, entry/presentation, and rollback restoration remain aligned. The source v11 codec contract is intentionally ahead of production v10 until atomic cutover.
- Real SFU recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

There is no active P0/P1 source or deployment hold. The fixed-VP8/no-video-hint v11 source is implemented and source-validated; production remains on the postflight-clean
Browser v10 contract until atomic deployment. Physical v11 direct, browser-relay, and SFU codec evidence, plus audio, heterogeneous-network, SFU,
background, and mobile evidence remains open. Native/executable work and broad repository cleanup
remain outside the current evidence boundary.
