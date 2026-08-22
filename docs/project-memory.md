# Project Memory

Last updated: 2026-08-22

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Browser first. Viewers use desktop/mobile Web; an optional sender requires a proven browser capability gap.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded fallback resources without turning the product into public or always-central streaming.
- Minimize server bandwidth. Ordinary peer ICE is STUN-only, and TURN remains optional selected compatibility transport rather than a topology. The exact SFU publication/subscription model, TURN placement, fallback order, and transitional resource accounting are on [truth-audit hold](./todo-audit-hold.md); earlier root, lease, or edge-count wording is not implementation authority.
- Every non-server endpoint has one server-authoritative downstream capacity, default `2` and configurable as `1`, `2`, or `3`; upstream receive is excluded, Browser role/UA/visibility does not define a separate tier, and a client cannot advertise above the deployment value. Production `9461e20` still implements the disputed Browser1/config-1-or-2 behavior; keep that divergence as a dated implementation fact until the holistic routing model is accepted and migrated.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Direct/peer keeps per-PC stock GCC. Production currently disables SFU Dynacast, publishes `q,h`, and starts each subscriber at a `HIGH` ceiling; the fixed root and Host-publication accounting wrapped around that path are disputed policy, while generation isolation, current authorization, and actual packet/resource evidence remain valid review inputs.
- Proposed SFU quality evacuation and recovery rules remain research inputs, not executable TODOs, until the routing truth audit decides their current consumer and ownership.
- Site access protects room creation, Host publication, and every code-only Viewer entry. A valid room-scoped fragment grant bypasses that site gate; otherwise site access is checked before public-watch or a private room password. Persist neither raw credential; keep accounts, ACLs, users, and session tables out.
- Prefer primary sources, maintained implementations, target-device evidence and sanitized production stats. Ordinary-PC synthetic runs prove only correctness/interoperability; never use them to calibrate performance or block a reversible standard API. Keep accepted truth in Git and replace stale facts in place.
- Migrate client, server, and deployment atomically. After a canary, delete superseded config/wire/parsers/tests; do not retain compatibility layers, dual writes, or a second architecture without a current consumer. Git history owns the old implementation.
- Deploy after narrow tests, independent review, one local full gate, and rollback preflight. Build/test off the 960 MiB production host; prepare audited dist with one bounded production install. Actions remain for a necessary main/release gate only.

## Current Recommendation

- Keep desktop Chrome/Edge and the responsive Web viewer as the baseline. Observe Android Chrome and iOS Safari compatibility without assigning a separate relay-capacity class.
- Keep Viewer playback on one persistent, user-started audible media element while hidden. Continuity evidence uses media/connection counters; hidden video composition is presentation-only, and iOS lock-screen, reclamation and background reconnection remain device gates.
- Use direct host P2P for one or two viewers, then the bounded controller for every room when `PEER_ASSISTED_MEDIA=true`. Room `1` is historical smoke, not a runtime gate; resource, quality, recovery, SFU/UDP, bounded-failure, and browser/mobile evidence remain separate.
- Browser relays resend remote `MediaStreamTrack` values and re-encode at each hop; WebRTC does not guarantee a shared encoder across peer connections, so measure the cost.
- Keep experiments bounded: the standard representation sequence is below; native RTP relay, encoded-object striping, and FEC remain separate.
- Web defaults to browser/LiveKit codec negotiation; advanced settings offer Automatic, H.264, or VP8 for the next share while retaining fallback codecs and `backupCodec=false`. A codec choice neither proves hardware encoding nor shared encode. ADR-0006's browser bridge remains no-go.
- Mobile endpoints are Web Viewer-only. Current Android/iOS browsers do not expose Web Host capture; AirPlay/system mirroring is Viewer-local output.
- Keep automatic P2P-first routing, one authoritative upstream per Viewer, exact session/share/revision/generation authorization, bounded failure, and media-proven make-before-break. Capacity, canonical SFU publication/subscription, selected TURN, fallback order, and temporary resource leases must now be reconciled as one holistic model before another routing implementation change.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Screen audio: production Web capture requests speech processing off and ideal stereo. Share advanced settings offer 64/128/256 kbps sender ceilings, default 128, and lock the choice for the active share across P2P, browser relay, and SFU. Peer answers permit stereo up to 256 kbps; SFU keeps `forceStereo`, DTX off, and RED retained. Local Viewer details expose non-uploaded A/V playout, jitter-buffer, and concealment evidence. Target-browser/route proof remains open; voice and Native stay separate.
- Presence reports active upstream for topology; assignment alone never proves media. A Web SFU Viewer becomes connected only after session-bound first media; track/route/session loss clears it. Status/details stay neutral until current P2P/SFU/TURN evidence. Names stay socket/localStorage-only; Native remains outside.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access, the v3 room-password migration, and Web Host display names are deployed. Names/presence remain session-only without account or roster tables.

## Current Execution Principle

