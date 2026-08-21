# Project Memory

Last updated: 2026-08-21

## Confirmed Intent

- Build low-latency game sharing for one broadcaster and trusted friends; public or large broadcasts belong on OBS/Twitch-class services.
- Browser first. Viewers use desktop/mobile Web; an optional sender requires a proven browser capability gap.
- Use a small central service for access, rooms, signaling, deterministic topology, STUN, observability, and bounded SFU-root capacity.
- Minimize server bandwidth. Ordinary peer ICE is STUN-only. Failure tries restart, rebuild, alternate peer and bounded SFU/UDP roots; only then may the controller authorize short-lived TURN for one selected exceptional edge before clear failure. TURN is transport, not topology.
- The current release budget is two downstream edges per non-server node, including ordinary Web relays; upstream receive is free and UA/visibility do not change it. SFU normally feeds one or two roots that retain peer descendants; separately capped server edges may serve exceptional viewers that cannot attach behind a healthy root. A future evidence-driven tier may change the ceiling only through the owning requirement and design.
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
- Production Web prefers H.264 through standard ordering, keeps the browser fallback list, and requests SFU H.264 with `backupCodec=false`; VP8 is used only when H.264 is unavailable. This is not a second encoder stack or shared-encode proof. ADR-0006's browser bridge remains no-go.
- Mobile endpoints are Web Viewer-only. Current Android/iOS browsers do not expose Web Host capture; AirPlay/system mirroring is Viewer-local output.
- ADR-0005: direct/peer UDP -> bounded SFU roots -> selected-edge TURN. The deployed controller caps pending/answered `peer-selected` at one per room; Host ingress is independent. A pre-`ecc794d` exact-source/production-media canary proves active Host ingress only. Ordinary peers stay STUN-only.
- `PEER_ASSISTED_MEDIA=true` enables isolated all-room controllers; room `1` is historical. Keep sticky P2P and one recovery attempt per layer. Deployed healthy-SFU MBB covers one root and retained parent after reauth/recovery, gated by media proof, Host2/browser1 overlap and cooldown. It excludes `peer-selected`; active-SFU loss aborts into normal recovery. Capacity `0 -> 1`, multi-root and browser gates remain open.
- C+B quality reparenting is edge-local and cooldown-bound; no score, timer, or global parent penalty.
- Flagship media is UDP; HTTPS/WSS stays TLS/TCP; the old release remains rollback-only.
- Treat settings as ceilings and degradation as unclassified. Use correlated Host A+B/Viewer C and one-variable evidence; never force AV1, infer by UA, or create a composite score.
- Web window/system-audio requests are browser hints; tracks use `music`. P2P/relay/SFU senders request 128,000 bit/s and SFU disables DTX; this is a ceiling, not a quality/stereo guarantee. Native Win11 process audio stays source-only; one Viewer got 495 Opus packets.
- Presence reports exact active upstream and feeds Host topology; it does not prove media. Status and details stay neutral until local/current media evidence, then label P2P/SFU and actual TURN; append its protocol only from local relay stats. Web Host names stay socket/localStorage-only; Native remains outside the boundary.
- Do not add scene detection, dynamic-FPS control, or forced AV1 without negotiation, encode, game, CPU/GPU, and sender evidence.
- ADR-0002 grant/public access, the v3 room-password migration, and Web Host display names are deployed. Names/presence remain session-only without account or roster tables.

## Current Execution Principle

- Parallel flagship work; minimum relevant checks and rollback proof. Research plus target-device/production evidence drives product choices; synthetic runs cover only correctness/interoperability. Active text is current, Git owns history, and no-consumer layers are deleted.

## Current Implementation

