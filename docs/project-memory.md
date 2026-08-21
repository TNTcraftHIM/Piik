# Project Memory

Last updated: 2026-08-22

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Browser first. Viewers use desktop/mobile Web; an optional sender requires a proven browser capability gap.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity.
- Minimize server bandwidth. Ordinary peer ICE is STUN-only. Failure tries restart, rebuild, alternate peer and bounded SFU/UDP roots; only then may the controller authorize short-lived TURN for one selected exceptional edge before clear failure. TURN is transport, not topology.
- Current release policy is Host2/ordinary Browser Viewer1. Server authority derives the limit from authenticated role; old or malicious Viewer advertisements 2/3 remain effective1. Deployment config defaults to two and accepts only 1/2 to tighten, never lift, these limits. Web assignment execution independently truncates physical children to Host2/Viewer1 as defense-in-depth. Active/provisional/selected physical overlays count, as does Host SFU publication; ordinary upstream receive is free. A deployment limit of one promotes an occupied Host branch root before reserving its SFU publication slot. UA/visibility do not change capacity. SFU normally feeds one or two roots that retain peer descendants; its root cap remains separate. Dynamic evidence-driven capacity still requires its own acceptance.
- Two-tree packet/layer striping may reduce endpoint upload toward one stream bitrate, but needs a bounded multi-parent, loss, sync, churn, and latency experiment; it is not in the current full-stream chains.
- Direct/peer keeps per-PC stock GCC. Active SFU publishes exactly `q,h` at a `HIGH` ceiling; built-in BWE may forward `LOW`. The zero-descendant quality/resource gate is next; if it passes, no app media selector is built. Explicit quality, manual activation, and custom/native remain fallbacks.
- A later explicit quality fallback evacuates children under a generation guard first. Autonomous BWE enters `suspect`; confirmation evacuates children, and no confirmed `FALLBACK` parent remains. Root-with-children impact is a default-on gate; capacity returns after longer recovery plus cooldown. Self-report alone never triggers it.
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
- ADR-0005: direct/peer UDP -> bounded SFU roots -> selected-edge TURN. The deployed controller caps pending/answered `peer-selected` at one per room; Host ingress is independent. A pre-`ecc794d` exact-source/production-media canary proves active Host ingress only. Ordinary peers stay STUN-only.
- `PEER_ASSISTED_MEDIA=true` covers all rooms. One-root healthy-SFU MBB is deployed with retained parent, media proof, Host2/browser1 overlap, cooldown and fresh two-window proof; it excludes `peer-selected`. Active-SFU loss uses normal recovery; the manual control keeps its route: peer restarts its edge, SFU reauthenticates signaling and rebuilds that subscriber. Capacity `0 -> 1`, multi-root/browser gates remain open.
- C+B stays edge-local: deployed MBB gives only the triggering child one attempt to an ordinary Viewer whose active upstream is peer or SFU while its old edge remains active; Host remains excluded. Current-generation RTP, decoded frames, and live video atomically promote the same provisional PC. A ready-then-failed identity survives until active/rollback, while session/share change or an unrelated authoritative failure aborts the soft probe. Failure, timeout, or no candidate keeps the old edge without SFU/TURN. Sibling MBB remains separate. No score.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Screen audio: production Web capture requests speech processing off and ideal stereo. Share advanced settings offer 64/128/256 kbps sender ceilings, default 128, and lock the choice for the active share across P2P, browser relay, and SFU. Peer answers permit stereo up to 256 kbps; SFU keeps `forceStereo`, DTX off, and RED retained. Local Viewer details expose non-uploaded A/V playout, jitter-buffer, and concealment evidence. Target-browser/route proof remains open; voice and Native stay separate.
- Presence reports active upstream for topology; assignment alone never proves media. A Web SFU Viewer becomes connected only after session-bound first media; track/route/session loss clears it. Status/details stay neutral until current P2P/SFU/TURN evidence. Names stay socket/localStorage-only; Native remains outside.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access, the v3 room-password migration, and Web Host display names are deployed. Names/presence remain session-only without account or roster tables.

## Current Execution Principle

- Parallel flagship work; minimum relevant checks and rollback proof. Research plus target-device/production evidence drives product choices; synthetic runs cover only correctness/interoperability. Active text is current, Git owns history, and no-consumer layers are deleted.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production: exact `93e4681915768db0bf3b0165c0fd9ec3f54f95c8`, release `93e468191576`, Web wire `screener-v5`; `66eb33717193` is the rollback release.
- Web keeps one SFU stream, clears unavailable video, exposes evidence-backed routes/transports and paused preview, and drops signals to a grace-retained offline current-edge target. Routing is automatic; entry/nickname UI is live; Native remains source-only.
- Production rooms default to eight Viewers and accept an explicit admission limit from one through sixteen. The deployed older release uses Web cap2; current source is Host2/ordinary Browser Viewer1 and accepts deployment 1/2 only as further tightening, without a UA/visibility split. The unchanged `0/1/2/3` relay-capacity wire is a future envelope, not current authority.
- Relay evidence is opt-in; direct proof and selected-pair addresses stay local, never in relayed evidence. The deployed pre-share self-check uses disposable health/WSS/STUN probes and reports configured SFU as unverified until a real route. Click-only diagnostic JSON uses a fixed privacy allowlist; neither path uploads or persists a report.
- `screener`, LiveKit, coturn, and nginx are active; `screener` has `NRestarts=0`, local/public health are 200, and the endpoint-cap environment is unset so the parameterized default is two. SQLite v3 has five rooms, SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner/mode `screener:screener`/0600.
- Production keeps ordinary ICE STUN-only, SFU roots <=2, selected-edge UDP TTL 120, and one pending/answered `peer-selected` attempt per room excluding Host ingress. A post-deploy no-room browser self-check passed health, unauthenticated WSS open/close, and STUN `srflx` gathering without exposing candidate data; room media, SFU, TURN, and performance remain unverified. Earlier exact-`16f6eab` evidence proves active Host ingress only.
- Production requires independent `SITE_ACCESS_PASSWORD`: its stateless cookie authorizes creation/Host and code-only Viewer attempts; private grants stay direct, while public/private code entry needs site access alone/plus room password. Env/endpoint/cookie/nginx naming migrated atomically; failures remain neutral; there are no accounts/JWT/session rows. Local `gate:access-privacy` proves fragment isolation, site/grant transport-log absence, and raw room-password SQLite absence; room-password WebSocket/log ingress and live/headful evidence remain open.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and LiveKit 1.13.5 on UDP 7882 (TCP fallback off). Ordinary peer ICE receives no TURN; the selected-edge tuple is configured only for the current controller edge, with no credential pre-advertised to ordinary peers. Coturn retains the old authenticated-relay ports. Services are healthy with zero restarts.
- ADR-0005 rejects `PEER_ASSISTED_ROOM_IDS`; `PEER_ASSISTED_MEDIA=true` enables every room and ordinary peers stay STUN-only. Initial or active Host ingress may consume one bound relay-only grant; ready/abort clears it and failure restores peer baseline. Stale room-ID config fails startup. Production and source-only Native use `screener-v5`; Native does not subscribe to Web presence.
- Defaults are balanced with automatic codec and 128 kbps screen audio; clarity/fluid, H.264/VP8, and 64/128/256 kbps audio remain explicit. Codec and audio quality are locked during a share. LiveKit 2.22.0 SFU uses `q,h`; production exposes one Host-local current-`h` A+B snapshot and clears it on publisher identity changes. Target-browser field availability, actual media values, BWE, and route observation remain open.
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
