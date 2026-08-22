# Project Instructions

## 1. Decision And Durable Truth

- Treat discussions, examples, review suggestions, experiments, checkboxes, and agent ideas as inputs, not implementation authority. Restate the intended outcome and rationale, reconcile it against the whole product model and evidence, and challenge contradictions or needless complexity.
- Before dependent implementation or implementation agents start, update every affected owning requirement, design, ADR or research conclusion, plus `docs/project-memory.md` and `docs/status.md` when their snapshots change. Checkpoint the consistent truth in Git; chat is not durable truth.
- If semantics remain disputed, record the hold in `docs/todo.md` and freeze only dependent work. Do not encode a guess as accepted truth.
- **Current-truth ("Dongpo pork") rule:** after a correction, current docs, UI, code, comments, configuration, and PR copy state only the accepted behavior and rationale that still constrains it. Remove rejected alternatives and explanations of their removal; Git history owns that history.
- Queue new observations in their owner and continue the active milestone unless the user requests immediate investigation or the evidence reveals a P0 blocker.

## 2. Safety And Privacy

- Never commit credentials, TURN shared secrets, TLS private keys, access tokens, or real user data. Commit only placeholder configuration and document local secret injection.
- Production TURN credentials are short-lived and narrowly authorized; rooms use authentication or unguessable expiring invitations. Do not log or persist private media-path identifiers beyond their accepted owner.
- Block the current phase on P0 security, privacy, authorization, irreversible-data, generation, bounded-resource, or rollback failures and on P1 failures of its core path.

## 3. Product Contract

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends, not a public or large-scale streaming service.
- A normal desktop or mobile browser is the initial Viewer target. A packaged sender or native capture helper is a later optimization.
- Keep media distributed and automatic. Central services own rooms, authentication, signaling, STUN, observability, and bounded fallback resources; do not silently make the product always-SFU.
- STUN and direct/peer UDP remain first. Ordinary peer edges receive no TURN candidates by default, and every accepted path ends in bounded success or clear failure. HTTPS/WSS transport is independent of media transport.
- Every non-server endpoint uses one server-authoritative ordinary downstream cap: default `2`, configurable as `1`, `2`, or `3`. Upstream receive is free; Browser role, UA, visibility, and client advertisement do not create another tier.
- SFU/TURN publication, subscription, selected transport, overlap, and server-resource accounting remain held in the current routing TODO until their holistic model is accepted.

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
