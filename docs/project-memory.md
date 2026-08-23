# Project Memory

Last updated: 2026-08-23

## Current Product Truth

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends. Public or large broadcasts belong on OBS/Twitch-class services.
- A room supports one Host and up to `20` authenticated Viewers. Admission is independent of endpoint fanout and SFU/TURN capacity; the event-driven route controller must remain efficient at that bound without all-pairs probing.
- Authenticated Hosts and shipped clients are trusted media participants in these private rooms; route authority, generation fencing, and server admission remain fail-closed.
- Web is the current delivery target. Viewers join from desktop or mobile browsers; a packaged or native sender is a later optimization.
- Keep routing automatic and media distributed. Direct/peer UDP is preferred; centralized media is fallback infrastructure, not the default topology.
- Every non-server endpoint uses one server-authoritative steady outbound media-copy capacity: default `2`, statically configurable as `1`, `2`, or `3`. A peer child or the Host publication consumes one slot; upstream receive is free, selected TURN replaces the same copy's transport, and SFU subscriber egress is accounted at the server. Browser role/UA/visibility does not create a separate tier, and clients cannot raise the deployment value.
- The stable routing invariants are one authoritative upstream per Viewer, an acyclic source-reachable active graph, exact authenticated route attempts, endpoint and server admission, one room-serial child operation, and bounded success, wait, or failure.
- One room controller reconciles allocation, child reparenting, and relay drain through the same operation. It finds one waiting Viewer or invalid edge and builds one deterministic candidate list. The operation owns its cursor, current candidate and reservations, plus one total deadline; only its current candidate may produce media. A prepare update names that exact child, selected transport, and server-issued candidate connection ID, so neither endpoint infers authority from an assignment-list difference. A usable old edge remains until the exact candidate child decodes its first new video frame. Success commits the prepare revision; failure keeps the committed graph content, broadcasts a newer active rollback revision, and advances the cursor. Total deadline or exhaustion ends in wait or failure. A relay with a bad ingress reparents itself as a child and retains its subtree. A disconnected endpoint, or one whose effective downstream capacity falls below its current child count, accepts no excess children; its direct or overflow children enter the same operation and a disconnected endpoint is removed when childless. Authoritative pause aborts the operation, suppresses stall decisions, and resumes from a fresh reconciliation.
- One Host publication may serve all SFU subscriptions. Its exact generation owns one ingress handle and exact Viewer subscription handles own egress; later SFU children reuse the publication, while reserved, committed, and draining handles remain charged until the managed room is deleted and proven absent. SFU-fed and peer-fed endpoints use the same provisional-child transaction, and selected TURN changes only the transport of an authorized logical edge. Parent choice hard-filters authority, reachability, cycles, effective capacity, and server admission, then orders by shallowest result, remaining steady sender capacity, stable join order, and peer identity. Acyclicity and room admission bound maximum depth; depth is observed but has no separate hard cap. Raw IP, claimed NAT type, UA, geography, all-pairs probes, weighted scores, and periodic room rebalancing are not route inputs.
- Ordinary peer ICE is STUN-only. Credentials, room secrets, candidate details, and diagnostic data remain private and narrowly scoped.
- Screen audio offers live-switchable 64/128/256 kbps sender ceilings and defaults to 128. The existing last-wins quality wire owns desired state; each endpoint serially applies and reads back current Host/relay/SFU audio senders, exposes local failures, and gives future senders the latest desired value. Opus remains fixed, and without an applied-ack wire the Host does not claim room-wide atomic convergence. These are configuration ceilings, not fidelity claims.
- Video codec selection remains `automatic | H.264 | VP8`. The accepted first switching boundary is a generation-fenced renegotiation/republish transaction while sharing is explicitly paused; unpaused hot switching is later reuse of that transaction, not an independent mechanism.
- Two distribution artifacts are accepted only after the current feature, NAT, and real-network ledger is complete. A public-server one-click deployment package installs the current application plus STUN/SFU/TURN and proxy components on a user-owned server. A Windows/macOS/Linux local package runs the Host, application server, and local state on the broadcaster's machine without source, Node, or any external Screener/network service; it keeps workable direct P2P but reports the reachability loss imposed by public ingress, TLS, gateway, NAT, or firewall limits rather than promising universal connectivity.
- Current UI, presence, route labels, and diagnostics describe observed state only; they do not create route authority.
- Viewer startup feedback remains on the stage until current-generation frame presentation is proven, distinguishes peer, fallback, media, autoplay, recovery, and failure phases, and keeps `Play` specific to autoplay rejection. The strict-NAT guessed-candidate idea remains an isolated emulator gate; only a pass may authorize one manually approved, kill-switched canary in an operator-owned test room with explicit consent from both endpoints and exact room/edge/generation/budget bounds.

