# Project Instructions

## Product Direction

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends.
- This is not a public or large-scale streaming product; users can use OBS/Twitch-class services for that workload.
- Keep media distributed and automatic. Use centralized services for rooms, authentication, signaling, STUN, observability, and bounded SFU-root capacity. TURN is an optional authenticated selected-edge compatibility transport, disabled unless explicitly configured; it is not a media topology.
- Let viewers join from a normal desktop or mobile browser without installing the sender application.
- STUN is required. The target ladder is direct/peer UDP, then an SFU/UDP virtual parent feeding at most two roots, then optional authenticated selected-edge TURN, followed by a clear bounded failure. Ordinary peer edges must not receive TURN candidates by default. HTTPS/WSS remains TLS/TCP and is independent of this media-transport policy.
- Every non-server endpoint has at most two active downstream media edges; an upstream receive edge does not consume this upload budget. Browser relays remain stricter at one downstream edge until their re-encode/resource gates pass. Central media normally serves at most two roots; extra server-fed exceptional viewers require an explicit deployment egress/admission cap and must never create unbounded fanout.
- Treat a web client as the initial delivery target. A packaged desktop sender or native capture helper is a later optimization, not an assumed requirement.
- Do not silently change the product into an always-SFU conferencing system. An SFU is a virtual parent for one or two necessary roots whose peer descendants remain distributed; record any broader topology change as an ADR with measured justification.

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
- Keep changes scoped and preserve unrelated user work.
- Prefer the smallest proven extension point; do not add speculative frameworks, hooks, or abstractions without a current consumer.
- Add automated tests in proportion to behavioral risk. Block the current phase on P0 security, privacy, irreversible data, authorization, generation, bounded-resource, and rollback failures, plus P1 failures of the milestone's core user path. Record or cover P2/P3 rare environments, diagnostic detail, and minor UI edges cheaply without turning them into canary blockers unless they can cause P0 harm. Use high-repeat race runs only for a reproduced concurrency failure. For realtime media changes, also document the manual network and browser matrix used.
- Batch validation by risk and phase: run narrow checks while iterating, and run expensive full suites, browser matrices, endurance tests, or deployment checks only at an acceptance boundary or when a relevant change invalidates prior evidence. Documentation-only or unrelated changes do not invalidate media-path evidence.
- Use comments for non-obvious rationale, invariants, protocol constraints, and workarounds; do not narrate obvious code.
- Use WebRTC statistics and reproducible measurements for latency, bitrate, candidate type, packet loss, encode time, and quality limitations. Do not claim performance from assumptions alone.
- Keep repository scripts and hooks cross-platform, deterministic, fast, and runnable in CI. A hook must call a tracked script rather than hide project logic in machine-local configuration.
- Before finishing a material task, inspect `git status`, report untracked project artifacts, and stage files created for the requested work unless the user asks not to stage them.
