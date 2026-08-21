# Current Status

Last updated: 2026-08-22

## Phase

Production is exact `27ad90ddf9f85d0a88a7d06fd366461622653649` at `https://share.bonfire.icu`, release `27ad90ddf9f8`, wire `screener-v4`. SQLite v3/five rooms keeps SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner/mode `screener:screener`/0600. Four services and local/public health are green.
Ordinary ICE is STUN-only; limits are SFU roots <=2, one `peer-selected` attempt excluding Host ingress, and selected UDP TTL 120. No browser/media/SFU/TURN/performance canary ran; exact-`16f6eab` Host-ingress proof is separate.
Stable SFU, route/transport truth, preview notice, entry/nickname UI and Web relay cap2 are live. Native is source-only. The controlled production A/B uses browser/LiveKit codec defaults; explicit codec controls are source-complete.

## Execution Principle

Parallel flagship work; use minimum relevant checks and rollback proof. Target-device/production evidence drives performance decisions; ordinary-PC synthetic runs prove only correctness/interoperability. Git owns history; delete no-consumer layers.

## Current Snapshot

- Capture precedes rooms; source/quality changes and AV pause preserve peers. Defaults are balanced and automatic codec; clarity/fluid plus H.264/VP8 stay explicit, with codec locked during a share. Browser degradation and Host SFU A+B remain open.
- Deployed `screener-v4` admits private fragment grants directly; code-only Viewers need site access, and private rooms additionally need their password. Credentials remain unstored. Web presence fields remain opt-in and Native does not subscribe to them.
- Deployed UI has nickname editing, room entry, Viewer roster, duplicate-only ID suffixes, pause notice, and session-bound SFU first-media truth that clears on track/route/session loss. P2P/SFU/TURN labels require evidence. Guarded relay evidence reaches opted-in Web Host rosters without Host-local transport claims or false parent-edge proof.
- Native v4 is source-only (memory rooms, 300s reclaim); it does not subscribe to Web presence, accepts the shared absolute three-child bound, and fails unsupported SFU/selected ingress boundedly. Production still clamps to two.
- Production roots/Web relay <=2; Viewer upstream1. Source parameterizes endpoint cap at default2/range1-3 while SFU roots remain <=2; production stays2. One-root healthy-SFU MBB is deployed/media-unverified; source defers one cooldown ready for expiry reproof. Capacity `0 -> 1`, multi-root and browser gates remain open. Room `1` is historical; HTTPS/WSS is TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- C+B is uncalibrated. Production compares relay-child FPS with fresh parent input and tries peers only. Source lets two confirmed children pause one Viewer relay for 30s and peer-only reassign its children; no candidate keeps old edges. Not deployed; admission rescue remains deterministic.
- Source-only `screener-v5` selected-TURN work separates immutable grant revision from current route authority and parameterizes endpoint cap default2/range1-3: unrelated revisions may carry only the same in-budget edge, while topology/session/share/budget loss revokes it before active authority. Browser and production proof remain open.

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
- Exact `6ccb516a` passed typecheck/build/hygiene and 32/489; deploy gates preserved artifacts, config/nft/DB, zero shared inodes and four zero-restart services. No browser/media/SFU/TURN/performance canary ran.

## Unverified Boundaries

- The `6ccb516a` cutover ran no browser/media/SFU/TURN/performance canary. Earlier `16f6eab` proof covers Host ingress only; healthy reselection, audible quality, last mile, external cohorts, resources/performance and game blur remain open.
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
Recovery: ICE restart -> same parent -> alternate peer -> SFU. Source-only manual recovery keeps the route: peer restarts; SFU reauth rebuilds its subscriber. Next: exactly-two/Dynacast-off zero-child SFU BWE, then evacuation.
Native WGC/MF passed one-Viewer hardware; package download, Viewer2/FIFO and game A/V remain. Use representative target-device or production evidence for performance, not an ordinary-PC synthetic gate.
Ordinary peers stay STUN-only; initial ingress, `peer-selected`, and healthy-reselection browser gates remain open.
ADR-0004 still needs its resource/quality matrix; the 20-viewer gate precedes a default change. Mobile uses the same capacity and is a compatibility observation.
Screen-audio candidate disables Chromium speech APM and prefers stereo before 128 kbps peer/SFU; verify Host settings and direct routes.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Initial deployment region and network cohort.
- Project license and distribution model.
