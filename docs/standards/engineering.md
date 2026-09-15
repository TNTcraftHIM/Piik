# Engineering And Interface Boundaries

This is the shared engineering convention for Browser, App and Server work.
[AGENTS.md](../../AGENTS.md) owns task authority and hard product constraints;
[CONTRIBUTING.md](../../CONTRIBUTING.md) owns the delivery workflow. The required
[ponytail guidance](../../.agents/skills/ponytail/SKILL.md) selects the smallest
correct implementation. This file owns module responsibilities and interface
discipline, not a second copy of the product contracts or wire fields.

## Repository Layout

Keep conventional project entry points and tool-discovered configuration at the
root. Scope-specific configuration belongs with its owner: `src/tsconfig.json`
checks the Browser, `scripts/tsconfig.json` checks tooling/tests, and root
`tsconfig.json` only connects those projects.

| Location | What belongs here |
| --- | --- |
| Root README, contribution and agent files | Project introduction and shared working constraints; detailed documents live in `docs/` |
| Root manifests, lockfiles, Vite/Vitest config, `index.html` | Go/npm entry points and Browser build/test startup; root `LICENSE` is authoritative |
| `src/client`, `src/shared` | Browser UI/media orchestration and its shared wire types; the same UI serves Hosted and App modes |
| `public/` | Static assets shipped with that Browser application |
| `cmd/`, `internal/` | Go executable composition and private application, server, media and diagnostics packages |
| `internal/thirdparty/` | Scoped Go dependency repairs with pinned upstream provenance, licenses and tests; removal criteria live beside the source |
| `native/capture`, `native/fixtures`, `native/probes` | Platform capture implementations, synthetic workloads and standalone capability probes |
| `site/` | Independently published static introduction; its assets do not implement product behavior |
| `scripts/` | Development checks, browser/media gates, dependency assembly and release packaging/publishing tools |
| `tests/` | TypeScript/tooling tests and cross-language fixtures; Go tests stay beside their packages |
| `deploy/` | Operator scripts and container, proxy, service and certificate templates |
| `docs/` | User guides, contracts, decisions and operations; [documentation ownership](./documentation.md) defines each owner |
| `licenses/` | Third-party license texts, pinned notice sources and their redistribution reference |
| `.github/`, `.githooks/`, `.agents/`, `.codex/` | Platform automation and scoped agent/tool integration |
| `build/`, `node_modules/`, `coverage/` | Ignored local output and dependencies; never current product truth |

`site/` introduces Piik; `src/client/` is Piik's interactive application.
`internal/app/nativecapture` adapts the capture contract in Go; `native/capture/`
implements it using platform APIs. `scripts/` prepares and verifies artifacts;
`deploy/` operates them. Move files with their actual consumers, and update paths
and checks together; a smaller root alone does not justify another abstraction.

## Module Map

| Owner | Responsibility and dependency boundary |
| --- | --- |
| `cmd/piik-server`, `cmd/piik-app` | Thin entry points: defaults, startup and shutdown; compose the same Go room service |
| `internal/server/app` | HTTP, site access, runtime capabilities, static assets and listener lifecycle; room mutations go through `signal` |
| `internal/server/signal` | Authenticated command/effect owner; serializes room, session and route mutations and executes controller decisions |
| `internal/server/room` | Room authority, credentials and persistence; caller holds the signaling lock, durable writes precede in-memory changes |
| `internal/server/route` | Synchronous room graph and single-operation decisions; returns resource effects to `signal`, owns no locks or timers, and calls its optional diagnostic sink synchronously |
| `internal/server/sfu`, `internal/app/mediaedge` | Server forwarding and native peer adapters over the shared `internal/media/forwarding`; Pion/LiveKit own transport and adaptation |
| `internal/app` | Local/public-link/Site composition, loopback service, native sessions and App lifecycle; never a second room backend |
| `internal/app/nativecapture`, `native/capture/*` | App-side capture contract and minimal platform adapters; platform-specific capture/encoding stays here |
| `src/client/pages`, `lib`, `media`, `native` | Browser orchestration and endpoint adapters; bind current media and retire owned resources |
| `src/client/media/viewer-presentation.ts`, `ui/media-status.ts` | Playback facts and their derived status projection; UI indicators do not create recovery or quality policy |
| `src/client/components`, `locales`, `ui` | Shared interaction, visual primitives and localized copy; same product interface for Server and App |
| `internal/server/webassets` | One built Browser bundle embedded by both binaries; Node/Vite are development tooling |

