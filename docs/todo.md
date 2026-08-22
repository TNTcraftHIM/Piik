# Current TODO Ledger

Last reviewed: 2026-08-22

Only items in **Now** are executable after their stated decision gate. A branch name, unchecked requirement, experiment, review suggestion, or deployed behavior is not a TODO by itself.

## Now

1. **Route wave A: endpoint capacity and accounting.** From the latest canonical `main`, atomically bump the incompatible signaling wire and replace the Browser/role tiers with `ENDPOINT_MEDIA_COPY_CAPACITY=1|2|3`, default `2`. A peer child or Host publication consumes one steady sender slot, upstream receive is free, committed selected TURN replaces the same logical edge transport, and a media-producing candidate needs the one bounded overlap reservation. Reject an old client before room authority, reject a fourth Host copy when `C=3`, and keep parent-wide quality drain fail-closed until its accepted evidence owner exists. Do not merge the old configurable-cap worktree.
2. **Switch screen-audio ceilings live.** Keep Opus fixed and serialize 64/128/256 kbps desired profile updates across every current Host, relay, and SFU audio sender. Each endpoint uses fresh `getParameters()`/`setParameters()` readback, ignores stale completions, retains media plus its prior applied value on failure, and applies the latest desired value to future edges. Do not add a remote applied-ack protocol or claim room-wide atomic convergence in this slice.
3. **Rebuild the LAN one-command launcher.** From fresh canonical `main`, transplant only the useful launcher/tests/wrappers from `feat/local-oneclick-bundle`, replace its stale access variable with `SITE_ACCESS_PASSWORD`, keep local SQLite state out of Git, and verify startup, health, localhost Host, and LAN Viewer output on PowerShell and POSIX boundaries. This is a source-checkout launcher, not an installer or public deployment system.
4. **Switch video codec while paused.** After the route/media-generation boundary is available, serialize the change with route mutation, freeze exact current route/media bindings, hold new joins, renegotiate P2P/relay and republish SFU while paused, then verify actual codec plus decoded frames on resume. A binding invalidated by leave or hard route failure exits this proof set and waits for routing to rebuild from the final committed preference after the bounded codec transaction settles. On failure pause again and perform bounded rollback; rollback proves the prior preference was reapplied plus a newly negotiated actual codec and decoded progress, not literal equality with the old actual codec. Zero targets update only the future-edge preference. Reset `automatic` with empty codec preferences. This is a paused bounded-gap transaction; unpaused make-before-break is a later extension.
5. **Diagnose the production H.264/blur report.** Reproduce exact release `769de201f7cc` against current `main` on the same Host/browser/driver/game and one wired direct Viewer, changing one variable at a time. Implement a codec-specific repair only if codec/encoder evidence identifies it; otherwise fix the proven capture, sender, BWE, or lifecycle cause.
6. **Route waves B-D: bounded fallback and controller convergence.** Replace the temporary fixed SFU subscriber guard with explicit deployment-wide SFU ingress/egress admission; then replace the temporary room-wide selected-lease guard with per-edge TURN allocation admission and exact accounting. Only after those resource owners exist, converge allocation, child reparent, and relay drain on one committed graph/controller. The temporary guards are safety boundaries, not accepted product limits, and must not be removed early.
7. **Validate and release.** Run focused state-machine tests, child-vs-parent quality ownership, cap `1/2/3` topology and recovery matrices, constrained Host/SFU/TURN paths, audio/codec mutation, independent review, build/full gates, bounded production preflight, deployment, postflight, and rollback verification.

The existing route implementation is an input to these tasks. Preserve its verified generation, authorization, make-before-break, and media-proof invariants while migrating capacity and fallback accounting. The accepted model is the destination; each wave must remain safe and truthful on its own rather than installing a name-only controller or an unreserved overlap.

## Accepted Later Roadmap

These items are real product work, ordered after the current release boundary; they are not permission to resume an old branch wholesale.

1. **Native shared encode, Windows first.** Prove one hardware encoder output can serve two independent Viewer transports and the Host-SFU publication while each connection retains its own RTP/RTCP, pacing, encryption, feedback, and upload accounting. Productize only after actual access-unit identity, Viewer2/FIFO, heterogeneous feedback, game-resource, browser/hardware, A/V, packaging, and licensing gates pass. Web Host/relay remains standard per-`RTCPeerConnection` encoding because no portable shared-encoder contract exists.
2. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari device matrices for autoplay gesture, foreground/background audio, foreground video recovery, lock/page reclamation, rotation, and Wi-Fi/cellular migration. Preserve the same media element and current reconnect path; do not promise background video composition or unsupported lock-screen behavior.
3. **Distributable sender.** Turn a proven Windows native path into a signed, installable, updateable sender before expanding capture/audio backends to macOS and Linux. A source checkout or evaluation ZIP is not a self-contained cross-platform client.
4. **Real network acceptance.** Measure standard ICE/STUN, IPv4/IPv6, independent STUN destinations, selected TURN, SFU ingress, and bounded failure across representative NATs and mobile networks. Do not implement browser port prediction, raw-IP ranking, or a room-wide quality score; parent choice uses exact edge evidence and the accepted route controller.
5. **Platform output only when real.** Revisit AirPlay/Cast only when a target browser and physical receiver prove the live `MediaStream` contract. System mirroring remains external; no placeholder button, custom receiver, or server transcode is scheduled.

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
- Cap3, resource, route-recovery, Viewer-MBB, signaling-blackhole, Host-generation, SFU-shaping, NAT, mobile, and endurance artifacts remain bounded evidence. Merge or retain them only when a current decision consumes them. Browser NAT/port prediction, raw-IP ranking, AirPlay/Cast receivers, and mobile background guarantees are not implied by the current implementation batch.
- Real heterogeneous-network SFU/TURN, mobile lifecycle, audio/A-V device, and endurance/resource acceptance are scheduled at the relevant release boundary.

## Candidate Handling

- Preserve `fix/configurable-relay-cap`, but do not commit or merge it. Its relevant intent must be rebuilt after route truth is accepted.
- Preserve dirty or unique worktrees and open stacked branches until reviewed. Never resolve their conflicts by importing old truth into `main`.
- Sample worktree, branch, PR, artifact, and reparse-point state immediately before cleanup; do not maintain a permanent workspace inventory here.
