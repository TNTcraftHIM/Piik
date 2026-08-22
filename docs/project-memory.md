# Project Memory

Last updated: 2026-08-22

## Current Product Truth

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends. Public or large broadcasts belong on OBS/Twitch-class services.
- Web is the current delivery target. Viewers join from desktop or mobile browsers; a packaged or native sender is a later optimization.
- Keep routing automatic and media distributed. Direct/peer UDP is preferred; centralized media is fallback infrastructure, not the default topology.
- Every non-server endpoint uses one server-authoritative steady outbound media-copy capacity: default `2`, statically configurable as `1`, `2`, or `3`. A peer child or the Host publication consumes one slot; upstream receive is free, selected TURN replaces the same copy's transport, and SFU subscriber egress is accounted at the server. Browser role/UA/visibility does not create a separate tier, and clients cannot raise the deployment value.
- The stable routing invariants are one authoritative upstream per Viewer, an acyclic active graph, exact room/session/share/revision/generation authorization, media-proven make-before-break, and bounded success or failure.
- The accepted route model is one room controller with allocate/distribute, child reparent, and relay abdicate/drain operations. One Host publication may serve all SFU-fed Viewers; an SFU-fed Viewer may relay only with independent outbound proof; selected TURN changes an authorized edge transport and is not a topology node. A confirmed bad edge reparents only its child. A relay parent's own ingress failure first enters suspect/cordon and attempts local repair; only failed repair, independent downstream evidence, or explicit sender/resource failure drains its children. Host source failures use publication repair and child migration. Endpoint capacity, temporary overlap, SFU/TURN admission, exact fallback, media binding generations, and rollback are one bounded transaction model.
- Parent choice is sticky and deterministic: hard-filter current authority, reachability, cycles, depth, capacity, eligibility, exact-edge cooldown, and server admission; then order by shallowest result, remaining steady sender capacity, stable join order, and peer identity. Standard ICE and exact media proof test one candidate at a time. Raw IP, claimed NAT type, UA, geography, all-pairs probes, weighted scores, and periodic room rebalancing are not route inputs.
- Ordinary peer ICE is STUN-only. Credentials, room secrets, candidate details, and diagnostic data remain private and narrowly scoped.
- Screen audio offers live-switchable 64/128/256 kbps sender ceilings and defaults to 128. The existing last-wins quality wire owns desired state; each endpoint serially applies and reads back current Host/relay/SFU audio senders, exposes local failures, and gives future senders the latest desired value. Opus remains fixed, and without an applied-ack wire the Host does not claim room-wide atomic convergence. These are configuration ceilings, not fidelity claims.
- Video codec selection remains `automatic | H.264 | VP8`. The accepted first switching boundary is a generation-fenced renegotiation/republish transaction while sharing is explicitly paused; unpaused hot switching is later reuse of that transaction, not an independent mechanism.
- Two distribution artifacts are accepted only after the current feature, NAT, and real-network ledger is complete. A public-server one-click deployment package installs the current application plus STUN/SFU/TURN and proxy components on a user-owned server. A Windows/macOS/Linux local package runs the Host, application server, and local state on the broadcaster's machine without source, Node, or any external Screener/network service; it keeps workable direct P2P but reports the reachability loss imposed by public ingress, TLS, gateway, NAT, or firewall limits rather than promising universal connectivity.
- Current UI, presence, route labels, and diagnostics describe observed state only; they do not create route authority.
- Viewer startup feedback remains on the stage until current-generation frame presentation is proven, distinguishes peer, fallback, media, autoplay, recovery, and failure phases, and keeps `Play` specific to autoplay rejection. The strict-NAT guessed-candidate idea remains an isolated emulator gate; only a pass may authorize one manually approved, kill-switched canary in an operator-owned test room with explicit consent from both endpoints and exact room/edge/generation/budget bounds.

## Current Source And Production

- Canonical source is the clean `main` branch. New branches and worktrees start from its exact current commit after accepted truth is merged.
- Current source implements the uniform `1/2/3` endpoint cap through one shared accounting guard, advances Web/server/Native to `screener-v6`, rejects v5 before room authority, treats SFU-fed Viewers as leaves without outbound proof, and retains the fixed SFU-root and room-wide selected-lease guards pending later server admission waves. Release readiness requires the v6 authenticated snapshot to carry the exact deployment cap so Native admission, peer-assisted assignments, and sender slots use the same authority.
- Production runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- Production still enforces Host downstream `2`, ordinary Browser downstream `1`, deployment values `1/2`, a fixed SFU-root limit of `2`, and legacy publication/selected accounting. This is a dated implementation divergence, not current product policy.
- Production has automatic routing, bad-relay corroboration, peer-quality make-before-break with Viewer and Host provisional parents, selected-edge transport, stable route/connection details, 64/128/256 audio choices, access controls, self-check, diagnostic export, and signaling watchdog behavior.
- `screener`, LiveKit, coturn, and nginx are healthy; local and public health return 200 and `screener` has `NRestarts=0`. Deployment detail is owned by [deployment](./deployment.md).
- Chrome loopback, cap2/cap3, short resource, recovery, MBB, and A/V fixtures are bounded evidence only. They do not establish quality, resource limits, or product policy.

## Current Priority

1. Keep this truth set and [the TODO ledger](./todo.md) concise and internally consistent.
2. Rebuild and release the accepted route runtime first. Then release live audio and paused video-codec switching, follow with evidence-led H.264 diagnosis, the strict-NAT emulator gate, connection feedback, and the remaining functional roadmap. Distribution packaging starts only after those TODOs are complete. Parallel branches may finish earlier but do not change this merge/deployment order.

## Working Rules

- Discussion and evidence are inputs, not executable TODOs. Accepted semantics are written to their owners before implementation.
- Current documents state the current model directly. Rejected alternatives and removal narratives are deleted; Git history owns them.
- Old branches may contribute scoped code or evidence only after reconciliation. Their memory, requirements, ADRs, status, and deployment snapshots never overwrite newer mainline truth.
- Preserve dirty, unique, open-stack, and evidence worktrees until their disposition is explicitly decided. Workspace counts are sampled on demand rather than stored here.

## Source Map

- Current execution: [status](./status.md)
- Executable and held work: [TODO ledger](./todo.md)
- Requirements and design: [requirements](./%E9%9C%80%E6%B1%82%E7%90%86%E8%A7%A3.md), [design](./%E6%96%B9%E6%A1%88%E8%AE%BE%E8%AE%A1.md), and [ADRs](./adr/)
- Evidence and limits: [research](./research/) and [verification status](./verification-status.md)
- Operations: [deployment](./deployment.md), [maintenance](./maintenance.md), and [contributing](../CONTRIBUTING.md)
