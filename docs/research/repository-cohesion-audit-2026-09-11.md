# Repository Cohesion Audit

- Started: 2026-09-11
- Candidate baseline: `fe199cf4`
- Follow-up review baseline: `b9d8348c`; corrections are included in this record.
- Scope: Piik-owned source, tests, scripts, workflows and durable documentation.
  Third-party implementation internals and deferred physical-device matrices are
  outside this audit.
- Status: static audit and deterministic verification complete on
  `audit/repository-cohesion` (local branch, not pushed or merged). Physical and
  deferred acceptance remains owned by
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
| Browser UI orchestration and state projection | Complete | Requested/applied quality, route facts and derived presentation have distinct owners. One shared kind module removes the comic/hint source dependency cycle. Unproven source-switch replay was removed after caller review; page size remains a tradeoff below. |
| Browser media/WebRTC/native adapters | Complete | Pooling and encoded-group boundaries match ADR-0013/0014. The dead `PeerSnapshot` warning chain was removed, and snapshots now carry keyed failure facts instead of resolved copy. |
| Go room authority and persistence | Complete | Durable-before-memory authority and caller locking remain coherent; no parallel room backend was found. |
| Go signaling and route effects | Complete | Test-only route seeding moved to the test harness. Route diagnostics now use an injected sink, so the route package no longer reads the environment or global logger. |
| Native App control/capture/mediaedge | Complete | `nativecontrol` composes, `nativehost` owns sessions, and `mediaedge` owns media resources without reverse ownership. No lifecycle failure was established. |
| Protocol, HTTP, configuration and release contracts | Complete | Shared fixtures and strict command contracts remain aligned. A stale v22 evidence snapshot was corrected to the current v23 contract. |
| Tests, gates, packaging, workflows | Complete | The main workflow built the Browser bundle twice; the duplicate build was removed. Dead-feature tests were deleted with their state, and a packaging-target check that no runner collected now runs under vitest. No additional unused product export was established by the scoped scan. |
| Documentation and public copy ownership | Complete | Product/design/reference ownership is one-directional; `engineering.md` now also carries runtime lifecycles and a source index, four ownerless evidence documents are cited by their owners, and long-document warnings remain accepted gardening notices. |

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
   formed one cyclic source/type dependency group and inverted the documented UI boundary. A shared
   `src/client/ui/visual-kinds.ts` now owns the kind unions, theme and scene
   signature; scene implementations did not move. The type-erased runtime graph
   was already acyclic. This improves source ownership, not runtime performance.
6. **Dead media-warning state chain (dead state removed).**
   `PeerSnapshot.qualityWarning`/`qualityWarningKind`, `QualityWarningKind` and
   the `HostPeer` sender-warning/limitation sampling that fed them had no
   product consumer. Sender health continues to reach the server through
   `senderQualityEvidenceFromSnapshot` metrics. The two tests that asserted the
   dead fields were deleted with the state; suite 709 -> 707.
7. **Route diagnostics read the environment and global logger (boundary
   violation).** `internal/server/route` directly read
   `PIIK_DEBUG` and wrote `slog`; `internal/server/signal` duplicated the
   parser. `route.Options.DebugLog` is now an injected sink, and `signal` owns
   environment, logger and retention policy. The route debug test now verifies
   injection rather than environment parsing. The sink still runs synchronously
   under the caller's lock and may perform file I/O; injection does not remove
   that existing cost. Package and engineering descriptions now say so.
8. **Resolved copy persisted inside media/transport layers (boundary
   violation).** `HostPeer`, `ViewerPeer`, the SFU publisher/route and the
   native peers resolved user copy with `say()` and stored the string in
   `PeerSnapshot.error` or their warning fields. A live language switch kept
   stale text until the next media event, and `ViewerPeer` could persist a raw
   DOMException message. Snapshots now carry `MediaFailure` facts
   (`{ key, paramKeys?, vars? }`) that the presentation layer resolves during
   render (`src/client/ui/media-failure.ts`); raw exceptions stay in the debug
   log. `joinItems`/`joinSentences` take the language explicitly and
   `currentLang()` serves non-React notices. The vestigial `sfuWarning`
   parameter of `sourceSwitchNotice`, `null` at both call sites, was removed
   with its test-only branch, and three English-only native failures gained
   localized keys.
