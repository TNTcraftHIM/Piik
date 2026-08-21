# Current Status

Last updated: 2026-08-21

## Phase

Production at `https://share.bonfire.icu` is exact `6634cb9fca8278b44d57e5fcddcbaf9f0dc9b137`; artifact 957,434 bytes, SHA-256 `89ff05dbd4d642ed8364a1e230b26b6f4e1dab5a879a0d40a14364e3a26a5cf7`.
Cutover: 2,755.457 ms lock/551.381 ms stop-health/478.335 ms switch-health. SQLite v3/five rooms has SHA-256 `aef724ae52c4107be8ec8791e72f8dcaa11b0ec849fb432d022e2cfb9cfe0974`, owner/mode `screener:screener`/0600. Four services are active/running at `NRestarts=0`; rollbacks are `ecc794d`, then `16f6eab` and `22119b9`.
Ordinary ICE is STUN-only; limits are SFU roots <=2, one `peer-selected` attempt excluding Host ingress, and selected UDP TTL 120. This rollout ran no browser/media/SFU/TURN/performance canary; earlier exact-`16f6eab` Host-ingress proof remains separate.
SFU Viewers use LiveKit state/stats, not P2P waiting/ICE-unknown placeholders; details label P2P/SFU and TURN only for an actual relay. Exact topology, a 128,000 bit/s audio ceiling and `balanced` defaults are deployed. The ceiling is not a quality/stereo guarantee. Native stays source-only; Web defaults VP8.

## Execution Principle

Flagship; parallel; min run/smoke/rollback; benchmark later. Active UI/config/logs/comments=current; history/migration=`historical`; ship reverse-scan visible copy->source; drop no-consumer layer; copy masks no wrong model.

## Current Snapshot

- Capture precedes room creation; source/quality changes and AV pause preserve peers. Recommended profiles and advanced defaults use `balanced`; clarity/fluid remain explicit. The browser chooses degradation; readback/stats report actual behavior.
- Production access is `screener-v2`: a valid private fragment grant enters directly; every code-only Viewer must first hold site access, after which public-watch accepts the code and private rooms still require their room password. `SITE_ACCESS_PASSWORD`, `/api/site-access`, and the site-access cookie are deployed atomically; raw credentials are never stored.
- Source UI uses adjacent nickname editing, distinct site/room prompts, and a shared room-code form; production still has the prior UI. Exact upstream may label green P2P/yellow `SFU fallback` before media proof; connected status still needs evidence and TURN stays actual-only.
- Native v2 is source-only (memory rooms, 300s reclaim); it follows authenticated direct-child assignments up to two and fails unsupported SFU/selected ingress boundedly.
- Production is roots <=2/Web relay <=1; source gives every Web Viewer cap2, one upstream and bounded sticky recovery. Room `1` is historical; HTTPS/WSS is TLS/TCP.
- After an answer, a generation-bound 15s initial-connect deadline enters ICE restart; success/replacement/disposal cancels it. It is deployed but not mobile-verified.
- Room `1` C+B reparenting remains uncalibrated. Deployed admission rescue promotes an unassigned one-slot relay over the oldest childless zero-capacity Host leaf, with no scores or periodic optimization.

## Verified Evidence

