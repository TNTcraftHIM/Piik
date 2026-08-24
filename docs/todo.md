# Current TODO Ledger

Last reviewed: 2026-08-24

Only items in **Now** are executable after their stated decision gate. A branch name, unchecked requirement, experiment, review suggestion, or deployed behavior is not a TODO by itself.

## Now

1. **Deploy Browser v9 atomically.** Integrate the exact `d543f38aacad3df5ef65fde1055cc8e733972afe` runtime checkpoint with its aligned truth, build the clean exact integration commit, and cut one release containing the single `screener-v9` wire. Verify archive identity, stale-v8 rejection before room authority, service health, public assets, media listeners, zero restarts, secret-safe logs, and rollback readiness before declaring production v9. Do not publish a protocol subset or mix v8 and v9 assets.
2. **Physically validate paused codec switching.** On current Chrome and Edge, exercise `automatic | H.264 | VP8` across a direct Viewer, a browser-relay descendant, and an SFU subscriber. Capture the exact negotiated outbound/inbound codec, source-enabled acknowledgement boundary, newly decoded progress, and first presented frame after each normal Resume. Exercise a real preparation or proof failure and prove authoritative re-pause plus old-preference rollback on the next user Resume; local state-machine tests alone do not close this item.
3. **Physically validate live screen-audio ceilings.** With audible game/music capture, switch 64/128/256 kbps while sharing across direct, browser-relay, and SFU paths, then create a new edge and switch source. Record sender readback, observed bitrate, route continuity, audible result, and A/V synchronization. Treat every setting as a ceiling, and do not infer fidelity or room-wide atomic convergence from configuration alone.
4. **Diagnose the dated H.264/blur report.** Reproduce the 2026-08-19 then-production release `769de201f7cc` against current source on the same Host/browser/driver/game and one wired direct Viewer, changing one variable at a time. Implement a codec-specific repair only if codec/encoder evidence identifies it; otherwise fix the proven capture, sender, BWE, or lifecycle cause.
5. **Diagnose desktop Host background/minimized performance.** On the same machine, dynamic scene, direct Viewer, browser, and fresh share, compare foreground, occluded, minimized, and hidden states while separately verifying actual negotiated VP8/H.264. Correlate capture settings/FPS, frames captured/encoded/sent/decoded, bitrate, `qualityLimitationReason`, encode time, browser/game CPU and GPU, and the existing local-preview pause boundary. Treat browser scheduling/throttling and codec effects as hypotheses until measured. Do not spoof page activity, add keepalive timers, or misuse Wake Lock; if current Chrome/Edge cannot preserve the accepted Host behavior through standard Web APIs, record that capability boundary before considering the packaged/native Host.
6. **Finish real-network route acceptance.** Measure standard ICE/STUN direct paths, peer relay, SFU ingress/subscription, exact first-frame commit and rollback, relay-ingress repair with subtree retention, disconnect/capacity drain, pause/Resume, and bounded explicit failure across representative IPv4/IPv6 NATs and mobile networks. Include an all-UDP-blocked case to establish the current failure boundary. Do not add port prediction, NAT classification, TCP probes, guessed candidates, route scores, or quality-driven reparenting.

## Accepted Later Roadmap

These items are real product work, ordered after the current release boundary; they are not permission to resume an old branch wholesale.

1. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari device matrices for autoplay gesture, foreground/background audio, foreground video recovery, lock/page reclamation, rotation, Wi-Fi/cellular migration, and an assigned relay's outbound-media survival or controller failover across those transitions. Preserve the same media element and current reconnect path; do not promise background video composition, background relay continuity, or unsupported lock-screen behavior.
2. **Platform output only when real.** Revisit AirPlay/Cast only when a target browser and physical receiver prove the live `MediaStream` contract. System mirroring remains external; no placeholder button, custom receiver, or server transcode is scheduled.
3. **Public-server one-click deployment package.** After every current functional and real-network item is settled, package the exact application, STUN/SFU, reverse proxy, secrets, health checks and rollback flow for a user-owned public server. Require real domain/TLS/firewall/capacity inputs and never ship credentials or call a partial deployment ready.
4. **Fully local one-click Host-server package.** Package Windows/macOS/Linux Host capture, the exact application server and local state without requiring source, Node or any external Screener/STUN/SFU/tunnel/relay service. Preserve usable direct P2P and use the completed NAT/network evidence to maximize reachability, while reporting public-origin, gateway, NAT and firewall limits truthfully; loopback/LAN success is not universal Internet success.
5. **Native Host capture backend.** At lowest priority, productize a proven Windows native capture path before expanding capture/audio backends to macOS and Linux. Its capture, hardware encode, audio, identity and lifecycle evidence becomes an input to later packages; a source checkout, helper executable, or evaluation ZIP is not a distributable product.
6. **Native shared encode, Windows first.** At lowest priority, prove one hardware encoder output can serve two independent Viewer transports and the Host-SFU publication while each connection retains its own RTP/RTCP, pacing, encryption, feedback, and upload accounting. Productize only after actual access-unit identity, Viewer2/FIFO, heterogeneous feedback, game-resource, browser/hardware, A/V, packaging, and licensing gates pass. Web Host/relay remains standard per-`RTCPeerConnection` encoding because no portable shared-encoder contract exists.
7. **Repository simplification audit.** After the current Browser, physical-media, route, and room checkpoints settle, inventory components, configuration, migrations, gates, timers, compatibility paths, and tests using the [maintenance review](./maintenance.md#机制减负审查). Begin read-only: identify the user behavior each mechanism preserves, quantify the impact of removing it, and compare that value with its whole-system cost. Any accepted feature tradeoff updates its owning contract before complete unused surfaces are removed. This later audit must not become a broad refactor or block current product work.

## Product Decisions Needed

| Deployed or retained item | Decision |
| --- | --- |
| #169 connection self-check | Keep, revise, or remove the user-facing pre-share probe. Do not extend it automatically. |
| #181 selected-pair response counter | Keep as local observation or remove; it has no route authority. |
| #182 signaling watchdog | Confirm Host and mobile/background session semantics before calling it complete. |
| Project license and closed-commercial boundary | Decide the repository and distribution license before any public release or package distribution. GPL/AGPL implementations remain research-only until then. |

These decisions are not permission to continue old branches, and current deployment remains unchanged until a scoped decision is made.

## Evidence And Later Work

- Open PR #192 measures synthetic flash/tone timing; it is not an A/V correction feature.
- The Native PR stack #16/#18/#22/#23/#25/#28 and related fanout branches are one research program, not six product TODOs.
- Cap3, resource, route-recovery, Viewer-MBB, signaling-blackhole, Host-generation, SFU-shaping, NAT, mobile, and endurance artifacts remain bounded evidence. Merge or retain them only when a current decision consumes them. Raw-IP ranking, port prediction, NAT classification, AirPlay/Cast receivers, and mobile background guarantees are not implied by the current implementation batch.
- Real heterogeneous-network SFU, mobile lifecycle, audio/A-V device, and endurance/resource acceptance are scheduled at the relevant release boundary.

## Candidate Handling

- Preserve the dirty `fix/configurable-relay-cap` worktree only for user-change audit. Current `main` already implements the accepted uniform `1/2/3` endpoint cap; do not merge the worktree's old route implementation or treat it as unfinished cap work.
- Preserve dirty or unique worktrees and open stacked branches until reviewed. Never resolve their conflicts by importing old truth into `main`.
- Sample worktree, branch, PR, artifact, and reparse-point state immediately before cleanup; do not maintain a permanent workspace inventory here.
