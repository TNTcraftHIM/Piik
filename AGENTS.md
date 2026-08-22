# Project Instructions

## Durable Truth Before Action

- Do not turn a discussion, correction, example, review suggestion, experiment, checkbox, or agent idea directly into implementation. First restate the intended outcome and its source rationale, reconcile it against the whole current product model and any conflicting evidence, and challenge assumptions that are inconsistent or unnecessarily complex.
- Before implementation work or implementation sub-agents begin, update every affected owning truth document: current requirement and design, accepted ADR or research conclusion when applicable, `docs/project-memory.md`, `docs/status.md`, and this file when a global rule changed. Replace conflicting current text in place, then create a Git-tracked checkpoint so the decision survives compaction and handoff.
- If the semantic decision is still disputed, record a truth hold and freeze only dependent work. Do not encode a guess as accepted truth. Code, merge, deployment, and cleanup may start only after the nonvolatile truth set is internally consistent.
- Merge the accepted truth checkpoint before integrating dependent candidates. Rebase or rebuild each retained candidate from that main exactly once; resolve conflicts from main's owning truth and transplant only approved scoped code, tests, and new facts. Never let an older branch's `AGENTS.md`, requirements, ADRs, memory, status, or deployment snapshot overwrite newer truth.
- After an audit or integration boundary, restore the canonical repository root to a clean, up-to-date `main` before starting new implementation. Do not leave `main` checked out in an auxiliary worktree. Preserve overlapping user changes explicitly, then create every new branch and worktree from the exact canonical `main` commit; an auxiliary worktree is never the source of current truth.
- Cleanup is last. Remove a worktree or branch only after the semantic decision, integration, and main-equivalence/open-reference checks are complete; never delete first to simplify a decision or later reintroduce an old branch wholesale.

## Temporary TODO Audit Hold

- `docs/todo-audit-hold.md` is the execution quarantine while the 2026-08-22 truth audit is open. An unchecked box, old branch, agent proposal, experiment, review suggestion, or post-boundary follow-up is not an authorized TODO unless that ledger marks it `CONFIRMED` or the user explicitly reauthorizes it after the audit boundary.
- `AUDIT-HOLD` means preserve and inspect, not delete, revert, continue, merge, deploy, or use as current product truth. `EVIDENCE-ONLY` results may inform a later decision but must not become a release gate by themselves.
- The older Browser1 and global-SFU-root-two assumptions are disputed and must not drive implementation during the audit. The currently confirmed endpoint-cap intent is one server-authoritative value for every non-server endpoint: default `2`, configurable as `1`, `2`, or `3`, with upstream receive excluded. The exact SFU publication/subscription model is still under holistic routing review.
- Execute this audit in order: first reconcile TODO provenance and current truth owners; second produce the archive/worktree/branch/folder disposition schedule; third merge the audit-guard truth and restore the canonical `main` workspace; fourth produce the holistic routing model as a held proposal without implementation. Later phases must not run ahead merely because parallel capacity is available.
- Then stop and reconcile the canonical state, routing proposal, and remaining TODOs with the user. Do not accept the final routing semantics or create/resume remaining-TODO implementation worktrees before that explicit confirmation. Afterward, update and merge the accepted owning truth into canonical `main` first; only then create high-confidence parallel worktrees from that exact newer `main` SHA.

## Product Direction

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends.
- This is not a public or large-scale streaming product; users can use OBS/Twitch-class services for that workload.
- Keep media distributed and automatic. Use centralized services for rooms, authentication, signaling, STUN, observability, and bounded fallback media resources. Current production includes optional selected-edge TURN, but its retained role and placement are under the routing truth audit; it is not by itself a topology.
- Let viewers join from a normal desktop or mobile browser without installing the sender application.
- STUN is required and direct/peer UDP remains first. Ordinary peer edges must not receive TURN candidates by default. The exact SFU/TURN fallback order and accounting are held for the holistic routing audit; every accepted path must terminate in a clear bounded success or failure. HTTPS/WSS remains TLS/TCP and is independent of this media-transport policy.
- Every non-server endpoint has one server-authoritative ordinary downstream capacity: default `2`, configurable as `1`, `2`, or `3`. An upstream receive edge does not consume it, Browser role/UA/visibility does not change it, and a client advertisement cannot exceed the deployment value. SFU and TURN are bounded fallback resources, but publication, subscription, selected transport, temporary overlap, and server-resource accounting remain frozen for the holistic routing audit rather than being inferred from ordinary-child counts.
- Treat a web client as the initial delivery target. A packaged desktop sender or native capture helper is a later optimization, not an assumed requirement.
- Do not silently change the product into an always-SFU conferencing system. Any accepted server-assisted path must preserve the small-room, distributed-media goal unless an ADR with measured justification changes it.

## Repository Knowledge

- At the start of substantial work, read `docs/project-memory.md`, `docs/status.md`, and the relevant requirement, ADR, and research documents.
- Treat the Git-tracked repository as the persistent source of truth. Before dependent work continues, write every accepted requirement or priority, design change, durable research conclusion or retained candidate, actionable TODO or blocker, and material status change to its owning repository document; chat alone is not a durable record.
- Maintain one minimal truth set: current snapshots in `docs/project-memory.md` and `docs/status.md`, current requirements and design in their specifications, decisions in `docs/adr/`, evidence in `docs/research/`, and the timeline in Git history. Replace stale facts in place and do not duplicate detailed content into this file.
- Checkpoint that truth set at material phase boundaries, after accepted decisions change, at branch/PR or agent handoff, and before likely context compaction or a long pause. After compaction or resumption, re-read the snapshots and inspect Git state before continuing.
- Keep `docs/README.md` current when documentation is added, moved, or superseded.