Names follow [naming](./naming.md). Architecture decisions explain why these
boundaries exist: [shared core](../adr/0012-shared-go-backend-core.md),
[embedded media](../adr/0013-embedded-node-local-media.md) and
[Browser pooling](../adr/0014-browser-node-local-encoding-pool.md).
Directory names are a map, not a requirement to introduce another layer.

## Contract Map

| Boundary | Schema/validation owners |
| --- | --- |
| Room HTTP and Browser/Server signaling | `src/shared/protocol.ts` and `internal/server/protocol`; HTTP dispatch in `internal/server/app`, WS dispatch in `signal` |
| Site access HTTP | `src/client/lib/api.ts` and `internal/server/app/json.go`; cookies and access behavior belong to [rooms/access](./rooms-access.md) |
| Browser/App discovery and control | `src/client/native/wire.ts`, `internal/app/loopback/protocol.go`, `internal/app/nativecontrol/wire.go` |
| App/capture sidecar | `internal/app/nativecapture` and each platform capture adapter; probe/commands and encoded-frame envelope are distinct formats |
| Configuration and persistence | `internal/server/config`, `internal/app/config`, `internal/server/room/database.go`; operator semantics in [configuration](./configuration.md) |
| Release and update metadata | Existing packaging scripts, `src/client/lib/release-update.ts`, `cmd/piik-server/release.go`; identity/compatibility in [versioning](./versioning.md), operations in [deployment](../deployment.md) |

The shared `tests/fixtures/wire-samples.json` is consumed by TypeScript and Go
fixture tests. It covers room requests and signaling; it is not a universal
schema for all HTTP, Native or capture traffic. Change the actual two ends and
the relevant existing fixture/check together. Do not create another handwritten
field list in documentation, parallel DTO hierarchy or schema generator without
a demonstrated reduction in ownership or drift.

## Runtime Lifecycles

Read each runtime as acquisition, the authoritative commit that makes its work
visible, and the retirement that ends it. Revalidate the acquiring identity
after every await or callback; presentation derives from the committed fact
instead of mirroring it.

| Runtime | Acquire | Commit | Retire |
| --- | --- | --- | --- |
| Browser Host share | `pages/HostPage.tsx` captures one source and creates its peers and route | current generation plus the owning identity: local-offer epoch, publisher slot revision, source-switch and quality-change tokens | `disposeResources` stops owned tracks, disposes peers and sends `stop-sharing`; a replaced source retires through `retiringStreamRef` |
| Browser Viewer route | `pages/ViewerPage.tsx` binds one parent peer (Browser or Native) and its relay children | parent, connection and message identity, then playback facts | a new viewer generation retires the old binding; relay children follow `activateChildren` revisions |
| Browser relay fanout | `webrtc/viewer-relay.ts` prepares a child before it is needed | `activateChildren(revision, childPeerIds)` commits the prepared set | replaced or emptied sets disconnect the child peers they own |
| Browser local encoding pool | `webrtc/host-peer.ts` attaches a pool carrier when capture and APIs support it ([ADR-0014](../adr/0014-browser-node-local-encoding-pool.md)) | the carrier binding owns its pooled producer while attached | source change or disposal releases the carrier; unsupported APIs keep ordinary senders |
| App native session | the loopback service admits native control sessions and the Web UI selects the native path | session identity plus the explicit media-path choice | session end, share end or process exit retires that edge and its capture sidecar |
| Server room authority | `signal` authenticates one Host or Viewer command | `room` writes durably before the in-memory commit; the signaling lock serializes mutations | explicit replacement or deletion, grant rotation or revocation, or process exit for memory-mode rooms |
| Server route and SFU | `signal` feeds `route` one serial child operation; `sfu/admission.go` accepts one bounded publication | one committed graph per controller and the forwarding publication | superseded assignments retire inside the same operation; deactivate retires the publication |

## Source Index

Start a change at the owning entry point, then follow the interfaces listed
above rather than searching the tree.

