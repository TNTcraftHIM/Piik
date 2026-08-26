# Current TODO Ledger

Last reviewed: 2026-08-26

Only **Now** is executable. A branch, old experiment, observation, or accepted
later topic is not implementation authority by itself.

## Now

1. **Adaptive Browser H.264.** Implement the accepted sender-scoped actual-sender
   preflight with a deterministic moving probe track at the current share target.
   Proved Host/relay senders prefer H.264 with native VP8 fallback;
   failed or inconclusive senders use VP8. The Host decision owns its one SFU
   publication with backup codec disabled. Add no codec UI, wire state,
   persistent cache, parallel codec route, or active-edge churn.
2. **Preferred room simplification and replacement.** Keep the server dormant
   lease unchanged, but store the latest preferred code without a client expiry
   or renewal timer. After H.264, add the Host refresh-icon action immediately
   left of copy: retire the old room through the normal lifecycle so its
   credentials, password, invitation and routes become invalid, then allocate a
   new room and update the local preference.
3. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari matrices for
   autoplay gesture, foreground/background audio, foreground video recovery,
   lock/page reclamation, rotation, Wi-Fi/cellular migration, and assigned-relay
   survival or controller recovery. Web does not promise background video or
   relay execution after OS suspension.
4. **Finish real-network route and media acceptance.** Exercise direct peer,
   Browser relay, SFU, relay-ingress recovery with subtree retention,
   disconnect/capacity drain, Pause/Resume, source replacement, screen-audio
   continuity, and real-game A/V sync across representative IPv4/IPv6,
   Wi-Fi/cellular, and Host/Viewer TUN/VPN cases. Verify two simultaneous rooms
   can own independent SFU publications. Include an all-UDP-blocked case and
   weak-network audio after SFU RED was disabled. Every exhausted path must end
   in bounded wait/failure without TURN, TCP probing, NAT classification,
   guessed candidates, or another watchdog.

## Accepted Later Roadmap

1. **Platform output only when real.** Revisit AirPlay/Cast only when a target
   browser and physical receiver prove the live `MediaStream` contract. System
   mirroring remains external.
2. **Public-server one-click package.** After functional and real-network work,
   package the exact application, STUN/SFU, reverse proxy, secrets, and health
   checks for a user-owned public server. Do not call a partial installer ready.
3. **Fully local one-click package.** Package Windows/macOS/Linux Host capture,
   application server, and local state without requiring source or Node. Report
   public-origin, TLS, gateway, NAT, and firewall limits honestly.
4. **Native Host and shared encode, Windows first.** Productize only after real
   capture, hardware-only encode, audio, identity, RTP/RTCP feedback, resource,
   packaging, and licensing gates pass. Browser Host/relay keeps standard
   per-`RTCPeerConnection` encoding.
5. **Whole-product UI and bilingual decision.** Once media and route behavior
   stabilizes, review copy, responsive hierarchy, visual consistency, restrained
   motion, bundle/rendering cost, and Chinese/English scope once as a whole.
   Terminal and error views should retain the global header and an obvious way
   back home. Ordinary screen-specific edits do not create parallel documentation.
6. **Client-input security review.** Inventory HTTP and WebSocket inputs once as
   a whole: strict schemas, authentication, authorization, rate and body bounds,
   resource effects, error disclosure, logging, and secret handling. Begin
   read-only and add no parallel security framework without a proven gap.
7. **Repository simplification audit.** After the Browser, route, room, and
   physical-media checkpoints settle, inventory components, configuration,
   migrations, timers, compatibility paths, tests, and truth duplication using
   the [maintenance review](./maintenance.md#机制减负审查). Begin read-only and do
   not turn it into a broad refactor.

## Product Decision Needed

| Item | Decision |
| --- | --- |
| Repository and distribution license | Decide before public release or package distribution. GPL/AGPL implementations remain research-only until then. |
| Optional SQLite persistence | Default memory rooms remain accepted. Define the complete opt-in durable authority, stored fields, inactive retention, credential/grant rotation and recovery before implementation. It may restore rooms and authorization across restart, but media still reconnects and recommits; unspecified future data is not scope. |
| Quality-driven route exploration | The intended model includes exact-child active reparenting, relay ingress reparent with subtree retention, relay egress abdication/drain, and Host egress convergence onto one SFU publication while SFU-fed Viewers may still relay. Research must first unify their evidence, reservations, probation/restore and recovery under the existing single graph/operation; no active quality route change is authorized yet. |

## Evidence Boundaries

- Desktop Host background/minimized capture remains diagnostic until a current-
  production real-game reproduction correlates capture, outbound, inbound,
  decode, and CPU/GPU. Viewer resume correction is not a keepalive guarantee.
- Synthetic and loopback tests validate invariants, not target-network quality,
  latency, capacity, mobile lifecycle, or endurance.
- Open Native and packaging branches are retained evidence/candidates, not
  current releases.

## Candidate Handling

- Preserve dirty or unique worktrees and open stacks until reviewed. Never
  import old truth wholesale.
- Sample worktree and branch state immediately before cleanup rather than
  maintaining a permanent inventory here.