## Research Before Changes

- Before non-trivial design, implementation, or bug fixing, inspect the current repository and research current official documentation and established reference implementations.
- Add community issue discussions or recent papers when they materially improve the answer. Prefer primary sources, record access dates, and distinguish verified facts from inference.
- Store durable findings and links under `docs/research/`; update or supersede stale conclusions instead of accumulating contradictory advice.
- Check licenses before copying code. GPL/AGPL sources are study-only until the project license and distribution model are decided.

## Git Workflow

- Work on a short-lived branch for each coherent change. Use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `spike/` prefixes.
- Treat GitHub Actions as an acceptance-boundary resource: feature branches and pull requests use local gates and do not trigger workflows; run Actions only for `main` integration, releases, or explicit manual dispatch. Do not retry zero-step or infrastructure failures.
- Keep work-in-progress and checkpoint branches local. Do not push a branch merely for backup, agent handoff, or intermediate review; after local validation and review, push it once to open the final pull request. Direct changes to `main` require an explicit exception.
- Default to squash-merging each coherent, non-stacked pull request so `main` receives one meaningful `feat`, `fix`, `docs`, or other conventional commit. Use a merge commit only for an explicitly stacked dependency whose parent ancestry must remain intact; do not use ordinary merge by habit.
- Delete a remote branch only after verifying that its pull request is merged, its current head still equals the merged pull request head, and no open pull request uses it as a head or base. Keep branches required by an active stacked pull request chain.
- Once a merged branch's worktree is verified clean, remove the auxiliary worktree and local branch rather than accumulating completed branches. Before any local worktree or directory removal, resolve the exact absolute target and enumerate contained reparse points, junctions, and symlinks without following them. Verify every link target and handle the link itself with a non-following operation first; never run recursive deletion while an unresolved reparse point remains.
- Keep unrelated work out of a branch. Update tests, docs, ADRs, project memory, and status in the same pull request when their source facts change.
- Before the first push, a local branch may be rebased onto the latest `main` to keep the pull request focused. Follow `CONTRIBUTING.md` and the pull request template; never rewrite shared history unless the user explicitly requests it.

## Context Hygiene

- Keep this root file concise and stable; put specialized rules in the closest relevant directory only when that code exists.
- Never store raw transcripts, large logs, generated summaries, temporary plans, or facts that can be cheaply rediscovered in always-loaded memory.
- When a fact changes, update it in place and remove conflicting text in the same change. Do not preserve obsolete guidance merely for history.
- Remove rejected alternatives from active UI, code, comments, configuration, PR copy, and current docs. Describe current behavior by what it does; retain rationale only when it still constrains a live decision.

## Security

- Never commit credentials, TURN shared secrets, TLS private keys, access tokens, or real user data.
- Commit example configuration with placeholder values and document how local secrets are supplied.
- TURN credentials must be short-lived in production. Rooms must be authenticated or protected by unguessable, expiring invitations.

## Cross-Platform Work

- Support development from Windows, macOS, and Linux. Avoid absolute paths and OS-specific path separators in code and configuration.
- Prefer repository scripts or package-manager commands that behave consistently across platforms.
- Text files use LF unless `.gitattributes` explicitly requires otherwise.
- Use ASCII filenames for new files unless a user-facing language or an established project convention requires Unicode.

## Engineering Workflow

- Apply Occam's razor: choose the simplest design that satisfies the verified requirement, and stop there. Avoid over-engineering for hypothetical scale or future features.
- Treat new observations and follow-up ideas as queued input: record them in the owning requirement, design, research, or status document, then continue the active milestone. Interrupt current work only when the user explicitly requests immediate investigation or the new evidence reveals a P0 blocker.
- Keep changes scoped and preserve unrelated user work.
- Prefer the smallest proven extension point; do not add speculative frameworks, hooks, or abstractions without a current consumer.
- Add automated tests in proportion to behavioral risk. Block the current phase on P0 security, privacy, irreversible data, authorization, generation, bounded-resource, and rollback failures, plus P1 failures of the milestone's core user path. Record or cover P2/P3 rare environments, diagnostic detail, and minor UI edges cheaply without turning them into canary blockers unless they can cause P0 harm. Use high-repeat race runs only for a reproduced concurrency failure. For realtime media changes, also document the manual network and browser matrix used.
- Use independent review for routing or protocol state machines, security/privacy boundaries, large features, and milestone integration. Narrow changes should normally close with focused tests plus the relevant typecheck/build; do not start a separate reviewer for every small feature.
- Treat `docs/status.md` as a current index, not an archive. When it approaches its budget, remove completed or stale facts that Git history already owns; move still-relevant detail to the owning requirement, ADR, research, or deployment document and leave a short link or index entry. Create a scoped second-level status document only when no existing owner fits; never micro-compress prose merely to satisfy the byte gate.
- Batch validation by risk and phase: run narrow checks while iterating, and run expensive full suites, browser matrices, endurance tests, or deployment checks only at an acceptance boundary or when a relevant change invalidates prior evidence. Documentation-only or unrelated changes do not invalidate media-path evidence.
- Use comments for non-obvious rationale, invariants, protocol constraints, and workarounds; do not narrate obvious code.
- Use WebRTC statistics and reproducible measurements for latency, bitrate, candidate type, packet loss, encode time, and quality limitations. Do not claim performance from assumptions alone.
- Keep repository scripts and hooks cross-platform, deterministic, fast, and runnable in CI. A hook must call a tracked script rather than hide project logic in machine-local configuration.
- Before finishing a material task, inspect `git status`, report untracked project artifacts, and stage files created for the requested work unless the user asks not to stage them.
