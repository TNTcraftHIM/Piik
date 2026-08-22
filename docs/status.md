# Current Status

Last updated: 2026-08-22

This file is the current execution index. Load [verification status](./verification-status.md) only when evidence or acceptance boundaries are relevant; Git history owns completed timelines.

## Production

- `https://share.bonfire.icu` runs exact `9461e207af62b4f38f6b7a8aa16f8beb49e0e4ee`, release `9461e20`, wire `screener-v5`; `21d5cd9f7139` is the rollback release.
- `screener`, LiveKit, coturn, and nginx are active, local/public health return 200, and `screener` has `NRestarts=0`. SQLite remains schema v3 with five rooms and mode 0600.
- Ordinary ICE is STUN-only. Production allows SFU roots <=2, one `peer-selected` lease across negotiating and answered states excluding Host ingress, selected UDP TTL 120, and room admission default eight with explicit limits from one through sixteen. `MAX_PEER_RELAY_DOWNSTREAM_EDGES` is unset, so effective downstream capacity is Host2/ordinary Browser Viewer1; active, provisional, selected, and Host SFU publication edges count. The wire remains `screener-v5`.
- Stable SFU, route/transport truth, pause notices, entry/nickname UI, selected-edge lease authority, corroborated bad-relay handling, Share audio presets, local media-path diagnostics, pre-share self-check, privacy-safe diagnostic export, signaling-partition recovery, and peer-quality MBB are live. An ordinary Viewer with a peer/SFU upstream or the Host may own one separately budgeted provisional child; sibling MBB remains open. Native remains source-only.

## Current Product Snapshot

- Capture precedes room creation. Balanced, automatic codec, and 128 kbps screen audio are defaults; clarity/fluid, H.264/VP8, and 64/128/256 kbps audio are deployed next-share choices. Codec and audio quality lock during a share.
- Local-only connection details expose current Host SFU sender evidence, actual codec/fmtp and encoder fields, media-source/encode FPS evidence, A/V playout/jitter/concealment evidence, and selected candidate endpoints. These fields do not enter quality signaling, server state, logs, persistence, or route selection.
- Deployed local details additionally show the selected pair's cumulative STUN responses and a bounded same-pair sample delta. This remains observation-only and does not trigger recovery or upload the pair identity.
- The deployed pre-share self-check uses disposable, no-room resources for health, WSS, and STUN `srflx` checks and treats configured SFU as unverified until a real route. Expanded connection details provide click-only, versioned JSON export; its fixed allowlist excludes candidate addresses/ports, participant and room identity, raw signaling, URLs, and credentials, and no report is uploaded or persisted.
- Production now stabilizes identity-bound remote-evidence detail shells, applies exact per-field five-second expiry with earliest-deadline timers, clears terminal/session/share/route generations, and admits only fresh presentations to diagnostic export. It adds no wire, server, or media-generation state. Target-browser field availability and actual media values remain an open verification gate.
- Private fragment grants enter directly; code-only Viewers need site access and private rooms additionally need their password. Credentials remain unstored. Web names and presence are session-only; duplicate names alone show an ID suffix.
- Rooms default to eight Viewers and accept an explicit admission limit from one through sixteen. Current source is server-authoritative and role-aware: Host physical media edges are bounded to two, ordinary Browser Viewer downstream edges to one, and upstream receive is free. Active/provisional/selected overlays count, as does Host SFU publication. Deployment values 1/2 may only tighten these limits; old/malicious Viewer advertisements 2/3 cannot lift them. Web assignment execution also truncates physical children to Host2/Viewer1 as defense-in-depth, and deployment limit one promotes an occupied Host branch root before reserving the SFU publication slot. The wire retains `0/1/2/3` only as a future envelope, and SFU roots remain separately bounded to two.
- Production deploys the root <=2 controller/token invariant, Host-publication edge accounting, zero-child assignment/subscriber retention, and `dynacast: false` with ordered active `q,h`. Local `gate:sfu-root-invariants` proves that control-plane boundary; real shaped LiveKit packet flow, BWE downshift/recovery, and resource cost remain open.
- Relay quality handling compares fresh child FPS with parent input. Two-child corroboration is retained only for a future accepted capacity tier and is unreachable under the ordinary Browser Viewer1 release clamp. Deployed MBB keeps the triggering child's old edge while an ordinary Viewer with peer/SFU upstream or the Host, each with a strict spare slot, owns a separate provisional child PC. Matching current-generation RTP, decoded frames, live video, revision, and identity promote that same PC; Host2 accounting includes its SFU publication and selected/provisional overlays. Failure, timeout, session/share change, or no candidate keeps the old edge without SFU/TURN. Sibling MBB remains open.
- A generation-bound 15-second initial-connect deadline enters ICE restart. One-root healthy-SFU make-before-break is deployed but media-unverified; capacity `0 -> 1`, multi-root, browser, and mobile gates remain open.

## Active Milestone

1. Verify the deployed Share audio presets and local observability on target browsers and real routes: field availability, actual values, negotiated/observed bitrate, audible quality, A/V synchronization evidence, candidate endpoints, and route switches.
2. Run one representative production-room UDP/frame/cap/stop canary. Validate initial ingress, `peer-selected`, bad-relay reparenting, and healthy SFU reselection without changing the STUN-only ordinary-peer policy.
3. Run pinned LiveKit with isolated per-leaf shaping to prove zero-child SFU BWE downshift/recovery and resources before implementing explicit evacuation or another media selector; the root-invariant/Dynacast-off gate is deployed.
4. Complete Native package download, Viewer2/FIFO, hardware/endurance, and game A/V evidence; use target-device or production measurements for performance decisions.
5. Run the Host2/ordinary Browser Viewer1 relay resource/quality and heterogeneous-network gates. ADR-0004 cap2/cap3 results remain historical experiments. A 20-viewer matrix is required before any accepted scale-default change; mobile remains a compatibility observation, not a capacity class.

## Decisions And Blockers

- ADR-0004/0005 remain No-Go for broad rollout. DNS/TLS, independent secrets, UDP 7882, and bounded services are deployed, but real external media/device evidence and the isolated VM/IP clean-port gate remain open.
- Initial deployment region and expected network cohort are undecided.
- Project license and distribution model are undecided; GPL/AGPL sources remain study-only.

## Detail Index

- [Verification status](./verification-status.md): current cross-cutting evidence, open proof boundaries, and expensive-test applicability.
- [Project memory](./project-memory.md): accepted product constraints, recommendations, implementation snapshot, targets, and open decisions.
- [Requirements](./%E9%9C%80%E6%B1%82%E7%90%86%E8%A7%A3.md) and [design](./%E6%96%B9%E6%A1%88%E8%AE%BE%E8%AE%A1.md): current acceptance contract and implementation design.
- [ADR-0004](./adr/0004-peer-assisted-media-experiment.md) and [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md): peer-assisted and automatic-routing decisions.
- [Deployment](./deployment.md): production configuration, rollback boundary, and transport operations.
- [Research index](./README.md): media, routing, audio, Native, security, and context-governance evidence owners.
