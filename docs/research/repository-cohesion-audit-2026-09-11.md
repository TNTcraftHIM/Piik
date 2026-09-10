# Repository Cohesion Audit

- Started: 2026-09-11
- Candidate baseline: `fe199cf4`
- Scope: Piik-owned source, tests, scripts, workflows and durable documentation.
  Third-party implementation internals and deferred physical-device matrices are
  outside this audit.
- Status: static audit and deterministic verification complete on this branch.
  Physical and deferred acceptance remains owned by
  [verification status](../verification-status.md).

## Audit Questions

1. Does each module own one coherent responsibility, or is orchestration,
   policy, presentation, I/O or resource retirement mixed across boundaries?
2. Are permission, capability, readiness, requested settings, applied settings,
   observation and terminal failure represented as distinct facts?
3. Do TypeScript, Go, UI copy, configuration, package metadata and documents use
   the same name for the same concept and different names for different facts?
4. Are dependencies one-directional and explicit? Are there cycles, hidden
   globals, duplicate truth, reverse layer calls or speculative wrappers?
5. Is each test/gate/script tied to a real contract or failure mode, or only to
   current implementation details?
6. Can a smaller ownership boundary or deletion produce the same verified
   behavior without reducing viewing quality, accessibility or recoverability?

## Method

Start from the current source and documented owners, not old branches or chat
summaries. Build an import/call map, trace representative end-to-end flows, and
inspect each candidate with its callers. A finding requires a concrete sequence
or maintained duplicate owner. Search hits, line count and subjective style are
leads only.

For every accepted finding, trace why the boundary drifted before proposing a
repair. Prefer deleting a superseded state, path or check; when deletion is not
possible, change the one acquiring/owning boundary rather than adding guards at
callers. A local symptom patch is not an accepted resolution. Each module review
identifies acquisition, authoritative commit, replacement and retirement before
its lifecycle is considered mapped.

Compare non-obvious practices with primary sources from mature projects. Consult
those sources for design rationale only; do not copy implementation code or add
a dependency without a separate accepted decision.

## Coverage Matrix

| Area | Status | Findings |
| --- | --- | --- |
| Browser UI orchestration and state projection | Complete | Requested/applied quality, route facts and derived presentation have distinct owners. The 17 local type cycles around comic/hint kinds were removed by one shared kind module. Page size remains a tradeoff below. |
| Browser media/WebRTC/native adapters | Complete | Pooling and encoded-group boundaries match ADR-0013/0014. The dead `PeerSnapshot` warning chain was removed. Localized strings inside media snapshots remain a recorded tradeoff. |
| Go room authority and persistence | Complete | Durable-before-memory authority and caller locking remain coherent; no parallel room backend was found. |
| Go signaling and route effects | Complete | Test-only route seeding moved to the test harness. Route diagnostics now use an injected sink, so the route package no longer reads the environment or global logger. |
| Native App control/capture/mediaedge | Complete | `nativecontrol` composes, `nativehost` owns sessions, and `mediaedge` owns media resources without reverse ownership. No lifecycle failure was established. |
| Protocol, HTTP, configuration and release contracts | Complete | Shared fixtures and strict command contracts remain aligned. A stale v22 evidence snapshot was corrected to the current v23 contract. |
| Tests, gates, packaging, workflows | Complete | The main workflow built the Browser bundle twice; the duplicate build was removed. Dead-feature tests were deleted with their state. No unused product exports remain. |
| Documentation and public copy ownership | Complete | Product/design/reference ownership is one-directional; long-document warnings remain accepted gardening notices. |

## Finding Classification

- **Confirmed defect:** reachable incorrect behavior or a maintained contract
  mismatch.
- **High-confidence improvement:** clear ownership/simplicity gain with bounded
  risk.
- **Tradeoff:** materially changes architecture, compatibility, operations or
  product behavior; requires owner decision.
- **Unproven lead:** needs a reproduction or measurements; take no action now.

## Landed Findings

1. **Documentation contract drift (confirmed defect).** `verification-status.md`
   still named Browser/server v22 while code, status and deployment owned v23.
   Corrected to v23 and re-dated.