## Current Source And Production

- Canonical source is the clean `main` branch. New branches and worktrees start from its exact current commit after accepted truth is merged.
- Current source admits up to `20` Viewers, implements the uniform `1/2/3` endpoint cap through one shared accounting guard, advances Web/server/Native to `screener-v6`, rejects v5 before room authority, and carries the exact deployment cap in every authenticated snapshot so ordinary Host authorization, Native admission, peer-assisted assignments, and sender slots use the same authority. Its SFU-fed-leaf and route-quality behavior still predates the accepted generic reconciliation model. SFU admission uses explicit no-default ingress/egress capacities, exact `reserved | committed | draining` lifecycle accounting, and a listener-fenced dedicated LiveKit owner. Selected TURN uses its own explicit no-default deployment capacity and exact logical-allocation ledger shared by independent peer edges and Host-SFU ingress.
- Production runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- Production still enforces Host downstream `2`, ordinary Browser downstream `1`, deployment values `1/2`, a fixed SFU-root limit of `2`, and legacy publication/selected accounting. This is a dated implementation divergence, not current product policy.
- Production has automatic routing, bad-relay corroboration, peer-quality make-before-break with Viewer and Host provisional parents, selected-edge transport, stable route/connection details, 64/128/256 audio choices, access controls, self-check, diagnostic export, and signaling watchdog behavior.
- `screener`, LiveKit, coturn, and nginx are healthy; local and public health return 200 and `screener` has `NRestarts=0`. Deployment detail is owned by [deployment](./deployment.md).
- Chrome loopback, cap2/cap3, short resource, recovery, MBB, and A/V fixtures are bounded evidence only. They do not establish quality, resource limits, or product policy.

## Current Priority

1. Keep this truth set and [the TODO ledger](./todo.md) concise and internally consistent.
2. Complete and release the remaining route-controller convergence first. Then release live audio and paused video-codec switching, follow with evidence-led H.264 diagnosis, the strict-NAT emulator gate, connection feedback, and the remaining functional roadmap. Distribution packaging starts only after those TODOs are complete. Parallel branches may finish earlier but do not change this merge/deployment order.

## Working Rules

- Discussion and evidence are inputs, not executable TODOs. Accepted semantics are written to their owners before implementation.
- Prefer standards and mature framework behavior, then one general reconciliation mechanism. Repair an invariant before adding a case branch; a specialized gate, probe, timer, state container, or test requires evidence that the general mechanism cannot cover the failure.
- Current documents state the current model directly. Rejected alternatives and removal narratives are deleted; Git history owns them.
- Old branches may contribute scoped code or evidence only after reconciliation. Their memory, requirements, ADRs, status, and deployment snapshots never overwrite newer mainline truth.
- Preserve dirty, unique, open-stack, and evidence worktrees until their disposition is explicitly decided. Workspace counts are sampled on demand rather than stored here.

## Source Map

- Current execution: [status](./status.md)
- Executable and held work: [TODO ledger](./todo.md)
- Requirements and design: [requirements](./%E9%9C%80%E6%B1%82%E7%90%86%E8%A7%A3.md), [design](./%E6%96%B9%E6%A1%88%E8%AE%BE%E8%AE%A1.md), and [ADRs](./adr/)
- Evidence and limits: [research](./research/) and [verification status](./verification-status.md)
- Operations: [deployment](./deployment.md), [maintenance](./maintenance.md), and [contributing](../CONTRIBUTING.md)
