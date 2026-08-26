# Current TODO Ledger

Last reviewed: 2026-08-26

Only **Now** is executable. A branch, old experiment, observation, or accepted
later topic is not implementation authority by itself.

## Now

1. **Quality-route evidence and shadow calibration.** Make current Viewer
   quality evidence presentation-authoritative with standard freeze/pause
   deltas, continuing decoded progress, exact presentation epochs and baseline
   fencing. Keep one bounded
   current-epoch aggregate per exact child in the existing room controller and
   expose it only through the Host acceptance snapshot. It must not alter facts,
   capacity, routes or SFU usage. Collect annotated production samples before
   accepting an active trigger, probation, restore or cooldown policy. Ship it
   only as the atomic strict `screener-v13` Browser/server contract; v12 gets no
   compatibility path.
2. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari matrices for
   autoplay gesture, foreground/background audio, foreground video recovery,
   lock/page reclamation, rotation, Wi-Fi/cellular migration, and assigned-relay
   survival or controller recovery. Web does not promise background video or
   relay execution after OS suspension.
3. **Finish real-network route and media acceptance.** Exercise direct peer,
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
   not turn it into a broad refactor. The current read-only scan confirmed
   coarse `mediaAssignment` wire residue, legacy SFU room-name acceptance,
   and duplicated teardown/test/browser-gate owners as the bounded starting
   set; it did not authorize unrelated cleanup.

## Product Decision Needed

| Item | Decision |
| --- | --- |
| Repository and distribution license | Decide before public release or package distribution. GPL/AGPL implementations remain research-only until then. |
| Active quality-route action | Shadow evidence is authorized, but active changes are not. Production samples must first settle the trigger, probation, one-restore and cooldown boundaries. Any accepted exact-child reparent, relay abdication/drain or Host convergence onto one SFU publication must reuse the existing single graph/operation and preserve SFU-fed Viewer relay; no second optimizer or periodic rebalancer is allowed. |

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