2. **Test-only seeding lived in production route code (ownership cleanup).**
   `Controller.hydrateEdge`, `hydrateHostPublication` and `committedEdgeSeed`
   now live in `internal/server/route/harness_test.go`; the production
   controller exposes no test-only seeding API.
3. **Duplicate CI build (workflow cleanup).** The validation job built the
   Browser bundle and then re-built it through `npm run check`. The final step
   now type-checks and tests the already-built tree; packaging still builds
   independently.
4. **Historical commentary (ablation).** Standalone `TS: ...` comparison
   comments were removed; comments that still explain an observable
   browser/wire-parser difference were retained. Package docs for `config`,
   `protocol` and `ordered` now describe current responsibility instead of an
   older implementation lineage.
5. **Type-kind dependency cycles (confirmed cohesion defect).**
   `Comic.tsx`, `comic-presentation.ts`, `hints/*` and `ui/media-status.ts`
   formed 17 local cycles and inverted the documented UI boundary. A shared
   `src/client/ui/visual-kinds.ts` now owns the kind unions, theme and scene
   signature; scene implementations did not move. Cycle scan: 17 -> 0.
6. **Dead media-warning state chain (dead state removed).**
   `PeerSnapshot.qualityWarning`/`qualityWarningKind`, `QualityWarningKind` and
   the `HostPeer` sender-warning/limitation sampling that fed them had no
   product consumer. Sender health continues to reach the server through
   `senderQualityEvidenceFromSnapshot` metrics. The two tests that asserted the
   dead fields were deleted with the state; suite 709 -> 707.
7. **Route diagnostics read the environment and global logger (boundary
   violation).** `internal/server/route` is documented as no-I/O but read
   `PIIK_DEBUG` and wrote `slog`; `internal/server/signal` duplicated the
   parser. `route.Options.DebugLog` is now an injected sink, and `signal` owns
   environment, logger and retention policy. The route debug test now verifies
   injection rather than environment parsing.

## Deferred Tradeoffs

- **Localized copy inside media/transport layers.** `HostPeer`, `ViewerPeer`
  and SFU adapters call `say()` and persist translated warning/error strings in
  snapshots; a live language switch can leave stale-language copy until the
  next media event. The root fix is a typed `{ key, detail? }` fact resolved by
  the presentation layer. It changes an internal snapshot contract across
  host/viewer peers, SFU routes and both pages, so it is recorded for owner
  decision instead of being patched at each call site.
- **Large orchestration surfaces.** `HostPage.tsx` and `ViewerPage.tsx` remain
  large owners, and `signal` serializes room effects with one lock. No measured
  contention or behavior failure justifies a speculative split; extraction
  follows a concrete change.
- **Browser encoding pool and Native output groups.** Intentionally detailed
  under ADR-0013/0014 and not split for style.
- **Over-length documents** remain explicit gardening warnings rather than
  correctness failures.

## Non-Findings

- `DecodeServerMessage`, `sfutest.FakeMedia` and the route harness helpers are
  consumed by contract/route tests; no deletable product export was found.
- No duplicate visual grammar or room-authority truth was found; product,
  design and reference ownership is one-directional.
- Go room authority remains durable-before-memory with caller locking.

## Verification

- `npm run check`: TypeScript build, 707 tests across 53 files and the production
  Browser bundle passed.
- `go vet ./internal/... ./cmd/...` passed.
- `go test ./internal/... ./cmd/...` passed, including route, signal, app,
  native and media packages.
- Local import-cycle scan across `src/client`: 17 cycles before, 0 after.
- `node scripts/check-docs.mjs` and `scripts/check-project-state.ps1` passed
  with only the existing long-document gardening warnings.
- Physical mixed-version, device and network acceptance remains outside this
  pass and is owned by [verification status](../verification-status.md).

## References

- [React: State as a Snapshot](https://react.dev/learn/state-as-a-snapshot) and
  [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
  support deriving presentation from current facts rather than synchronizing
  parallel UI state.
- [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) supports
  package-level responsibility and avoiding historical commentary in current
  interfaces.
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
  supplied the accessibility/focus/motion checklist used for the UI pass.
