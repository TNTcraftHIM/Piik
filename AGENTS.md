# Project Instructions

## 1. Decision And Durable Truth

- Highest priority: before implementation, cleanup, or deployment, settle the meaning against the whole product model and evidence, challenge contradictions or needless complexity, and write the accepted decision to its owning truth documents. Discussions, examples, review suggestions, experiments, checkboxes, and agent ideas are inputs, not implementation authority; never turn a partial interpretation into code or a branch.
- Apply Occam's razor as "simple, not simplistic": prefer standards, mature framework behavior, and one small general mechanism that covers the product model. When a concrete failure appears, fix the owning invariant or reconciliation loop first; add a case-specific branch, gate, probe, timer, state container, or test only when evidence shows the general mechanism cannot cover it. Do not implement by repeatedly patching examples.
- Until the owner explicitly declares a public release, maintain only the current internal product contract. Do not preserve backward or forward compatibility, legacy wire/config aliases, dual parsers or writers, translators, deprecated APIs, migration shims, or tests whose only consumer is an older release. Upgrade the private deployment atomically, reject stale clients before authority, delete replaced surfaces, and use Git history for rollback. Reassess compatibility only when public release requirements are explicitly opened.
- Before dependent work starts, update every affected owning requirement, design, ADR or research conclusion, plus `docs/project-memory.md` and `docs/status.md` when their snapshots change. Checkpoint the consistent truth in Git; chat is not durable truth.
- If semantics remain disputed, record the hold in `docs/todo.md` and freeze only dependent work. Do not encode a guess as accepted truth.
- **Current-truth ("Dongpo pork") rule:** after a correction, current docs, UI, code, comments, configuration, and PR copy state only the accepted behavior and rationale that still constrains it. Remove rejected alternatives and explanations of their removal; Git history owns that history.
- Queue new observations in their owner and continue the active milestone unless the user requests immediate investigation or the evidence reveals a P0 blocker.

## 2. Safety And Privacy

- Never commit credentials, TLS private keys, access tokens, or real user data. Commit only placeholder configuration and document local secret injection.
- Server-assisted media credentials are short-lived and narrowly authorized; rooms use authentication or unguessable expiring invitations. Do not log or persist private media-path identifiers beyond their accepted owner.
- Block the current phase on P0 security, privacy, authorization, irreversible-data, generation, bounded-resource, or rollback failures and on P1 failures of its core path.

## 3. Product Contract

- Build private, low-latency game screen sharing for one broadcaster and up to `20` authenticated Viewers, not a public or large-scale streaming service.
- A normal desktop or mobile browser is the initial Viewer target. A packaged sender or native capture helper is a later optimization.
- Keep media distributed and automatic. Central services own rooms, authentication, signaling, STUN, observability, and bounded fallback resources; do not silently make the product always-SFU.
- STUN and direct/peer UDP remain first; the only application fallback is the dedicated LiveKit SFU over UDP. Screener configures no TURN, ICE/TCP, media TCP, or TLS-relayed media path. Every accepted path ends in bounded success or clear failure, and HTTPS/WSS transport is independent of media transport.
- Every non-server endpoint uses one server-authoritative steady outbound media-copy cap: default `2`, configurable as `1`, `2`, or `3`. A peer child or the Host's single SFU publication consumes one slot; upstream receive is free, and SFU subscriber egress is accounted at the server. Browser role, UA, visibility, and client advertisement do not create another tier.
- The accepted route model is one committed graph, one event-driven reconciliation loop, and at most one room-serial child operation. That operation owns one deterministic candidate list/cursor, one current candidate with its reservations, and one total deadline; its exact child commits on the first newly decoded frame. Join/waiting, child reparent, relay ingress repair with subtree retention, confirmed departure, and effective-capacity reduction all use this operation. A failed exact candidate is already tried for that operation, so other direct parents come first and SFU is the bounded suffix; no persistent parent blacklist is created.
- WebRTC and LiveKit own ICE/DTLS/consent, congestion control, transient reconnect, and SFU stream state. Screener does not add all-pairs endpoint probing, parent-wide quality inference, a weighted route score, periodic rebalancing, or an independent depth cap. SFU is one Host publication with per-Viewer subscriptions, and endpoint overlap plus SFU resources remain independently admitted and bounded. Any future strict-firewall transport must be accepted as a LiveKit-internal capability from real evidence, not added as another application route candidate.

## 4. Canonical Repository And Integration

- Keep the canonical repository root on a clean, current `main` at audit and integration boundaries. Create branches and worktrees from that exact commit; an auxiliary worktree or old branch is never a truth source.
- Merge an accepted truth checkpoint before integrating dependent candidates. Rebase or rebuild each retained candidate from that exact `main` once, preserve main's owning truth on conflicts, and transplant only approved scoped code, tests, and new facts.
- Cleanup is last. Preserve user work and verify integration, open references, branch equivalence, and link/reparse safety before removing a worktree or branch.
- Follow `CONTRIBUTING.md` for branch, research, validation, PR, merge, cleanup, and local-hook details.

## 5. Truth Map

- Start substantial work by reading `docs/project-memory.md`, `docs/status.md`, `docs/todo.md`, the relevant requirement/design, ADR, and research documents, then inspect the current branch and Git state.
- Current requirements and design live in `docs/需求理解.md` and `docs/方案设计.md`; decisions live in `docs/adr/`; evidence lives in `docs/research/`.
- `docs/project-memory.md` is the durable product snapshot, `docs/status.md` is the current execution/deployment index, and `docs/todo.md` is the only current work ledger. Git history owns the completed timeline.
- Give each fact one owner, replace stale text in place, keep status as an index rather than an archive, and update `docs/README.md` when documents move or change status.

## 6. Engineering Defaults

- Apply Occam's razor: implement the smallest complete design with a current consumer, keep unrelated work out, preserve user changes, and avoid speculative frameworks or hooks.
- Research non-trivial design, implementation, and bug fixes from current primary sources. Record durable findings and license boundaries under `docs/research/`.
- Add tests and independent review in proportion to risk. Batch expensive browser, network, endurance, and deployment checks at acceptance boundaries; use reproducible WebRTC measurements for performance claims.
- Keep comments limited to non-obvious rationale and invariants. Keep scripts and hooks deterministic, fast, cross-platform, and CI-runnable.
- Support Windows, macOS, and Linux; avoid absolute paths and OS-specific separators. Text files use LF, and new filenames use ASCII unless an established user-facing convention requires otherwise.
- Before finishing material work, inspect Git status, report untracked project artifacts, and stage requested files unless told otherwise.
