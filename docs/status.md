# Current Status

Last updated: 2026-08-22

This file is the current execution index. Load [verification status](./verification-status.md) only when evidence or acceptance boundaries are relevant; Git history owns completed timelines.

## Production

- `https://share.bonfire.icu` runs exact `66eb337171931edaf5d621600c3803a186cf85ac`, release `66eb33717193`, wire `screener-v5`; `d315d333e0a8` is the rollback release.
- `screener`, LiveKit, coturn, and nginx are active, local/public health return 200, and `screener` has `NRestarts=0`. SQLite remains schema v3 with five rooms and mode 0600.
- Ordinary ICE is STUN-only. Production allows SFU roots <=2, one `peer-selected` attempt excluding Host ingress, selected UDP TTL 120, room admission default eight with explicit limits from one through sixteen, and two downstream edges per Web endpoint. `MAX_PEER_RELAY_DOWNSTREAM_EDGES` is unset, so the parameterized default is active.
- Stable SFU, route/transport truth, pause notices, entry/nickname UI, selected-edge lease authority, corroborated bad-relay demotion, Share audio presets, local media-path diagnostics, pre-share self-check, privacy-safe diagnostic export, and peer-quality MBB v1 are live. MBB v1 selects only an ordinary peer-upstream Viewer candidate; Host/SFU-root provisional children and sibling MBB remain open. Native remains source-only.

## Current Product Snapshot

- Capture precedes room creation. Balanced, automatic codec, and 128 kbps screen audio are defaults; clarity/fluid, H.264/VP8, and 64/128/256 kbps audio are deployed next-share choices. Codec and audio quality lock during a share.
- Local-only connection details expose current Host SFU sender evidence, actual codec/fmtp and encoder fields, media-source/encode FPS evidence, A/V playout/jitter/concealment evidence, and selected candidate endpoints. These fields do not enter quality signaling, server state, logs, persistence, or route selection.
- The deployed pre-share self-check uses disposable, no-room resources for health, WSS, and STUN `srflx` checks and treats configured SFU as unverified until a real route. Expanded connection details provide click-only, versioned JSON export; its fixed allowlist excludes candidate addresses/ports, participant and room identity, raw signaling, URLs, and credentials, and no report is uploaded or persisted.
- Private fragment grants enter directly; code-only Viewers need site access and private rooms additionally need their password. Credentials remain unstored. Web names and presence are session-only; duplicate names alone show an ID suffix.
- Rooms default to eight Viewers and accept an explicit admission limit from one through sixteen. Roots and ordinary Web relays are bounded to two downstream edges, Viewer upstream receive is free, and source permits an explicit endpoint cap from one through three. SFU root capacity remains separate.
- Relay quality handling compares fresh child FPS with parent input. Two current corroborating children can pause one Viewer relay for 30 seconds and request peer-only reassignment. Deployed MBB v1 keeps the triggering child's old edge while one ordinary peer-upstream Viewer proves current-generation RTP, decoded frames, and live video; it excludes Host/SFU roots, preserves ready-failure identity through commit/rollback, and lets unrelated hard failures preempt the soft probe. Failure, timeout, or no candidate keeps the old edge without SFU/TURN. Sibling MBB remains open.
- A generation-bound 15-second initial-connect deadline enters ICE restart. One-root healthy-SFU make-before-break is deployed but media-unverified; capacity `0 -> 1`, multi-root, browser, and mobile gates remain open.

## Active Milestone

1. Verify the deployed Share audio presets and local observability on target browsers and real routes: field availability, actual values, negotiated/observed bitrate, audible quality, A/V synchronization evidence, candidate endpoints, and route switches.
2. Run one representative production-room UDP/frame/cap/stop canary. Validate initial ingress, `peer-selected`, bad-relay reparenting, and healthy SFU reselection without changing the STUN-only ordinary-peer policy.
3. Run exactly-two/Dynacast-off zero-child SFU BWE/resource evidence before implementing explicit evacuation or another media selector.
4. Complete Native package download, Viewer2/FIFO, hardware/endurance, and game A/V evidence; use target-device or production measurements for performance decisions.
5. Finish ADR-0004 relay resource/quality and heterogeneous-network gates. A 20-viewer matrix is required before any accepted scale-default change; mobile remains a compatibility observation, not a capacity class.

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
