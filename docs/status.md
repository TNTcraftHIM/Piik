# Current Status

Last updated: 2026-08-21

## Phase

Production at `https://share.bonfire.icu` is exact `1331fbddb59fc2b0b99ba9e5ee4848768ae907c8`; immutable source/dist artifacts are 606,386/355,113 bytes, with hashes in deployment.
Cutover: 848.008 ms lock/626.778 ms stop-health/560.282 ms switch-health. SQLite v3/five rooms has SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner/mode `screener:screener`/0600. Four services are active/running at `NRestarts=0`; rollbacks are `261e980`, then `691863e` and `6634cb9`.
Ordinary ICE is STUN-only; limits are SFU roots <=2, one `peer-selected` attempt excluding Host ingress, and selected UDP TTL 120. This rollout ran no browser/media/SFU/TURN/performance canary; earlier exact-`16f6eab` Host-ingress proof remains separate.
Stable SFU, route/transport truth, preview notice, entry/nickname UI and Web relay cap2 are live. Native is source-only. Production prefers H.264 with negotiated VP8 fallback.

## Execution Principle

Parallel flagship work; minimum relevant checks and rollback proof. Research plus target-device/production evidence drives performance decisions; ordinary-PC synthetic runs prove only correctness/interoperability. Active text is current; Git owns history; delete no-consumer layers.

## Current Snapshot

- Capture precedes room creation; source/quality changes and AV pause preserve peers. Recommended profiles and advanced defaults use `balanced`; clarity/fluid remain explicit. P2P reapplies the selected profile after each answer on the same sender; the browser still owns degradation and stats/readback expose it.
- Production `screener-v2` admits private fragment grants directly. Code-only Viewers need site access, then public rooms accept the code while private rooms also require their password. `SITE_ACCESS_PASSWORD`, `/api/site-access`, and its cookie are deployed atomically; raw credentials are never stored.
- Source UI uses adjacent nickname editing, distinct site/room prompts, and a shared room-code form. Status and details stay neutral before media proof; current evidence labels green P2P/yellow `SFU fallback`, while relay evidence adds `TURN` plus only a locally observed protocol.
- Native v2 is source-only (memory rooms, 300s reclaim); it follows authenticated direct-child assignments up to two and fails unsupported SFU/selected ingress boundedly.
- Production is roots/Web relay <=2; every Viewer has one upstream and rejects child3. One-root healthy-SFU MBB is source-only, not deployed; capacity `0 -> 1`, multi-root and browser gates remain open. Room `1` is historical; HTTPS/WSS is TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.

## Verified Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 runs kept bounded fanout/decoding. A five-Viewer cap2 run had one relay serve two children (+80 decoded frames/~1.1 MB each), all decoded and no fatal. Functional only.
- Chrome 151 + local LiveKit 1.13.5/client 2.22.0 SFU/UDP passed after `q,f` -> `q,h`: one root, decoded 3 -> 23, rendered 26, Host edge one, clean leaves, no TURN. Functional only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Chrome 151 loopback proves H.264 negotiation/decode interoperability, not performance. Production orders H.264 first and keeps browser repair/fallback codecs.
- Native WGC/MF used no browser capture/encoder. One Chrome Viewer rendered 203 1280x720 frames and received 500 Opus packets; process/LUID-correlated `VideoEncode` was nonzero, with no fatal/encoder errors.
- Native Win11 audio is source-only/default-off: target isolation was 4018x and one Viewer got 495 Opus packets. Download, game sync, Win10, and other routes remain open.
- Local gate proves pre-DOM fragment clearing, room-scoped session isolation, no site/grant transport-log hits, and no raw room-password SQLite sentinel; rotate/revoke tests pass. Headless loopback only.
- Native wire/session tests enforce at most two authoritative children, no presence-created edge, stale-revision ignore, and one bounded unsupported-route failure per revision.
- Production caps pending/answered `peer-selected` at one per room; Host ingress is independent. Focused admission/release/rollback/STUN-only tests pass; earlier Chrome proves active Host-ingress function only.
- Exact `1331fbdd` passed typecheck/build/hygiene and 32/473; deploy gates preserved runtime, artifacts, config/nft/DB hashes and four zero-restart services. Healthy-reselection source passed the same local gates and 32/489; no browser/deploy ran.

## Unverified Boundaries

- The `1331fbdd` cutover ran no browser/media/SFU/TURN/performance canary. Earlier `16f6eab` proof covers Host ingress only; audible quality, last mile, external cohorts, admission rescue, resources/performance and game blur remain open.
- Mobile is Viewer-only. Its persistent audible media element keeps media/signaling active while the page lives; iOS lock-screen, reclamation and background reconnection remain device gates. AirPlay/system mirroring is local output; live WebRTC `srcObject` has no portable in-app TV-output contract.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- Production startup blur remains open. One local Chrome synthetic same-`balanced` A/B kept route/PC/SSRC/track and coincided with 720p -> 1080p without loss/freeze, but natural ramp prevents causal, production, or SFU proof.
- ADR-0006 has one Viewer proof; two-edge/FIFO, hardware, endurance, public/downloaded-package, and browser-diversity proof remain open.
- Production fanout is Host2/Viewer2 and rejects child3. Relay resource behavior remains open.
- Active SFU already publishes `q,h`; only BWE/resource/zero-child/root gates are unverified. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- Access lacks headful/production proof for fragment consumption, rotate/revoke and request/nginx/journal/SQLite leakage; its source gate is loopback-only. No accounts.
- Split large modules only at proven consumer boundaries, never by file length.

## Next Milestone

Next: representative production-room UDP/frame/cap/stop canary; room `1` is history. TURN performance follows later.
Recovery uses one ICE restart, one same-parent rebuild, one alternate peer, then SFU. Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root evacuation.
Native WGC/MF passed one-Viewer hardware; package download, Viewer2/FIFO and game A/V remain. Use representative target-device or production evidence for performance, not an ordinary-PC synthetic gate.
Ordinary peers stay STUN-only; initial ingress, `peer-selected`, and healthy-reselection browser gates remain open.
ADR-0004 still needs its resource/quality matrix; the 20-viewer gate precedes a default change. Mobile uses the same capacity and is a compatibility observation.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Initial deployment region and network cohort.
- Project license and distribution model.
