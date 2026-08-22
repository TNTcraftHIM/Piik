# Current TODO Ledger

Last reviewed: 2026-08-22

Only items in **Now** are executable after their stated decision gate. A branch name, unchecked requirement, experiment, review suggestion, or deployed behavior is not a TODO by itself.

## Now

1. **Complete route wave A's v6 endpoint-cap boundary.** Add the exact deployment `endpointMediaCopyCapacity` to every authenticated snapshot; bound ordinary server-authorized Host children and their signaling to that value with stable waiting promotion; and make Native ordinary admission, peer-assisted child assignment, and sender-slot allocation consume it independently of room `maxViewers`. Strictly reject missing or out-of-range values, retain the shared accounting and transition guard, and validate `C=1/2/3` before release. Do not merge the old configurable-cap worktree.
2. **Route waves B-D: bounded fallback, selection, and controller convergence.** Replace the temporary fixed SFU subscriber guard with explicit deployment-wide SFU ingress/egress admission; then replace the temporary room-wide selected-lease guard with per-edge TURN allocation admission and exact accounting. Converge allocation, child reparent, and relay drain on one committed graph/controller. Parent candidates use hard eligibility filters followed by deterministic shallowest, remaining-capacity, join-order, and peer-identity ordering; standard ICE plus exact media proof tests one candidate at a time. Do not add raw-IP/NAT ranking, all-pairs probes, a weighted score, or periodic rebalancing. The temporary guards are safety boundaries, not accepted product limits, and must not be removed early.
3. **Switch screen-audio ceilings live.** Keep Opus fixed and serialize 64/128/256 kbps desired profile updates across every current Host, relay, and SFU audio sender. Each endpoint uses fresh `getParameters()`/`setParameters()` readback, ignores stale completions, retains media plus its prior applied value on failure, and applies the latest desired value to future edges. Do not add a remote applied-ack protocol or claim room-wide atomic convergence in this slice.
4. **Switch video codec while paused.** After the route/media-generation boundary is available, serialize the change with route mutation, freeze exact current route/media bindings, hold new joins, renegotiate P2P/relay and republish SFU while paused, then verify actual codec plus decoded frames on resume. A binding invalidated by leave or hard route failure exits this proof set and waits for routing to rebuild from the final committed preference after the bounded codec transaction settles. On failure pause again and perform bounded rollback; rollback proves the prior preference was reapplied plus a newly negotiated actual codec and decoded progress, not literal equality with the old actual codec. Zero targets update only the future-edge preference. Reset `automatic` with empty codec preferences. This is a paused bounded-gap transaction; unpaused make-before-break is a later extension.
5. **Diagnose the production H.264/blur report.** Reproduce exact release `769de201f7cc` against current `main` on the same Host/browser/driver/game and one wired direct Viewer, changing one variable at a time. Implement a codec-specific repair only if codec/encoder evidence identifies it; otherwise fix the proven capture, sender, BWE, or lifecycle cause.
6. **Gate the strict-NAT guessed-candidate experiment.** Build only the isolated endpoint-dependent NAT emulator and browser harness first. Standard ICE must fail in the owned fixture, the capped candidate set must pass the documented repeatability, deadline, privacy, and cleanup gates in stable Chrome and Firefox, and fallback must remain unchanged. Only then may one manually approved, operator-owned test room run a default-off, kill-switched canary with explicit consent from both endpoints and exact room/edge/generation/budget bounds; failure closes the candidate. Do not ship guessed candidates to ordinary rooms or infer NAT type from IP, UA, carrier, or two STUN observations.
7. **Make Viewer connection progress explicit.** Derive one stable stage from existing access, route, peer/SFU, media, autoplay, and bounded-failure state. Keep the overlay until a composited current-generation frame, show `Play` only for actual autoplay rejection, preserve a still-valid old frame during recovery, and expose retry only through the bounded controller. Measure the existing token-free SFU prewarm and route stages before adding another connection mechanism.
8. **Validate and release in priority order.** Review, merge, and deploy each coherent slice from canonical `main`: route first, then audio/codec mutation, then H.264/NAT evidence and any proven repair, then connection feedback and remaining tools. Run the focused state machine and browser/network matrix relevant to that slice, plus independent review, build/full gates, bounded production preflight, postflight, and rollback verification. A parallel branch may finish early but does not jump this rollout order.