9. **Dead verification test (confirmed defect).** `scripts/client-package-targets.test.mjs`
   used `node:test`, but no runner included it: vitest only collects
   `tests/**/*.test.ts` and no script invoked `node --test`, so its cgo-policy
   assertion never ran. It is now `tests/client-package-targets.test.ts` under
   the standard entry point; the tools TypeScript program allows JavaScript so a
   test can import that plain-ESM tooling module.
10. **Orphaned evidence documents (ownership cleanup).**
    `docs/adr/0008-window-scoped-audio-capture.md` and
    `docs/research/nat-traversal.md`, `embedded-media.md` and
    `cross-restart-room-recovery.md` had no inbound link from the owner that
    depends on them. Each is now cited by `media-quality.md`, ADR-0009, ADR-0013
    and `rooms-access.md` respectively; the orphan sweep is now empty.

## Deferred Tradeoffs

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

The external verification below belongs to `b9d8348c` and its recorded rehearsal
revision, not to a newly accepted release:

- `npm run check`: TypeScript build, 711 tests across 55 files and the production
  Browser bundle passed; independently repeated at that revision.
- `tests/media-failure.test.ts` covers fact resolution per language, param-key
  joining, list rendering and literal variables. The original tests missed the
  real SFU producer's `{params}` / `{stage}` mismatch; follow-up added a failing
  route-to-resolver regression and aligned both locale templates.
- `go vet ./internal/... ./cmd/...` passed.
- `go test ./internal/... ./cmd/...` passed, including route, signal, app,
  native and media packages.
