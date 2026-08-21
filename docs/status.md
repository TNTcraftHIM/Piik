# Current Status

Last updated: 2026-08-21

## Phase

Production at `https://share.bonfire.icu` is exact `ecc794d6f01ff8e90cc07a267d221daaac8da9e1`; artifact 951,317 bytes, SHA-256 `22c82d0e06f34abb746ee9e652821deebeea0174643b31ec6e21e159933f5431`.
Cutover: 2,646.166 ms lock/425.531 ms stop-health/364.286 ms switch-health; SQLite v3/five rooms/four active services, observed `NRestarts=0`. Rollback is exact `16f6eab`; `22119b9` remains secondary.
Ordinary ICE is STUN-only; all-room limits are SFU roots <=2 and one `peer-selected` attempt excluding Host ingress; selected UDP TTL is 120. This rollout ran no media canary; earlier exact-`16f6eab` Host-ingress proof remains separate.
Web window/system-audio and music hints, interval A/V loss%, and audio codec/format/bitrate/jitter are deployed. Native stays source-only; Web defaults VP8.

## Execution Principle

Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Snapshot

- Capture precedes room creation; source/quality changes preserve peers, while pause disables audio/video tracks together and keeps connections. Quality defaults to `maintain-resolution` with balanced/fluid options.
- Production access is `screener-v2`: a valid private fragment grant enters directly; every code-only Viewer must first hold site access, after which public-watch accepts the code and private rooms still require their room password. `SITE_ACCESS_PASSWORD`, `/api/site-access`, and the site-access cookie are deployed atomically; raw credentials are never stored.
- Web Hosts can set their local/session display name, and the current release advertises it through the existing presence wire. The name is not an account identity.
- Native v2 is source-only (memory rooms, 300s reclaim); it follows authenticated direct-child assignments up to two and fails unsupported SFU/selected ingress boundedly.
- PR #44's STUN-only/SFU-UDP router and token-free fallback prewarm are process-enabled for all normal rooms: roots <=2, browser relay <=1, bounded failure. Room `1` is historical smoke; mobile/iPad viewers are leaves, healthy edges sticky, and HTTPS/WSS stays TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Production `q,h` is deployed; an exact-source/production-media canary proves active Host ingress without production app/DB.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.
- Web roster, audio picker/music hints, interval A/V loss%, and audio codec/format/bitrate/jitter are deployed.

## Verified Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 quality-change runs kept 2/1 fanout and decoding; slowest first frame was 1.05 seconds and one relay close recovered in 5.32 seconds. This is control evidence only.
- Chrome 151 + local LiveKit 1.13.5/client 2.22.0 SFU/UDP passed after `q,f` -> `q,h`: one root, decoded 3 -> 23, rendered 26, Host edge one, clean leaves, no TURN. Functional only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Chrome 151 browser loopbacks decoded VP8 299 and H.264 opt-in 299/298 rendered at 1280x720 without fatal/encoder errors. Browser hardware attribution, multi-viewer/endurance and public proof remain open; production stays VP8.
- Native WGC/MF used no browser capture/encoder. One Chrome Viewer rendered 203 1280x720 frames and received 500 Opus packets; process/LUID-correlated `VideoEncode` was nonzero, with no fatal/encoder errors.
- Native Win11 audio is source-only/default-off: target isolation was 4018x and one Viewer got 495 Opus packets. Download, game sync, Win10, and other routes remain open.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Native wire/session tests enforce at most two authoritative children, no presence-created edge, stale-revision ignore, and one bounded unsupported-route failure per revision.
- Production caps pending/answered `peer-selected` at one per room; Host ingress is independent. Focused admission/release/rollback/STUN-only tests pass; earlier Chrome proves active Host-ingress function only.
- Host names, Web audio, all-room routing, Host selected ingress and AV/audio diagnostics are active. Retained hidden-tab media counters progressed; audible/mobile proof remains open.
- Exact `ecc794d` passed typecheck, builds and 452 tests. Deploy preserved config/network/SQLite hashes; SQLite v3/five rooms, routes/assets/SiteAccess and four zero-restart services passed. Rollback is `16f6eab`; `22119b9` is secondary.

## Unverified Boundaries

- The `ecc794d` cutover ran no browser/media/TURN canary. Earlier exact-`16f6eab` proof covers active Host ingress only; initial/peer last mile, external cohorts, admission rescue, quality/resources/performance and game blur remain open.
- Mobile is Viewer-only. Its persistent audible media element keeps media/signaling active while the page lives; iOS lock-screen, reclamation and background reconnection remain device gates. AirPlay/system mirroring is local output; live WebRTC `srcObject` has no portable in-app TV-output contract.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer proof; two-edge/FIFO, hardware, endurance, public/downloaded-package, and browser-diversity proof remain open.
- Browser fanout is host two/viewer one; any accepted endpoint relay stays capped at two downstream edges.
- PR #49/#50 BWE is unverified/default-off: test zero-child leaves, then root impact. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- Headful fragment-to-sessionStorage consumption, invitation rotation after migration, and request/log leak inspection remain production UX gates. Accounts stay out.
- Structure debt: split `HybridMediaRouter`, `HostPage`, `SignalingServer`, and `ViewerPage` only at proven consumer boundaries, never by file length.

## Next Milestone

Next: representative production-room UDP/frame/cap/stop canary; room `1` is history. TURN performance follows later.
Recovery uses one ICE restart, one same-parent rebuild, one alternate peer, then SFU. Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root evacuation.
Native WGC/MF passed one-Viewer hardware; package download, Viewer2/FIFO and game A/V remain. Benchmark later.
Ordinary peers stay STUN-only; initial ingress and `peer-selected` still need forced-relay proof.
ADR-0004 still needs the 30-minute `1/3/5/8` matrix; a separate 20-viewer gate must pass before changing the default eight.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Initial deployment region and network cohort.
- Project license and distribution model.
