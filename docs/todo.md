# Current TODO Ledger

Last reviewed: 2026-08-25

Only items in **Now** are executable after their stated decision gate. A branch name, unchecked requirement, experiment, review suggestion, or deployed behavior is not a TODO by itself.

## Now

1. **Finish real-network route acceptance.** Measure standard ICE/STUN direct paths, peer relay, SFU ingress/subscription, exact first-frame commit and rollback, relay-ingress repair with subtree retention, disconnect/capacity drain, Pause/Resume, screen-audio continuity and real-game A/V sync, and bounded explicit failure across representative IPv4/IPv6 NATs and mobile networks. Include an all-UDP-blocked case to establish the current failure boundary. Do not add port prediction, NAT classification, TCP probes, guessed candidates, route scores, or quality-driven reparenting.

## Accepted Later Roadmap

These items are real product work, ordered after the current physical-media, real-network, and product-decision gates; they are not permission to resume an old branch wholesale.

1. **Browser VP8 hardware-acceleration evidence.** After the current physical codec gate, measure supported Chrome/Edge platform combinations under real game load using actual negotiated codec, encoder implementation, power-efficient status, encode time, frame rate, and CPU/GPU attribution. Capability advertisement alone is not proof. Do not add another codec, a custom encoder, GPU-selection workaround, codec ladder, or Native helper without a new accepted decision.
2. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari device matrices for autoplay gesture, foreground/background audio, foreground video recovery, lock/page reclamation, rotation, Wi-Fi/cellular migration, and an assigned relay's outbound-media survival or controller failover across those transitions. Preserve the same media element and current reconnect path; do not promise background video composition, background relay continuity, or unsupported lock-screen behavior.
3. **Platform output only when real.** Revisit AirPlay/Cast only when a target browser and physical receiver prove the live `MediaStream` contract. System mirroring remains external; no placeholder button, custom receiver, or server transcode is scheduled.
4. **Public-server one-click deployment package.** After every current functional and real-network item is settled, package the exact application, STUN/SFU, reverse proxy, secrets, and health checks for a user-owned public server. Require real domain/TLS/firewall/capacity inputs and recovery scoped to any infrastructure or irreversible state the installer actually changes; routine application-only immutable updates do not create or maintain a full configuration backup. Never ship credentials or call a partial deployment ready.
5. **Fully local one-click Host-server package.** Package Windows/macOS/Linux Host capture, the exact application server and local state without requiring source, Node or any external Screener/STUN/SFU/tunnel/relay service. Preserve usable direct P2P and use the completed NAT/network evidence to maximize reachability, while reporting public-origin, gateway, NAT and firewall limits truthfully; loopback/LAN success is not universal Internet success.
6. **Native Host capture backend.** At lowest priority, productize a proven Windows native capture path before expanding capture/audio backends to macOS and Linux. Its capture, hardware encode, audio, identity and lifecycle evidence becomes an input to later packages; a source checkout, helper executable, or evaluation ZIP is not a distributable product.
7. **Native shared encode, Windows first.** At lowest priority, prove one hardware encoder output can serve two independent Viewer transports and the Host-SFU publication while each connection retains its own RTP/RTCP, pacing, encryption, feedback, and upload accounting. Productize only after actual access-unit identity, Viewer2/FIFO, heterogeneous feedback, game-resource, browser/hardware, A/V, packaging, and licensing gates pass. Web Host/relay remains standard per-`RTCPeerConnection` encoding because no portable shared-encoder contract exists.
8. **Whole-product UI polish and bilingual-scope decision.** After current functional, physical-media, and real-network work stabilizes, review the product UI once as a whole: simplify and align copy, refine responsive hierarchy and visual consistency, add restrained motion, and measure rendering and bundle cost. Decide Chinese/English scope, default/fallback and switching persistence before introducing one shared text catalog; do not add duplicate screen-specific translations or let presentation redefine room and route semantics.
9. **Repository simplification audit.** After the current Browser, physical-media, route, and room checkpoints settle, inventory components, configuration, migrations, gates, timers, compatibility paths, tests, and truth-document duplication using the [maintenance review](./maintenance.md#机制减负审查). Begin read-only: identify the behavior or decision each surface preserves and compare that value with its whole-system cost. Any accepted feature tradeoff updates its single owning contract before complete unused surfaces are removed. This later audit must not become a broad refactor or block current product work.

## Product Decisions Needed

| Deployed or retained item | Decision |
| --- | --- |
| Project license and closed-commercial boundary | Decide the repository and distribution license before any public release or package distribution. GPL/AGPL implementations remain research-only until then. |

These decisions are not permission to continue old branches, and current deployment remains unchanged until a scoped decision is made.

## Evidence And Later Work

- The desktop Host background/minimized report is deferred after a bounded current-Chrome screening found no immediate Host-page lifecycle drop and the old `contentHint = "motion"` release remained a plausible confound. Reopen it only with a reproducible current-production real-game case and synchronized capture/send/receive/decode plus CPU/GPU evidence. This does not close or advance the separate Mobile Viewer lifecycle item, whose background playback and assigned-relay survival depend on mobile browser and OS lifecycle behavior.
- Open PR #192 measures synthetic flash/tone timing; it is not an A/V correction feature.
- The Native PR stack #16/#18/#22/#23/#25/#28 and related fanout branches are one research program, not six product TODOs.
- Cap3, resource, route-recovery, Viewer-MBB, signaling-blackhole, Host-generation, SFU-shaping, NAT, mobile, and endurance artifacts remain bounded evidence. Merge or retain them only when a current decision consumes them. Raw-IP ranking, port prediction, NAT classification, AirPlay/Cast receivers, and mobile background guarantees are not implied by the current implementation batch.
- Real heterogeneous-network SFU, mobile lifecycle, audio/A-V device, and endurance/resource acceptance remain owned by the corresponding Now or Later evidence gate.

## Candidate Handling

- Preserve the dirty `fix/configurable-relay-cap` worktree only for user-change audit. Current `main` already implements the accepted uniform `1/2/3` endpoint cap; do not merge the worktree's old route implementation or treat it as unfinished cap work.
- Preserve dirty or unique worktrees and open stacked branches until reviewed. Never resolve their conflicts by importing old truth into `main`.
- Sample worktree, branch, PR, artifact, and reparse-point state immediately before cleanup; do not maintain a permanent workspace inventory here.