- Chrome 151 synthetic `1/3/5/8` and 720p30 runs kept bounded fanout/decoding. A five-Viewer cap2 run had one relay serve two children (+80 decoded frames/~1.1 MB each), all decoded and no fatal; local typecheck, 31 files/458 tests and both builds pass. Functional only.
- Chrome 151 + local LiveKit 1.13.5/client 2.22.0 SFU/UDP passed after `q,f` -> `q,h`: one root, decoded 3 -> 23, rendered 26, Host edge one, clean leaves, no TURN. Functional only.
- Host A+B and authenticated P2P Viewer C are sanitized, generation-bound, read-only, and fail closed for stale, ambiguous, or SFU-fed evidence; no raw media metadata is retained.
- The `a11a73d` built-in TURN canary is rejected: local allocation passed, but direct Host/Pion Viewer failed before forced relay. Full rollback restored STUN-only client ICE and zero allocations.
- Chrome 151 browser loopbacks decoded VP8 299 and H.264 opt-in 299/298 rendered at 1280x720 without fatal/encoder errors. Browser hardware attribution, multi-viewer/endurance and public proof remain open; production stays VP8.
- Native WGC/MF used no browser capture/encoder. One Chrome Viewer rendered 203 1280x720 frames and received 500 Opus packets; process/LUID-correlated `VideoEncode` was nonzero, with no fatal/encoder errors.
- Native Win11 audio is source-only/default-off: target isolation was 4018x and one Viewer got 495 Opus packets. Download, game sync, Win10, and other routes remain open.
- Access protocol/config/HTTP/storage/SQLite/signaling focused tests pass, including commit-first teardown and v1 rollback.
- Native wire/session tests enforce at most two authoritative children, no presence-created edge, stale-revision ignore, and one bounded unsupported-route failure per revision.
- Production caps pending/answered `peer-selected` at one per room; Host ingress is independent. Focused admission/release/rollback/STUN-only tests pass; earlier Chrome proves active Host-ingress function only.
- Exact `6634cb9` passed typecheck, both builds, hygiene and 31 test files/459 tests from fresh inputs. Deployment preserved configuration hashes; DB, local/public health, root/room/asset/SiteAccess, retired-endpoint 404 and four zero-restart services passed.

## Unverified Boundaries

- The `6634cb9` cutover ran no browser/media/SFU/TURN/performance canary. Earlier `16f6eab` proof covers Host ingress only; audible quality, last mile, external cohorts, admission rescue, resources/performance and game blur remain open.
- Mobile is Viewer-only. Its persistent audible media element keeps media/signaling active while the page lives; iOS lock-screen, reclamation and background reconnection remain device gates. AirPlay/system mirroring is local output; live WebRTC `srcObject` has no portable in-app TV-output contract.
- Silent partitions can wait 30 to 60 seconds for heartbeat detection before the default 5-second grace; this remains unverified.
- The former release reportedly sustained bandwidth-limited blur on a capable LAN; Host refresh recovered while Viewer refresh did not. The new deployment has not yet reproduced or cleared it.
- ADR-0006 has one Viewer proof; two-edge/FIFO, hardware, endurance, public/downloaded-package, and browser-diversity proof remain open.
- Production fanout is Host2/Viewer1; source is Host2/Viewer2 and rejects child3. Resource behavior remains open.
- PR #49/#50 BWE is unverified/default-off: test zero-child leaves, then root impact. No local per-leaf UDP shaper; resume with Linux `tc` or public canary, never CDP. Web P2P/SVC shortcuts remain no-go.
- Headful fragment-to-sessionStorage consumption, invitation rotation after migration, and request/log leak inspection remain production UX gates. Accounts stay out.
- Structure debt: split `HybridMediaRouter`, `HostPage`, `SignalingServer`, and `ViewerPage` only at proven consumer boundaries, never by file length.

## Next Milestone

Next: representative production-room UDP/frame/cap/stop canary; room `1` is history. TURN performance follows later.
Recovery uses one ICE restart, one same-parent rebuild, one alternate peer, then SFU. Next gate exactly-two/Dynacast-off BWE on a zero-child SFU leaf, then root evacuation.
Native WGC/MF passed one-Viewer hardware; package download, Viewer2/FIFO and game A/V remain. Benchmark later.
Ordinary peers stay STUN-only; initial ingress and `peer-selected` still need forced-relay proof.
ADR-0004 still needs its resource/quality matrix; the 20-viewer gate precedes a default change. Mobile uses the same capacity and is a compatibility observation.

## Blockers And Decisions

ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets,
host/provider UDP 7882 and bounded services are deployed, but real external
media/device evidence is absent. Shared IP remains smoke-only and cannot approve
clean-port migration; the full gate still needs an isolated VM/IP.

- Initial deployment region and network cohort.
- Project license and distribution model.