- `npm run check:client-core` passed: gofmt, Go tests, vet, Windows/Linux App and
  peer-gate builds, and the Linux Server build. This core entry excludes capture
  checks; Darwin requires a macOS toolchain. The
  [rehearsal record](./lifecycle-audit-2026-09-10.md#remaining-acceptance) separately
  attributes capture and package-smoke evidence.
- The source import graph had one cyclic component with nine modules, now zero.
  Counting each import declaration as an edge gives 17 elementary cycles;
  deduplicating module-pair edges gives 15. The type-erased runtime graph had
  zero cycles before and after.
- `node scripts/check-docs.mjs` and `scripts/check-project-state.ps1` passed
  with only the existing long-document gardening warnings.
- Physical mixed-version, device and network acceptance remains outside this
  pass. Candidate/package work remains in [TODO](../todo.md); broader physical
  limits remain in [verification status](../verification-status.md).

Follow-up closure reran `npm run check`: 55 files and 711 tests passed, with
typecheck and the Browser build. One unproven replay test was removed and one
real SFU failure-to-localized-warning check added. Repository hygiene and diff
checks passed; only existing document-length and bundle-size warnings remain.
The follow-up Go edits correct comments only, so the earlier Go verification
was not repeated. No new App/Server package or physical acceptance is claimed.

## Sweep Method

The mechanical sweeps behind the adversarial review are repeatable with a
reference scan over tracked files:

- Copy keys: every key in `src/client/locales/zh.ts` must appear outside
  `src/client/locales` in a source, test, script or document.
- Icons and comic kinds: every `PATHS` entry in `src/client/ui/icons.tsx` and
  every `ComicKind` member must be referenced outside its definition file, with
  preview pages excluded when counting product producers.
- Documents and tools: every `docs/**/*.md` filename and every `scripts/`
  basename must be mentioned by at least one other tracked file.
- Configuration: every environment identifier read by Go is either documented
  for operators or a test or sidecar handshake value.
- Import cycles: resolve local imports under `src/client` and distinguish the
  source/type graph from the type-erased runtime graph. Count strongly connected
  components separately from elementary cycles as described above.

Reference hits, including tests and documents, establish references rather than
product reachability. These scans are leads for caller tracing, not proof that
the entire repository has no remaining dead code.

## Adversarial Review

Checked after the change landed, against the ways this pass could be wrong:

- **Current snapshot producers retain copy keys.** Reviewed media snapshots,
  SFU warnings and native failures retain keys and resolve during render;
  `MediaFailure.vars` still admits strings, so the type alone cannot prevent
  every future producer from storing resolved copy. `say(` no longer appears under
  `src/client/webrtc`, `sfu` or `native`, and the only media-layer `say()` left
  is `qualitySettingsLabel`, which composes a transient notice at event time -
  the tolerated pattern documented in `ui/copy.ts`. Event-time notices and
  `ApiError` messages still resolve once, which is the accepted policy rather
  than an oversight.
- **One fact, one resolver.** Transport owners produce `MediaFailure`; only
  `resolveMediaFailure` renders it. The focused test covers params, lists and
  literal variables, and a mutation that drops `paramKeys` fails it.
- **Deliberate residual.** `lib/display-name.ts` still resolves the default
  display name once. That is presence data other participants see, so it must
  not follow a local language switch; recorded instead of changed.
- **Inert guard removed.** No current notice composer produces the separate SFU
  warning. Follow-up removed `hostSfuWarningText !== noticeText` rather than
  preserving a comparison for a hypothetical future producer.
- **Declined micro-cleanups.** `MediaFailure` lives in `ui/` and media modules
  import it type-only; `CopyKey` type imports still point at `ui/copy` rather
  than `locales`. Both are type-only edges with a cycle scan of 0, so repointing
  them was not worth the review surface.
- **No extra equality helper.** The SFU warning state is now a small array, so React no
  longer bails out on identical primitive values. `syncHostSfuQualityWarning`
  runs only on quality changes, route transitions and SFU config - never per
  frame or per evidence message - so no structural-equality helper was added.
- **Mechanical sweeps after the fixes.** The external reference scan reported
  hits for all 394 copy keys and 49 icons, no orphan documents or unreferenced
  `scripts/` tools, and documentation or a test/sidecar-only role for every
  environment identifier read by Go. This is bounded reference evidence. The
  unreferenced npm aliases that remain are one-line operator conveniences over
  real scripts (`gate:*`, `package:client*`, `test:watch`), so they stay.
- **UX deltas reviewed.** The missing-video-track path now reports
  "no shareable screen source" instead of "failed to create the connection";
  Viewer failures no longer
  retain raw browser messages in snapshots, though the current Viewer page does
  not display that field directly. Joined SFU warnings use the locale separator
  instead of a hardcoded `"; "`, and follow-up fixed their recovery-stage text.
- **Unproven lifecycle repair removed.** The initial source-switch replay test
  bypassed disabled controls. Follow-up removed that path and its test after
  tracing all callers; the existing live quality queue remains intact. The
  [lifecycle record](./lifecycle-audit-2026-09-10.md#rejected-source-switch-replay)
  owns the evidence and reopening condition.
- **Comment correctness.** Local configuration intentionally copies STUN lists
  into non-nil slices so configured-empty prediction does not derive auxiliary URLs;
  the audit's comment claiming nil was preserved was corrected without changing
  the implementation. Dangling comment fragments left by mechanical deletion in
  config/access parsing were also removed or corrected.

## References

- [React: State as a Snapshot](https://react.dev/learn/state-as-a-snapshot) and
  [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
  support deriving presentation from current facts rather than synchronizing
  parallel UI state.
- [React: Queueing State Updates](https://react.dev/learn/queueing-a-series-of-state-updates)
  explains why separate user clicks see the disabled state from the previous
  event; direct-function tests still need a real request producer.
- [TypeScript: Type-Only Imports](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html)
  distinguishes source/type dependencies from runtime imports.
- [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) supports
  package-level responsibility and avoiding historical commentary in current
  interfaces.
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
  supplied the accessibility/focus/motion checklist used for the UI pass.
