# Project Instructions

## Product Direction

- Build private, low-latency game screen sharing for one broadcaster and a small group of trusted friends.
- This is not a public or large-scale streaming product; users can use OBS/Twitch-class services for that workload.
- Keep the media path P2P-first. Use centralized services for rooms, authentication, signaling, STUN, observability, and TURN fallback.
- Let viewers join from a normal desktop or mobile browser without installing the sender application.
- STUN and authenticated TURN fallback are required. "P2P-first" must never mean "direct-only"; fallback is decided independently for every viewer.
- Treat a web client as the initial delivery target. A packaged desktop sender or native capture helper is a later optimization, not an assumed requirement.
- Do not silently change the product into an always-SFU conferencing system. Record any topology change as an ADR with measured justification.

## Repository Knowledge

- At the start of substantial work, read `docs/project-memory.md`, `docs/status.md`, and the relevant requirement, ADR, and research documents.
- Keep durable project decisions, requirements, research, code, and agent configuration inside this repository and Git-tracked.
- Do not leave required project context only in chat history, a user home directory, or an untracked scratch file.
- Treat `docs/project-memory.md` and `docs/status.md` as bounded current snapshots, not append-only journals. Replace or remove stale facts and use Git history for the timeline.
- Update project memory when a durable decision changes, before context compaction on long tasks, and at task handoff. Use `docs/adr/` for architecture decisions and tradeoffs.
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
- On a long session, checkpoint accepted decisions and current state before relying on automatic context compression. After compression or resumption, re-read the current snapshots and inspect Git state.
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
- Use comments for non-obvious rationale, invariants, protocol constraints, and workarounds; do not narrate obvious code.
- Use WebRTC statistics and reproducible measurements for latency, bitrate, candidate type, packet loss, encode time, and quality limitations. Do not claim performance from assumptions alone.
- Keep repository scripts and hooks cross-platform, deterministic, fast, and runnable in CI. A hook must call a tracked script rather than hide project logic in machine-local configuration.
- Before finishing a material task, inspect `git status`, report untracked project artifacts, and stage files created for the requested work unless the user asks not to stage them.