- Durable truth precedes action: reconcile each discussion or correction against the whole product model, challenge conflicts, update all affected owning truth and current snapshots, and create a Git checkpoint before implementation or implementation sub-agents begin. Unresolved semantics enter a truth hold instead of code.
- While the 2026-08-22 truth audit is open, load [the TODO audit hold](./todo-audit-hold.md) before selecting work. Old checkboxes, branch names, agent suggestions, experiments, and post-boundary follow-ups are inputs, not authorization.
- Current phase order is fixed: reconcile TODO provenance/current truth; schedule archives and workspace disposition; merge the audit guard and restore canonical `main`; then produce a holistic routing held proposal. Report that organized state and proposal to the user before accepting route semantics or resuming any remaining TODO.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production: exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, Web wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- Web keeps one SFU stream, clears unavailable video, exposes evidence-backed routes/transports and paused preview, and drops signals to a grace-retained offline current-edge target. Routing is automatic; entry/nickname UI is live; Native remains source-only.
- Production rooms default to eight Viewers and accept an explicit admission limit from one through sixteen. The deployed release is Host2/ordinary Browser Viewer1 and accepts deployment 1/2 only as further tightening, without a UA/visibility split. The unchanged `0/1/2/3` relay-capacity wire is a future envelope, not current authority.
- Relay evidence is opt-in; direct proof, selected-pair addresses, and bounded same-pair STUN-response counters stay local, never in relayed evidence. Production keeps identity-bound remote-evidence detail shells stable, expires each field five seconds after its own last observation, and excludes stale presentations from export. The deployed pre-share self-check uses disposable health/WSS/STUN probes and reports configured SFU as unverified until a real route. Click-only diagnostic JSON uses a fixed privacy allowlist; neither path uploads or persists a report.
- `screener`, LiveKit, coturn, and nginx are active; `screener` has `NRestarts=0`, local/public health are 200, and the endpoint-cap environment is unset so effective capacity is Host2/ordinary Browser Viewer1. SQLite v3 has five rooms, SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner/mode `screener:screener`/0600.
- Production keeps ordinary ICE STUN-only, SFU roots <=2, selected-edge UDP TTL 120, and one `peer-selected` lease per room excluding Host ingress. Release `9461e20` deploys the root invariant, `dynacast: false`, Host-parent provisional probing, the authenticated Web signaling-partition watchdog, and stable relayed-detail presentation. Real shaped LiveKit media, BWE, resource, SFU, TURN, and broader performance evidence remain open. Release `21d5cd9f7139` is retained for rollback. Earlier exact-`16f6eab` evidence proves active Host ingress only.
- Production requires independent `SITE_ACCESS_PASSWORD`: its stateless cookie authorizes creation/Host and code-only Viewer attempts; private grants stay direct, while public/private code entry needs site access alone/plus room password. Env/endpoint/cookie/nginx naming migrated atomically; failures remain neutral; there are no accounts/JWT/session rows. Local `gate:access-privacy` proves fragment isolation, site/grant transport-log absence, and raw room-password SQLite absence; room-password WebSocket/log ingress and live/headful evidence remain open.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and LiveKit 1.13.5 on UDP 7882 (TCP fallback off). Ordinary peer ICE receives no TURN; the selected-edge tuple is configured only for the current controller edge, with no credential pre-advertised to ordinary peers. Coturn retains the old authenticated-relay ports. Services are healthy with zero restarts.
- ADR-0005 rejects `PEER_ASSISTED_ROOM_IDS`; `PEER_ASSISTED_MEDIA=true` enables every room and ordinary peers stay STUN-only. Initial or active Host ingress may consume one bound relay-only grant; ready/abort clears it and failure restores peer baseline. Stale room-ID config fails startup. Production and source-only Native use `screener-v5`; Native does not subscribe to Web presence.
- Defaults are balanced with automatic codec and 128 kbps screen audio; clarity/fluid, H.264/VP8, and 64/128/256 kbps audio remain explicit. Codec and audio quality are locked during a share. LiveKit 2.22.0 SFU explicitly disables Dynacast and uses ordered active `q,h`; the deployed gate rejects root3, charges the Host publication edge, and retains a zero-child root/subscription. Production exposes one Host-local current-`h` A+B snapshot and clears it on publisher identity changes. Target-browser field availability, actual media values, shaped BWE/resources, and route observation remain open.
- Chrome 151 local functional evidence includes five-Viewer capacity-two and sixteen-Viewer cap2/cap3 runs. These are retained historical experiments, not release policy. All Viewers decoded, and a ten-second follow-up recorded guarded sender and aggregate Chromium CPU evidence, but resolution/FPS stayed low and the same-machine ordinary-PC runs do not rank caps or close resource, visual-quality, endurance, heterogeneous-network, or 20-viewer gates.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional SFU/UDP roots under the same endpoint conditions: glass-to-glass p95 no more than 350 ms; optional TURN is measured separately.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable count by hardware, quality, network, and route: finish instrumented `1/3/5/8`, then pass a 20-viewer matrix before changing the accepted target default to 20.
- Whether ADR-0004 passes re-encoding, depth-three/eight-viewer latency, reparenting, silent-partition, and representative resource gates.
- Selected-edge: Host ingress works; initial ingress, `peer-selected`, expiry/failure, mobile/resource/bandwidth gates remain. Coturn bearer lasts to expiry; the app lease ends on edge/session/share/budget loss. Media TCP is out.
- Exact mobile Viewer lifecycle behavior across autoplay, rotation, iOS lock-screen/page reclamation, background reconnection and network changes.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.
- Production calibration of reparent thresholds and any adaptive codec policy. Hardware attribution gates claims, not H.264 preference; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Current phase is in `docs/status.md`; requirements/design, ADRs, research, deployment and maintenance are indexed by `docs/README.md`.