| Change | Start at |
| --- | --- |
| Host workflow, share lifecycle, notices | `src/client/pages/HostPage.tsx`, `src/client/pages/host-page-notices.ts` |
| Viewer workflow, playback, status projection | `src/client/pages/ViewerPage.tsx`, `src/client/media/viewer-presentation.ts`, `src/client/ui/media-status.ts` |
| Received viewer metrics and expiry | `src/client/media/viewer-quality-evidence.ts` owns evidence rules; `viewer-quality-evidence-store.ts` owns received entries and timers for Host and relay views |
| Browser peer and route mechanics | `src/client/webrtc/host-peer.ts`, `viewer-peer.ts`, `viewer-relay.ts`, `src/client/media/host-sfu-route.ts`, `viewer-sfu-route.ts`, `route-transition.ts` |
| Capture, profiles and sender parameters | `src/client/media/quality.ts`, `src/client/media/browser-encoding-pool.ts`, `browser-encoding-output.ts` |
| SFU endpoints | `src/client/sfu/publisher.ts`, `subscriber.ts`, `peer.ts`, `internal/server/sfu` |
| Localized copy and failure facts | `src/client/locales`, `src/client/ui/copy.ts`, `src/client/ui/media-failure.ts` |
| Native bridge, capture and media edges | `src/client/native`, `internal/app/loopback`, `internal/app/nativecontrol`, `nativehost`, `nativeviewer`, `nativecapture` |
| Room authority, persistence and graph | `internal/server/signal`, `internal/server/room`, `internal/server/route` |
| Shared wire contract | `src/shared/protocol.ts`, `internal/server/protocol`, `tests/fixtures/wire-samples.json` |
| Diagnostics and logging | `src/client/lib/debug.ts`, `internal/diagnostics`, [configuration](./configuration.md#diagnostics) |
| Configuration and deployment | `internal/server/config`, `internal/app/config`, [configuration](./configuration.md), [deployment](../deployment.md) |

## Implementation Rules

- Reuse a current owner, standard API or mature dependency before adding a
  mechanism. Extract around a responsibility shared by real callers; file size
  alone does not justify wrappers, a generic manager or a framework.
  Remove superseded paths in the same change; retain no unused legacy copy.
  Keep test-only state seeding and setup in test harnesses.
  Do not export mutable resources solely for tests; preserve the production
  construction path when verifying defaults or restoration.
- Review dependency direction for source/type imports as well as runtime
  imports. Shared types belong to a common owner. A type-only cycle is an
  ownership concern; it does not by itself establish a runtime or performance
  defect.
- State has one writer and a clear lifetime. Separate permission, capability,
  connection readiness, requested settings, applied settings and observation.
  Derive presentation from facts; do not synchronize parallel booleans or let
  a cached failure outlive its evidence.
  Selecting a runtime mode is not an edit to saved preferences; compare CLI,
  launcher and page write paths against the same explicit user intent.
  Cumulative observations need a valid baseline for the resource generation
  they describe; missing measurements are not zero. Serialized recovery reads
  current committed intent when it executes rather than replaying a queued snapshot.
- The operation that acquires a connection, clone, listener or queue owns its
  retirement. After an await/callback, and inside cleanup, validate the original
  operation/resource identity before changing current state. Cancellation,
  failure, missing observation and success must retain distinct meanings.
  Later cancellation must not erase a failure already observed before cleanup.
  A caller deadline does not cancel a dependency that ignores it. Keep late
  work bounded and serialize its cleanup; verify the dependency's actual lifetime.
  Ordered shutdown may require a ready auxiliary transport to outlive the stop
  request; its owner closes it after dependants retire. External convenience
  actions must not block lifecycle handling, and repeated attempts stay bounded.
- Keep decisions separate from effects. Respect documented lock ordering and
  revalidate after unlocked work. Local native capability never grants room
  authority; the shared Go service remains authoritative.
  Injected callbacks still execute in their caller's context; include their
  blocking I/O in the caller's lock and latency analysis.
- Validate input at the boundary, keep domain error meanings stable, and map
  them into shared localized UI. [Versioning](./versioning.md) determines which
  extensions are compatible; an optional field is not automatically compatible.
  Dispatch separates protocol rejection, per-request operation failure and an
  already-satisfied teardown. Late teardown is idempotent and cannot retire a
  replacement resource; retain strict validation before looking up its target.
  Retained media state carries failure facts; the presentation layer resolves
  localized copy during render. Keep raw exceptions in diagnostics. Transient
  event notices may resolve once when the event occurs.
  Values with a defined canonical form, such as HTTP origins, use one shared
  normalizer before storage and comparison. Verify the actual producer and
  consumer together instead of weakening an authorization comparison.
- Deployment configuration describes available services; room preferences
  request allowed behavior. The server enforces the policy even when a client
  requests more. The UI retains the same controls and explains locked choices.
  See [configuration](./configuration.md); avoid a second flag with the same job.
- Browser/App/Server share [visual language](./visual-language.md) and
  [status projection](./media-status.md). A new page, locale or deployment
  does not invent a new palette, status model or user-role metaphor.
- Keep package comments about current responsibilities and invariants. Historical
  migration paths belong in ADR/research unless they explain a surviving constraint.
  Support Windows, macOS and Linux; new text files use LF and new filenames use
  ASCII, with format exceptions in [`.gitattributes`](../../.gitattributes).
  Scripts use stable executable paths; physical confidence stays explicit in
  [verification status](../verification-status.md).
- Retained tools declare their direct package dependencies. Documented TypeScript
  tools join the normal type-check entry point; a transitive dependency or a
  one-off manual check is not an owned toolchain contract.
  Shipped templates use reserved example values. Checks provision isolated
  resources or require explicit targets; they must not depend on a maintainer's
  workstation, private deployment or machine-specific infrastructure names.

## Contextual Consistency

Repeated meaning has one owned contract across code, interaction, wording,
illustration, diagnostics and documentation. Shared components can still receive
conflicting caller policies. Locate related producers, consumers and the existing
[owner](./documentation.md#owners), then make its relevant contract explicit:

- **Meaning and evidence:** the subject, fact or action; who may assert it;
  its scope and generation; how unknown differs from failure or success.
- **Context and priority:** where it applies, where it does not, which user
  action it supports, and which information takes precedence.
- **Lifetime:** first appearance or acquisition, updates, replacement,
  cancellation, recovery and retirement; visibility or persistence when relevant.
- **Representations:** permitted copy, icons, motion and feedback surfaces;
  truthful runtime/platform adapters; shared implementation and validation owners.

Use the current owner. New shared rules need repeated callers or a public
contract, a reason, and proportionate evidence. Retire replaced rules and
consumers together.

Equal wording or appearance does not prove equal semantics. Compare authority,
subject, scope, evidence, lifetime and intended outcome before merging paths.
Signaling readiness and visible media, requested and applied settings, and a
retired operation versus its replacement must remain distinguishable. Runtime
and layout adaptations may differ while preserving the same contract. Explain
such differences at their owner; do not hide them in caller-specific flags or
force different authorities into a universal state manager.

The [consistency skill](../../.agents/skills/context-consistency/SKILL.md) owns the
review method; ordinary changes check their affected consumers.

These boundaries align with [W3C consistent identification](https://www.w3.org/WAI/WCAG21/Understanding/consistent-identification.html),
[GOV.UK contribution criteria](https://design-system.service.gov.uk/community/contribution-criteria/)
and [bounded contexts](https://martinfowler.com/bliki/BoundedContext.html): keep
repeated functions recognizable, justify shared patterns, and preserve real
domain distinctions.

## Ablation And Review

Judge a change by verified user value against implementation, maintenance,
compatibility, runtime and failure cost. After a material module, remove any
new state, dependency, branch or abstraction that the accepted behavior does
not need. A small performance gain does not justify permanent complexity;
do not reduce viewing quality or requested functionality merely to save lines.

A concrete reduction in duplicated writers, cross-module dependencies or
repeated edit sites can justify structural refactoring without a reproduced
runtime failure. Name that gain and its regression risk. A completed audit is
bounded evidence, not a claim that every current module boundary is optimal.

Before changing production recovery or state, trace the real request producers
and their guards. A test that bypasses disabled controls or writes private state
does not alone establish a reachable product defect. Reference scans, including
hits from tests and previews, are leads rather than proof of product use or
absence. Follow the actual producer-to-consumer path and check the changed
boundary; isolated helper tests can miss a mismatch between the two ends.

Trace acquisition, use, commit and retirement, including replacement and failure.
For async ownership, check A starting, B replacing it, then A completing or
cleaning up. Where compatibility is promised or being established for public
release, check actual old/new readers as well as the happy path. Ordinary private
changes do not require support for stale private clients. Run proportionate checks through
[the standard entry points](../../CONTRIBUTING.md#verification-entrypoints).
This discipline does not authorize an unrelated repository rewrite or a new
test suite for every helper.
