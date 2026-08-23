# Current Status

Last updated: 2026-08-24

This is the current execution index. Git history owns completed timelines; [verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact `8f5b3f192ddd010ca01c969008e512191312736a`, release `8f5b3f1`, wire `screener-v8`; `/opt/screener/backups/8f5b3f1-precutover-20260823T182438Z` retains the exact previous application/environment/LiveKit/coturn/nft/unit boundary and the immutable archive SHA-256 is `09c18d3604b64b627b01164b5a8d954fcbaeb567ca12dedf0b89deaac72bd767`.
- `screener`, LiveKit, coturn, and nginx are active; local/public health return 200 and all services report `NRestarts=0`. The v8 unit has no writable room `StateDirectory`, the process has no SQLite descriptor, and the old live SQLite path is absent.
- Production admits one Host plus 20 Viewers, applies endpoint capacity `2`, rejects stale Browser and executable-sender wires before room authority, and runs the one-controller exact-candidate route model with one staged total deadline. Rooms use random free four-digit codes, a 24-hour dormant lease, restart loss, local Host creation preferences, independent Viewer grants, and `open | password | disabled` code entry. LiveKit remains dedicated with `room.auto_create: false`, `max_participants: 21`, and global admission `1` publication ingress / `20` subscription egress.
- Production media ports are STUN-only UDP 3478 and LiveKit UDP 7882; coturn TCP/TLS and relay ranges are disabled. The public Web ingress remains TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are internal-only. These deployment facts do not close the real heterogeneous-network, SFU, mobile, or endurance evidence boundaries.
- SFU subscribers reconcile Host screen publications across connect, activation, participant arrival, track publication, and reconnect. A controlled production canary forced two SFU roots; both committed `route-ready`, reached active SFU assignments, and decoded 1920x1080 video. LiveKit runs at `warn`/Pion `error`, and the Screener unit waits boundedly for the same-host LiveKit control listener before startup.

## Current Source

- Canonical source is the root `main` branch; auxiliary branches and worktrees do not own current truth. Audit/integration boundaries require a clean root, and dependent work starts only from its exact commit.
- Current source implements one steady outbound media-copy cap for every non-server endpoint: default `2`, static `1/2/3`, a peer child or Host publication consumes one slot, upstream receive is free, and no Browser/UA/visibility tier exists. One shared guard owns the accounting and transition work is bounded by `min(C + 1, 3)`.
- Current source and production admission support one Host plus up to `20` Viewers. Focused controller coverage includes `C=1/2/3`, a 20-Viewer graph, and the passed local 20-Viewer Browser smoke; real external-network media and resource measurements remain open.
- The single Browser `screener-v8` boundary rejects stale Browser and executable-sender wires before room authority and carries the exact deployment cap plus exact prepare candidate in the authenticated route contract.
- Current source also implements explicit no-default SFU ingress/egress capacities and exact `reserved | committed | draining` accounting. The listener owner reconciles its dedicated non-auto-create LiveKit namespace before serving, creates each generation before token issuance, releases only after delete-plus-absence proof, and reclaims Host-offline generations through bounded exact-participant checks. Ordinary peer ICE is STUN-only and the sole application fallback is SFU/UDP; stale TURN environment keys fail startup.
- Current source implements automatic P2P-first routing with one active upstream, an acyclic source-reachable graph, an exact prepare tuple, first-decoded-frame make-before-break, strict rollback revision, and bounded wait or failure.
- One event-driven controller owns the committed graph and at most one room-serial child operation. The operation owns one deterministic candidate list/cursor, one current candidate and reservations, fact version, and one total deadline split only across direct and SFU stages. Failed candidates are operation-local; exhaustion retires invalid/overflow edges but retains healthy bootstrap media. Bounded-gap preflights resources, replans the remaining suffix, and restores a healthy retired edge through one final ordinary candidate. Admission commits synchronously before graph promotion; release uses the resource-set difference and room disposal returns all resources. One Host publication serves exact Viewer subscription handles, and actual global SFU release wakes registered waiting rooms.
- Parent selection is deterministic rather than random or score-based: hard eligibility filters, then shallowest result, remaining sender capacity, stable join order, and peer identity. When a departed Host root frees a Host slot, a new or reparable child prefers that shallower Host result over another root's free slot; healthy old edges remain sticky and the controller does not periodically rebalance the whole graph. The exact candidate child's first new decoded frame is the only application media-ready event. Moderate bitrate, FPS, resolution, loss, or visual degradation remains with stock WebRTC/LiveKit adaptation and diagnostics; only hard connection failure or a non-paused decoded-frame stall invalidates a route edge. Current-path stats do not authorize quality-driven reparenting.
- The direct-to-SFU source passed repository typecheck, all 531 Web tests in 41 files, and client/server production builds. Focused tests cover the direct-stage wake, Host-full virtual SFU bootstrap without a premature route error, SFU reuse, and a departed-root scenario in which new demand uses the freed Host slot without moving healthy descendants. No Native/executable suite or heterogeneous-network media run was performed.
- Browser initial capture and source switching already request available share audio through one shared capture boundary and visibly retain video-only sharing when no audio track is returned.
- Live 64/128/256 audio-ceiling mutation and paused-share video codec switching are accepted but not yet implemented on canonical `main`. Current source still defaults to `1080p60`, lacks advanced 480p, renders Viewer state from scattered free text, and carries an unused parent-edge quality-proof message. The accepted v9 cleanup changes the default to `1080p30`, adds only advanced `854x480`, introduces typed Viewer failure/route timing, and deletes that unused message; none of v9 is implemented or deployed. H.264 startup blur/low-FPS reports remain an evidence-led diagnosis, not a presumed codec defect.
- Current source and production implement one process-memory RoomStore with random four-digit codes, a default 24-hour dormant lease, exact-Host resume, restart loss, local Host preference replay, independent token invitations and `open | password | disabled` code entry, and no SQLite runtime. The Host UI separates the invitation, room-code entry policy, password, grant update, and grant revoke controls.

## Current Milestone

1. Build one atomic Browser v9 release: implement live audio-ceiling mutation and paused-share codec switching, then remove the unused quality-proof wire, add first-frame/typed-failure Viewer presentation and privacy-safe on-demand route diagnostics, repair room entry/UI, set the default to `1080p30`, and add `480p` only to advanced resolution. Do not deploy a protocol subset.
2. Reproduce the dated H.264/blur report and current Host background report before any mechanism change.
3. Finish standard ICE/SFU real-network acceptance. Browser port prediction, NAT classification, TCP probing, and quality-driven reparenting are outside the accepted route model.

## Active Boundaries

- `fix/configurable-relay-cap` is an old, incomplete draft and must not be merged as-is.
- Open PR #192 and the Native stack are evidence/research, not pending product releases. Native senders, capture helpers, shared-encode executables, and their test binaries are outside the current Browser milestone and are not built or run.
- Deployed surfaces and retained candidates that still need product decisions are indexed only in [the TODO ledger](./todo.md); do not extend or roll them back automatically.
- Room lifetime, authorization/storage semantics, v8 stale-client rejection, restart loss, and rollback restoration are aligned between current source and production. The room-entry presentation and responsive-control changes listed above are accepted v9 work, not current behavior.
- Real SFU recovery, heterogeneous networks, mobile lifecycle, audio/A-V device behavior, and endurance/resource measurements remain external acceptance evidence, not blockers for unrelated reversible work.

## Current Hold

The Browser route, SFU subscription reconciliation, two-stage deadline, direct-to-SFU transport,
and memory-room slices are deployed. There is no active P0/P1 hold. The owner authorized the current
Browser TODO sequence; Native/executable work and broad repository cleanup remain outside it.