- The repository is one npm package using Node.js 24, React, TypeScript, Vite, native WebRTC, `ws`, Zod, Vitest, and separate coturn.
- Production is exact `6ccb516a47261054f91dfa2fafa408d39ced59fc`; source/dist artifacts are 619,674/358,621 bytes, with hashes in deployment; cutover 2,048 ms lock/1,272 ms stop-health/888 ms switch-health; rollbacks `1331fbdd`, `261e980`, `691863e`.
- Web keeps one SFU stream, clears unavailable video, exposes evidence-backed routes/transports and paused preview, and drops signals to a grace-retained offline current-edge target. Routing is automatic; entry/nickname UI is live; Native remains source-only.
- Web relay is cap2 with one upstream; child3 rejects and no UA/visibility split exists.
- Four services are active/running at `NRestarts=0`; local/public health are 200. SQLite v3 has five rooms, SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner/mode `screener:screener`/0600.
- Production keeps ordinary ICE STUN-only, SFU roots <=2, selected-edge UDP TTL 120, and one pending/answered `peer-selected` attempt per room excluding Host ingress. This rollout ran no browser/media/SFU/TURN/performance canary; earlier exact-`16f6eab` evidence proves active Host ingress only.
- Production requires independent `SITE_ACCESS_PASSWORD`: its stateless cookie authorizes creation/Host and code-only Viewer attempts; private grants stay direct, while public/private code entry needs site access alone/plus room password. Env/endpoint/cookie/nginx naming migrated atomically; failures remain neutral; there are no accounts/JWT/session rows. Local `gate:access-privacy` proves fragment isolation, site/grant transport-log absence, and raw room-password SQLite absence; room-password WebSocket/log ingress and live/headful evidence remain open.
- Production uses nginx, Node.js 24.19.0, coturn 4.17.2, and LiveKit 1.13.5 on UDP 7882 (TCP fallback off). Ordinary peer ICE receives no TURN; the selected-edge tuple is configured only for the current controller edge, with no credential pre-advertised to ordinary peers. Coturn retains the old authenticated-relay ports. Services are healthy with zero restarts.
- ADR-0005 rejects `PEER_ASSISTED_ROOM_IDS`; `PEER_ASSISTED_MEDIA=true` enables every room and ordinary peers stay STUN-only. Initial or active Host ingress may consume one bound relay-only grant; ready/abort clears it and failure restores peer baseline. Stale room-ID config fails startup; `screener-v2` is the only deployed wire.
- Web SFU uses LiveKit 2.22.0 `q,h`; local SFU/UDP and selected-TURN ingress work, while BWE remains open. P2P now reapplies its selected profile after each answer on the same sender. A local A/B supports the lifecycle candidate, but natural ramp, real capture, production, and SFU validation remain open.
- Chrome 151 five-Viewer 720p30 cap2 evidence: Host/relay fanout two; both relay children +80 decoded frames/~1.1 MB; every Viewer decoded; clean stop. Functional only; resource and heterogeneous-network behavior remain open.

## Provisional Quality Targets

- Controlled direct path at RTT no more than 40 ms and loss no more than 1%: glass-to-glass p50 no more than 150 ms and p95 no more than 250 ms.
- Regional SFU/UDP roots under the same endpoint conditions: glass-to-glass p95 no more than 350 ms; optional TURN is measured separately.
- First picture within 3 seconds after a watch request, excluding explicit permission time.
- A 60 fps profile must not remain below 50 decoded fps for more than 5 seconds without a visible downgrade or limiting reason.

These are measurement gates, not performance claims.

## Open Decisions

- Sustainable count by hardware, quality, network, and route: finish instrumented `1/3/5/8`, then pass a 20-viewer matrix before changing the accepted target default to 20.
- Whether ADR-0004 passes re-encoding, depth-three/eight-viewer latency, reparenting, silent-partition, and representative resource gates.
- Selected-edge: active Host-ingress function passes; initial ingress, `peer-selected`, expiry/failure, mobile, resource and bandwidth gates remain. The bearer is non-revocable until expiry; performance follows later and Media TCP is out.
- Exact mobile Viewer lifecycle behavior across autoplay, rotation, iOS lock-screen/page reclamation, background reconnection and network changes.
- Project license and distribution model, which determines whether GPL/AGPL sources can move beyond study-only use.
- Initial deployment regions and expected mainland China, Hong Kong, and overseas network mix.
- Whether voice chat ever enters scope or Screener stays complementary to an existing voice application.
- Production calibration of reparent thresholds and any adaptive codec policy. Hardware attribution gates claims, not H.264 preference; #28's minimum-of-two rule is not a candidate.

## Source Of Truth

- Current phase is in `docs/status.md`; requirements/design, ADRs, research, deployment and maintenance are indexed by `docs/README.md`.
