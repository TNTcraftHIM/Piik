# Project Instructions

## Product Direction

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends.
- This is not a public or large-scale streaming product; users can use OBS/Twitch-class services for that workload.
- Keep the media path P2P-first. Use centralized services for rooms, authentication, signaling, STUN, observability, and bounded SFU-root capacity; TURN is an optional transport compatibility fallback.
- Let viewers join from a normal desktop or mobile browser without installing the sender application.
- STUN is required. The target automatic ladder is direct/peer ICE over UDP, then an SFU virtual parent feeding at most two roots, then optional authenticated TURN for deployments that explicitly cover restrictive networks, followed by a clear bounded failure. Ordinary peer edges must not receive TURN candidates by default merely to maximize rare-network coverage. HTTPS/WSS remains TLS/TCP and is independent of this media-transport policy.
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
- Make focused commits, push the branch, open a pull request, pass checks, merge, and delete the branch. Direct changes to `main` require an explicit exception.
- Keep unrelated work out of a branch. Update tests, docs, ADRs, project memory, and status in the same pull request when their source facts change.
- Follow `CONTRIBUTING.md` and the pull request template. Never rewrite shared history unless the user explicitly requests it.

## Context Hygiene

- Keep this root file concise and stable; put specialized rules in the closest relevant directory only when that code exists.
- Never store raw transcripts, large logs, generated summaries, temporary plans, or facts that can be cheaply rediscovered in always-loaded memory.
- When a fact changes, update it in place and remove conflicting text in the same change. Do not preserve obsolete guidance merely for history.

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
- Add automated tests in proportion to behavioral risk. For realtime media changes, also document the manual network and browser matrix used.
- Batch validation by risk and phase: run narrow checks while iterating, and run expensive full suites, browser matrices, endurance tests, or deployment checks only at an acceptance boundary or when a relevant change invalidates prior evidence. Documentation-only or unrelated changes do not invalidate media-path evidence.
- Use comments for non-obvious rationale, invariants, protocol constraints, and workarounds; do not narrate obvious code.
- Use WebRTC statistics and reproducible measurements for latency, bitrate, candidate type, packet loss, encode time, and quality limitations. Do not claim performance from assumptions alone.
- Keep repository scripts and hooks cross-platform, deterministic, fast, and runnable in CI. A hook must call a tracked script rather than hide project logic in machine-local configuration.
- Before finishing a material task, inspect `git status`, report untracked project artifacts, and stage files created for the requested work unless the user asks not to stage them.
