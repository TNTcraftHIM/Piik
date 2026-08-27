# Current TODO Ledger

Last reviewed: 2026-08-27

Only **Now** is executable. Observations, old branches, experiments, and parked
topics are not implementation authority.

## Now

No product or source implementation is open after the documentation checkpoint.
Await owner direction.

## Parked Repository Work

1. **Bounded mechanism simplification.** Remove only the proved zero-consumer or
   duplicate owners: coarse `mediaAssignment` wire residue, legacy SFU room-name
   acceptance, orphan `scripts/browser-codec-preflight.ts`, and the access gate's
   test-title scan. Keep the production
   `src/client/webrtc/video-codec-preflight.ts`, live internal media-assignment
   helpers, and destructive-path safety gates.

## Parked Product Work

1. **Quality-driven route selection.** Strict v13 evidence remains diagnostic.
   Any future decision must use the existing graph/operation and must not add a
   score, all-pairs probe, periodic rebalancer, or ordinary SFU preference.
2. **Mobile Viewer lifecycle.** Run Android Chrome and iOS Safari matrices for
   autoplay, background audio, foreground recovery, lock/page reclamation,
   rotation, network migration, and relay survival.
3. **Representative network acceptance.** Complete public-network direct,
   Browser relay, SFU, recovery, Pause/Resume, screen-audio, real-game A/V,
   two-room SFU, 20-Viewer endurance, and all-UDP-blocked bounded failure.
4. **Per-share peer-only mode.** Add one default-off pre-share Host setting that
   excludes SFU for that share and ends in the existing bounded failure.
5. **Whole-product UI and bilingual decision.** Review copy, responsive
   hierarchy, visual consistency, restrained motion, rendering cost, terminal
   navigation, and Chinese/English scope once media behavior stabilizes.
6. **Client-input security review.** Audit HTTP/WebSocket schema, auth,
   authorization, rate/body/resource bounds, errors, logs, and secrets without
   adding a parallel security framework.
7. **Public-server package.** Package the exact Web/signaling, STUN/SFU, proxy,
   secrets, health, and recovery contract for a user-owned server.
8. **Fully local package.** Package Host capture, application server, and local
   state for Windows/macOS/Linux with honest TLS, gateway, NAT, and firewall
   limits.
9. **Native Host and shared encode.** Revisit Windows first only after capture,
   hardware encode, audio, RTP feedback, resources, packaging, licensing, and
   Browser interoperability are proved.
10. **Platform output.** Revisit AirPlay/Cast only when a target Browser and
    physical receiver prove the live `MediaStream` contract.

## Decision Needed

- Choose the repository and distribution license before public release or
  package distribution. GPL/AGPL implementations remain research-only until
  then.
