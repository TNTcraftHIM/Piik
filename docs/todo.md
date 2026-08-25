# Current TODO Ledger

Last reviewed: 2026-08-25

Only **Now** is executable. A branch, old experiment, observation, or accepted
later topic is not implementation authority by itself.

## Now

1. **Close the Viewer lifecycle/native-control release.** Integrate the staged
   `fix/viewer-page-lifecycle` candidate from the accepted truth checkpoint,
   run the full repository check, review the exact diff, merge through PR,
   deploy one immutable application artifact, and perform scoped production
   postflight. Verify native Viewer controls plus current-route P2P and SFU
   reconnect without adding route reselection.
2. **Finish real-network route and media acceptance.** Exercise direct peer,
   Browser relay, SFU, relay-ingress recovery with subtree retention,
   disconnect/capacity drain, Pause/Resume, source replacement, screen-audio
   continuity, and real-game A/V sync across representative IPv4/IPv6,
   Wi-Fi/cellular, and Host/Viewer TUN/VPN cases. Include an all-UDP-blocked case
   and weak-network audio after SFU RED was disabled. Every exhausted path must
   end in bounded wait/failure without TURN, TCP probing, NAT classification,
   guessed candidates, or another watchdog.

## Accepted Later Roadmap

1. **Browser VP8 hardware evidence.** Measure supported Chrome/Edge platforms
   under real game load using actual codec, encoder implementation, encode time,
   frame rate, and CPU/GPU attribution. Do not add another codec, custom encoder,
   GPU selector, or Native helper without a new decision.
2. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari matrices for
   autoplay gesture, foreground/background audio, foreground video recovery,
   lock/page reclamation, rotation, Wi-Fi/cellular migration, and assigned-relay
   survival or controller recovery. Web does not promise background video or
   relay execution after OS suspension.
3. **Quality-based topology research.** After the real-network baseline, decide
   whether measured user-visible quality justifies any active parent-selection
   mechanism. Current evidence cannot compare an active route with an
   unconnected alternative, so no quality score, all-pairs probing, periodic
   rebalancing, relay abdication threshold, or active parent switch is accepted.
   Prefer mature algorithms and one general model if this boundary is reopened.
4. **Platform output only when real.** Revisit AirPlay/Cast only when a target
   browser and physical receiver prove the live `MediaStream` contract. System
   mirroring remains external.
5. **Public-server one-click package.** After functional and real-network work,
   package the exact application, STUN/SFU, reverse proxy, secrets, and health
   checks for a user-owned public server. Do not call a partial installer ready.
6. **Fully local one-click package.** Package Windows/macOS/Linux Host capture,
   application server, and local state without requiring source or Node. Report
   public-origin, TLS, gateway, NAT, and firewall limits honestly.
7. **Native Host and shared encode, Windows first.** Productize only after real
   capture, hardware-only encode, audio, identity, RTP/RTCP feedback, resource,
   packaging, and licensing gates pass. Browser Host/relay keeps standard
   per-`RTCPeerConnection` encoding.
8. **Whole-product UI and bilingual decision.** Once media and route behavior
   stabilizes, review copy, responsive hierarchy, visual consistency, restrained
   motion, bundle/rendering cost, and Chinese/English scope once as a whole.
   Ordinary screen-specific edits do not create parallel documentation.
9. **Repository simplification audit.** After the Browser, route, room, and
   physical-media checkpoints settle, inventory components, configuration,
   migrations, timers, compatibility paths, tests, and truth duplication using
   the [maintenance review](./maintenance.md#机制减负审查). Begin read-only and do
   not turn it into a broad refactor.

## Product Decision Needed

| Item | Decision |
| --- | --- |
| Repository and distribution license | Decide before public release or package distribution. GPL/AGPL implementations remain research-only until then. |

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
- `fix/media-followup` is clean and tree-equivalent to current `main`; it may be
  removed only after merged-head, reference, and reparse checks.
- Sample worktree and branch state immediately before cleanup rather than
  maintaining a permanent inventory here.