The existing route implementation is an input to these tasks. Preserve its verified generation, authorization, make-before-break, and media-proof invariants while migrating capacity and fallback accounting. The accepted model is the destination; each wave must remain safe and truthful on its own rather than installing a name-only controller or an unreserved overlap.

## Accepted Later Roadmap

These items are real product work, ordered after the current release boundary; they are not permission to resume an old branch wholesale.

1. **Native shared encode, Windows first.** Prove one hardware encoder output can serve two independent Viewer transports and the Host-SFU publication while each connection retains its own RTP/RTCP, pacing, encryption, feedback, and upload accounting. Productize only after actual access-unit identity, Viewer2/FIFO, heterogeneous feedback, game-resource, browser/hardware, A/V, packaging, and licensing gates pass. Web Host/relay remains standard per-`RTCPeerConnection` encoding because no portable shared-encoder contract exists.
2. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari device matrices for autoplay gesture, foreground/background audio, foreground video recovery, lock/page reclamation, rotation, and Wi-Fi/cellular migration. Preserve the same media element and current reconnect path; do not promise background video composition or unsupported lock-screen behavior.
3. **Native Host capture backend.** Productize a proven Windows native capture path before expanding capture/audio backends to macOS and Linux. Its capture, hardware encode, audio, identity and lifecycle evidence becomes an input to later packages; a source checkout or evaluation ZIP is not a distributable product.
4. **Real network acceptance.** Measure standard ICE/STUN, IPv4/IPv6, independent STUN destinations, selected TURN, SFU ingress, and bounded failure across representative NATs and mobile networks. Browser port prediction remains experiment-only until its emulator and allowlisted-canary gates pass; raw-IP ranking and a room-wide quality score remain out of scope. Parent choice uses exact edge evidence and the accepted route controller.
5. **Platform output only when real.** Revisit AirPlay/Cast only when a target browser and physical receiver prove the live `MediaStream` contract. System mirroring remains external; no placeholder button, custom receiver, or server transcode is scheduled.
6. **Public-server one-click deployment package.** After every current functional and real-network item is settled, package the exact application, STUN/SFU/TURN, reverse proxy, storage, secrets, health checks, backup and rollback flow for a user-owned public server. Require real domain/TLS/firewall/capacity inputs and never ship credentials or call a partial deployment ready.
7. **Fully local one-click Host-server package.** Last, package Windows/macOS/Linux Host capture, the exact application server and local state without requiring source, Node or any external Screener/STUN/SFU/TURN/tunnel/relay service. Preserve usable direct P2P and use the completed NAT/network evidence to maximize reachability, while reporting public-origin, gateway, NAT and firewall limits truthfully; loopback/LAN success is not universal Internet success.

## Product Decisions Needed

| Deployed or retained item | Decision |
| --- | --- |
| #169 connection self-check | Keep, revise, or remove the user-facing pre-share probe. Do not extend it automatically. |
| #170 explicit 1-16 Viewer admission | Confirm the small-room admission range independently of endpoint fanout. |
| #171 diagnostic JSON export | Confirm a support workflow or remove the extra surface. |
| #181 selected-pair response counter | Keep as local observation or remove; it has no route authority. |
| #182 signaling watchdog | Confirm Host, mobile/background, and selected-edge session semantics before calling it complete. |

These decisions are not permission to continue old branches, and current deployment remains unchanged until a scoped decision is made.

## Evidence And Later Work

- Open PR #192 measures synthetic flash/tone timing; it is not an A/V correction feature.
- The Native PR stack #16/#18/#22/#23/#25/#28 and related fanout branches are one research program, not six product TODOs.
- Cap3, resource, route-recovery, Viewer-MBB, signaling-blackhole, Host-generation, SFU-shaping, NAT, mobile, and endurance artifacts remain bounded evidence. Merge or retain them only when a current decision consumes them. The isolated strict-NAT harness authorizes no product path until its gate passes; raw-IP ranking, AirPlay/Cast receivers, and mobile background guarantees are not implied by the current implementation batch.
- Real heterogeneous-network SFU/TURN, mobile lifecycle, audio/A-V device, and endurance/resource acceptance are scheduled at the relevant release boundary.

## Candidate Handling

- Preserve `fix/configurable-relay-cap`, but do not commit or merge it. Its relevant intent must be rebuilt after route truth is accepted.
- Preserve dirty or unique worktrees and open stacked branches until reviewed. Never resolve their conflicts by importing old truth into `main`.
- Sample worktree, branch, PR, artifact, and reparse-point state immediately before cleanup; do not maintain a permanent workspace inventory here.
