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
| `mobile/` | Android platform shell and in-process capture bridge over the shared Go core |
| `scripts/` | Development checks, browser/media gates, dependency assembly and release packaging/publishing tools |
| `tests/` | TypeScript/tooling tests and cross-language fixtures; Go tests stay beside their packages |
| `deploy/` | Operator scripts and container, proxy, service and certificate templates |
| `docs/` | User guides, contracts, decisions and operations; [documentation ownership](./documentation.md) defines each owner |
| `licenses/` | Third-party license texts, pinned notice sources and their redistribution reference |
| `.github/`, `.githooks/`, `.agents/`, `.codex/` | Platform automation and scoped agent/tool integration |
| `build/`, `node_modules/`, `coverage/` | Ignored local output and dependencies; never current product truth |

`site/` introduces Silip; `src/client/` is Silip's interactive application.
`internal/app/nativecapture` owns the desktop helper process and frame contract;
`native/capture/` implements its platform APIs. `nativehost` consumes a capture
stream; the Android App supplies that stream in-process through `mobile/`.
`scripts/` prepares and verifies artifacts;
`deploy/` operates them. Move files with their actual consumers, and update paths
and checks together; a smaller root alone does not justify another abstraction.

## Module Map

| Owner | Responsibility and dependency boundary |
| --- | --- |
| `cmd/silip-server`, `cmd/silip-app` | Thin entry points: defaults, startup and shutdown; compose the same Go room service |
| `internal/server/app` | HTTP, site access, runtime capabilities, static assets and listener lifecycle; room mutations go through `signal` |
| `internal/server/signal` | Authenticated command/effect owner; serializes room, session and route mutations and executes controller decisions |
| `internal/server/room` | Room authority, credentials and persistence; caller holds the signaling lock, durable writes precede in-memory changes |
| `internal/server/route` | Synchronous room graph and single-operation decisions; returns resource effects to `signal`, owns no locks or timers, and calls its optional diagnostic sink synchronously |
| `internal/server/sfu`, `internal/app/mediaedge` | Server forwarding and native peer adapters over the shared `internal/media/forwarding`; Pion/LiveKit own transport and adaptation |
| `internal/app` | Local/public-link/Site composition, loopback service, native sessions and App lifecycle; never a second room backend |
| `internal/app/nativecapture`, `native/capture/*` | Desktop capture process, frame contract and platform capture/encoding adapters |
| `internal/app/nativehost/capture.go`, `mobile/bridge`, `mobile/android` | Capture producer contract, shared mobile frame bridge and Android-owned consent/codec resources; reuse room control and media routes |
| `src/client/pages`, `lib`, `media`, `native` | Browser orchestration and endpoint adapters; bind current media and retire owned resources |
| `src/client/media/viewer-presentation.ts`, `ui/media-status.ts` | Playback facts and their derived status projection; UI indicators do not create recovery or quality policy |
| `src/client/components`, `locales`, `ui` | Shared interaction, visual primitives and localized copy; same product interface for Server and App |
| `src/client/room-voice` | Room voice session and Browser endpoint; membership and audio resources outlive the interaction window independently of picture sharing |
| `src/client/remote-control` | Attended input sessions and forwarding over the committed media route; native input authority stays in `internal/app/remoteinput` |
| `internal/server/webassets` | One built Browser bundle embedded by both binaries; Node/Vite are development tooling |

Names follow [naming](./naming.md). Architecture decisions explain why these
boundaries exist: [shared core](../adr/0012-shared-go-backend-core.md),
[embedded media](../adr/0013-embedded-node-local-media.md) and
[Browser pooling](../adr/0014-browser-node-local-encoding-pool.md).
Directory names are a map, not a requirement to introduce another layer.

The official website and public Demo are optional entry points, not runtime
dependencies of App or self-hosted rooms. Ship the Web assets with the binaries.
Help and download navigation may prefer the reachable website, with direct
GitHub destinations while its bounded, page-scoped check is pending or fails.
Keep this check outside room startup, authorization and media lifecycles.

## Contract Map

| Boundary | Schema/validation owners |
| --- | --- |
| Room HTTP and Browser/Server signaling | `src/shared/protocol.ts` and `internal/server/protocol`; HTTP dispatch in `internal/server/app`, WS dispatch in `signal` |
| Site access HTTP | `src/client/lib/api.ts` and `internal/server/app/json.go`; cookies and access behavior belong to [rooms/access](./rooms-access.md) |
| Browser/App discovery and control | `src/client/native/wire.ts`, `internal/app/loopback/protocol.go`, `internal/app/nativecontrol/wire.go` |
| Remote input data channel | [Browser input protocol](../../src/client/remote-control/protocol.ts), [native input validation](../../internal/app/remoteinput/manager.go) and [channel routing](../../internal/media/inputroute); admission remains with the existing room and native control owners |
| App/capture sidecar | `internal/app/nativecapture` and each platform capture adapter; probe/commands and encoded-frame envelope are distinct formats |
| In-process capture producer | `internal/app/nativehost/capture.go`; the platform supplies frames and retires its own resources, without another control or routing protocol |
| Configuration and persistence | `internal/server/config`, `internal/app/config`, `internal/server/room/database.go`; operator semantics in [configuration](./configuration.md) |
| Release and update metadata | Existing packaging scripts, `src/client/lib/release-update.ts`, `cmd/silip-server/release.go`; identity/compatibility in [versioning](./versioning.md), operations in [deployment](../deployment.md) |

The shared `tests/fixtures/wire-samples.json` is consumed by TypeScript and Go
fixture tests. It covers room requests and signaling; it is not a universal
schema for all HTTP, Native or capture traffic. Change the actual two ends and
the relevant existing fixture/check together. Do not create another handwritten
field list in documentation, parallel DTO hierarchy or schema generator without
a demonstrated reduction in ownership or drift.

Keep UI presets, requested values, runtime capabilities, observations and hard
resource limits distinct. Every bound needs an owner and a reason: wire/codec
representation, accepted product policy or resource protection. A current menu
or retry budget is not sufficient reason to freeze its values into a wire reader.
Validate representation at the interface, then supported operations at their
owner before allocating or changing live state. An unsupported setting should
use the existing operation rejection, without retiring an otherwise valid session.

A capability description may exceed the reader's implementation. Intersect it
with local support and budgets; do not treat a stronger peer as absent or grant
resources from its declaration alone. Measurements are observations, not resource
requests: their range need not match a setting or estimated network budget.
An unusable optional metric should become unavailable without discarding valid
evidence or closing media control. Identity, generation, authority and required
state consistency remain strict; never clamp a measurement into an invented fact.

Detect optional platform features through bounded capability checks and actual
operation results, not OS/browser version allowlists. Keep API availability,
permission and successful execution distinct; version data is diagnostic context.

Preserve meaningful authorization and resource bounds; prove that a producer's
valid aggregate output fits its consumer, including serialization overhead.
A per-item limit alone does not establish that contract.

When extending a boundary, exercise a representative new value, a larger peer
capability and an unchanged consumer before calling the design extensible.
Check both acceptance and the effect of rejection. For media, include another source
orientation and distinguish encode, decode and forwarding support. Optional
presentation additions need a bounded unsupported-value policy separate from
authority violations, following [versioning](./versioning.md#extending-interfaces).
Use the existing owner and concrete capability negotiation; these checks do not
justify a generic plugin framework or accepting unknown commands.

## Runtime Lifecycles

Read each runtime as acquisition, the authoritative commit that makes its work
visible, and the retirement that ends it. Before committing asynchronous results
or retiring current state or resources, revalidate the acquiring identity.
Presentation derives from the committed fact instead of mirroring it.

| Runtime | Acquire | Commit | Retire |
| --- | --- | --- | --- |
| Browser Host share | `pages/HostPage.tsx` captures one source and creates its peers and route | current generation plus the owning identity: local-offer epoch, publisher slot revision, source-switch and quality-change tokens | `disposeResources` stops owned tracks, disposes peers and sends `stop-sharing`; a replaced source retires through `retiringStreamRef` |
| Browser Viewer route | `pages/ViewerPage.tsx` binds one parent peer (Browser or Native) and its relay children | parent, connection and message identity, then playback facts | a new viewer generation retires the old binding; relay children follow `activateChildren` revisions |
| Browser relay fanout | `webrtc/viewer-relay.ts` prepares a child before it is needed | `activateChildren(revision, childPeerIds)` commits the prepared set | replaced or emptied sets disconnect the child peers they own |
| Browser local encoding pool | `webrtc/host-peer.ts` attaches a pool carrier when capture and APIs support it ([ADR-0014](../adr/0014-browser-node-local-encoding-pool.md)) | the carrier binding owns its pooled producer while attached | source change or disposal releases the carrier; unsupported APIs keep ordinary senders |
| Browser/App control connection | `native/client-connection.ts` discovers lazily when the page requests App capability | one acquisition and exact `NativeClient` instance; the page owns eligibility and failure policy | explicit release, page/session retirement or App disconnect; late discovery closes only its own result |
| Room voice | `room-voice/session.ts` binds the admitted room session and its Browser endpoint | authoritative membership and the current publication/connection identity under [room media](./routing-transport.md#room-media) | leave, room retirement or session close releases owned audio; closing the interaction window does not leave voice |
| Floating room tool | `FloatingPanel.tsx` presents the tool; `ui/panel-window.ts` opens a supported detached window | the current window request and document own presentation, not the room session | close returns the tool to the page; opener/session retirement closes even a late open under [presentation lifecycle](./presentation-lifecycle.md) |
| App native session | the loopback service admits native control sessions and the Web UI selects the native path | session identity plus the explicit media-path choice | session end, share end or process exit retires that edge and its capture sidecar |
| Android runtime | the user starts `AppRuntimeService`, which creates the shared Go core | one service/runtime instance; pending OS results retain their original media request | user Stop or service retirement joins startup and closes its own runtime; Activity navigation does not stop it |
| Native ICE gathering | one gathering observes addresses on its connection's retained socket | candidates retain their source ICE generation; one collector joins Pion, STUN and gateway completion | ICE restart retires previous observations and excludes stale queued output; connection close retires the socket |
| Server room authority | `signal` authenticates one Host or Viewer command | `room` writes durably before the in-memory commit; the signaling lock serializes mutations | explicit replacement or deletion, grant rotation or revocation, or process exit for memory-mode rooms |
| Server route and SFU | `signal` feeds `route` one serial child operation; `sfu/admission.go` accepts one bounded publication | one committed graph per controller and the forwarding publication | superseded assignments retire inside the same operation; deactivate retires the publication |

## Source Index

Start a change at the owning entry point, then follow the interfaces listed
above rather than searching the tree. NAT policy stays in [routing](./routing-transport.md),
visual rules in [visual language](./visual-language.md), and website behavior and publication
in [introduction design](./public-introduction.md) and the [website runbook](../operations/website.md).

| Change | Start at |
| --- | --- |
| Host workflow, share lifecycle, notices | [src/client/pages/HostPage.tsx](../../src/client/pages/HostPage.tsx), [src/client/pages/host-page-notices.ts](../../src/client/pages/host-page-notices.ts) |
| Viewer workflow, playback, status projection | [src/client/pages/ViewerPage.tsx](../../src/client/pages/ViewerPage.tsx), [src/client/media/viewer-presentation.ts](../../src/client/media/viewer-presentation.ts), [src/client/ui/media-status.ts](../../src/client/ui/media-status.ts) |
| Received viewer metrics and expiry | [src/client/media/viewer-quality-evidence.ts](../../src/client/media/viewer-quality-evidence.ts) owns evidence rules; [src/client/media/viewer-quality-evidence-store.ts](../../src/client/media/viewer-quality-evidence-store.ts) owns received entries and timers for Host and relay views |
| Browser peer and route mechanics | [src/client/webrtc/host-peer.ts](../../src/client/webrtc/host-peer.ts), [src/client/webrtc/viewer-peer.ts](../../src/client/webrtc/viewer-peer.ts), [src/client/webrtc/viewer-relay.ts](../../src/client/webrtc/viewer-relay.ts), [src/client/media/host-sfu-route.ts](../../src/client/media/host-sfu-route.ts), [src/client/media/viewer-sfu-route.ts](../../src/client/media/viewer-sfu-route.ts), [src/client/media/route-transition.ts](../../src/client/media/route-transition.ts) |
| Capture, profiles and sender parameters | [src/client/media/quality.ts](../../src/client/media/quality.ts), [src/client/media/browser-encoding-pool.ts](../../src/client/media/browser-encoding-pool.ts), [src/client/media/browser-encoding-output.ts](../../src/client/media/browser-encoding-output.ts) |
| SFU endpoints | [src/client/sfu/publisher.ts](../../src/client/sfu/publisher.ts), [src/client/sfu/subscriber.ts](../../src/client/sfu/subscriber.ts), [src/client/sfu/peer.ts](../../src/client/sfu/peer.ts), [internal/server/sfu](../../internal/server/sfu) |
| Localized copy and failure facts | [src/client/locales](../../src/client/locales), [src/client/ui/copy.ts](../../src/client/ui/copy.ts), [src/client/ui/media-failure.ts](../../src/client/ui/media-failure.ts) |
| Native control connection and media adapters | [src/client/native/client-connection.ts](../../src/client/native/client-connection.ts), [src/client/native](../../src/client/native), [internal/app/loopback](../../internal/app/loopback), [internal/app/nativecontrol](../../internal/app/nativecontrol), [internal/app/nativehost](../../internal/app/nativehost), [internal/app/nativeviewer](../../internal/app/nativeviewer), [internal/app/nativecapture](../../internal/app/nativecapture) |
| Android App and platform lifecycle | [mobile/README.md](../../mobile/README.md), [mobile/bridge](../../mobile/bridge), [mobile/android/app/src/main](../../mobile/android/app/src/main) |
| Room authority, persistence and graph | [internal/server/signal](../../internal/server/signal), [internal/server/room](../../internal/server/room), [internal/server/route](../../internal/server/route) |
| Room signaling intent and interaction delivery | [src/client/lib/signaling.ts](../../src/client/lib/signaling.ts), [src/client/lib/room-interactions.ts](../../src/client/lib/room-interactions.ts); admission and transient delivery follow [rooms and access](./rooms-access.md) |
| Shared wire contract | [src/shared/protocol.ts](../../src/shared/protocol.ts), [internal/server/protocol](../../internal/server/protocol), [tests/fixtures/wire-samples.json](../../tests/fixtures/wire-samples.json) |
| Diagnostics and logging | [src/client/lib/debug.ts](../../src/client/lib/debug.ts), [internal/diagnostics](../../internal/diagnostics), [configuration](./configuration.md#diagnostics) |
| Configuration and deployment | [internal/server/config](../../internal/server/config), [internal/app/config](../../internal/app/config), [configuration](./configuration.md), [deployment](../deployment.md) |
| ICE sockets, gateway mapping and candidate gathering | [internal/app/mediaedge/ice_socket.go](../../internal/app/mediaedge/ice_socket.go), [internal/app/mediaedge/candidate_gathering.go](../../internal/app/mediaedge/candidate_gathering.go), [internal/app/mediaedge/stun.go](../../internal/app/mediaedge/stun.go), [internal/app/portmapping](../../internal/app/portmapping) |
| NAT evidence and App punch preparation | [src/client/webrtc/nat-prediction.ts](../../src/client/webrtc/nat-prediction.ts), [src/shared/nat-candidate.ts](../../src/shared/nat-candidate.ts), [src/client/native/native-punch.ts](../../src/client/native/native-punch.ts), [internal/app/mediaedge/punch.go](../../internal/app/mediaedge/punch.go), [internal/server/stun/server.go](../../internal/server/stun/server.go); controls and execution belong to the [network laboratory](../research/network-lab.md) |
| Route scheduling, retry opportunities and deadlines | [internal/server/route/operation.go](../../internal/server/route/operation.go), [internal/server/route/opportunities.go](../../internal/server/route/opportunities.go), [internal/server/route/candidates.go](../../internal/server/route/candidates.go); routing decisions stay under [ADR-0005](../adr/0005-automatic-hybrid-media-routing.md) |
| Picture attachment and retained room edges | [internal/server/route/publication.go](../../internal/server/route/publication.go), [internal/server/route/graph.go](../../internal/server/route/graph.go); separate picture and voice lifetimes follow [room media](./routing-transport.md#room-media) |
| Room voice session, endpoint and roster | [src/client/room-voice/session.ts](../../src/client/room-voice/session.ts), [src/client/room-voice/browser-endpoint.ts](../../src/client/room-voice/browser-endpoint.ts), [src/client/room-voice/participant-presentation.ts](../../src/client/room-voice/participant-presentation.ts), [src/client/room-voice/RoomVoicePanel.tsx](../../src/client/room-voice/RoomVoicePanel.tsx) |
| Remote input and committed-route forwarding | [src/client/remote-control/input-session.ts](../../src/client/remote-control/input-session.ts), [src/client/remote-control/input-route.ts](../../src/client/remote-control/input-route.ts), [src/client/remote-control/protocol.ts](../../src/client/remote-control/protocol.ts), [internal/app/remoteinput](../../internal/app/remoteinput) |
| Interaction window and detached presentation | [src/client/components/living/RoomInteractions.tsx](../../src/client/components/living/RoomInteractions.tsx), [src/client/components/living/FloatingPanel.tsx](../../src/client/components/living/FloatingPanel.tsx), [src/client/ui/panel-window.ts](../../src/client/ui/panel-window.ts), [src/client/components/living/use-anchored-popover.ts](../../src/client/components/living/use-anchored-popover.ts) |
| Visual primitives, guidance and preview | [src/client/ui/palette.css](../../src/client/ui/palette.css), [src/client/ui/theme.ts](../../src/client/ui/theme.ts), [src/client/ui/icons.tsx](../../src/client/ui/icons.tsx), [src/client/components/living/primitives.tsx](../../src/client/components/living/primitives.tsx), [src/client/components/living/Tooltip.tsx](../../src/client/components/living/Tooltip.tsx), [src/client/pages/ControlsPreview.tsx](../../src/client/pages/ControlsPreview.tsx) |
| Public website and film presentation | [site/index.html](../../site/index.html), [site/main.js](../../site/main.js), [site/styles.css](../../site/styles.css), [site/films](../../site/films), [scripts/build-website.mjs](../../scripts/build-website.mjs) |

## Implementation Rules

- Reuse a current owner, standard API or mature dependency before adding a
  mechanism. Extract a complete responsibility for its real consumers, keeping
  resource acquisition, replacement and retirement together. File size alone
  does not justify wrappers, a generic manager or a framework.
  Remove superseded paths in the same change; retain no unused legacy copy.
  A platform adapter can be justified with one implementation; judge its boundary
  and consumers before removing it.
- Keep simple logic at its call site. Extract a helper for actual reuse, a
  substantial boundary, or a distinct concept whose name makes the caller clearer.
  In longer orchestration, keep the main flow readable and move substantial
  validation and supporting details into nearby helpers. Prefer meaningful
  boundaries over many single-use wrappers or arbitrary function-size limits.
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
  Queued events retain physical-owner validity until the final serialized write;
  readiness commits also require the resource's current state. Reused logical
  IDs do not identify a replacement instance. A child's attachment failure does
  not retire its shared producer. New subscriptions follow the old owner's
  retirement, including repeated cleanup callers.
  Closing a Browser connection may leave its API promises pending. Its owner
  cancels the corresponding waits so a serialized successor never depends on
  completion from a retired connection; late results still need identity checks.
  Failure effects need the same final identity check as successful results,
  serialized with replacement; an earlier input check alone is insufficient.
  Later cancellation must not erase a failure already accepted by its current
  owner. Perform blocking retirement after releasing that owner's state lock.
  A caller deadline does not cancel a dependency that ignores it. Keep late
  work bounded and serialize its cleanup; verify the dependency's actual lifetime.
  Construction is part of acquisition: if it throws, release resources created
  before the failure and report through the existing operation owner. A failed
  allocation does not erase the operation's authoritative identity.
  Initialize callback-visible state before registration or binding; library
  constructors can start background work before returning.
  Ordered shutdown may require a ready auxiliary transport to outlive the stop
  request; its owner closes it after dependants retire. External convenience
  actions must not block lifecycle handling, and repeated attempts stay bounded.
- Keep decisions separate from effects. Respect documented lock ordering and
  revalidate after unlocked work. Local native capability never grants room
  authority; the shared Go service remains authoritative.
  Injected callbacks still execute in their caller's context. Synchronous
  authority hooks must not hide blocking I/O or release the caller's lock;
  schedule slow work at an explicit, owned effect boundary.
- Validate and normalize unknown input once at each owning trust boundary, then
  pass typed values inward. Do not repeat shape checks already guaranteed by a
  schema, constructor or internal contract. Authorization and mutable state or
  resource identity remain checked where they can change.
  Keep domain error meanings stable and map them into shared localized UI.
  [Versioning](./versioning.md) determines which
  extensions are compatible; an optional field is not automatically compatible.
  Dispatch separates protocol rejection, per-request operation failure and an
  already-satisfied teardown. Late teardown is idempotent and cannot retire a
  replacement resource; retain strict validation before looking up its target.
  Relayed content uses the same units and limits at each boundary; its failure
  cannot invalidate an otherwise valid local control session. Slow capture
  mutations share one cancellable operation slot while control remains
  responsive. Bounded queues apply backpressure rather than turning a valid
  burst into session failure.
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
- Comment on non-obvious reasons, constraints and surprising behavior, rather
  than narrating assignments or control flow. Package comments describe current
  responsibilities and invariants. Historical
  migration paths belong in ADR/research unless they explain a surviving constraint.
  Support Windows, macOS and Linux; new text files use LF and new filenames use
  ASCII, with format exceptions in [`.gitattributes`](../../.gitattributes).
  Scripts use stable executable paths; physical confidence stays explicit in
  [verification status](../verification-status.md).
- Update generated files through their source schema, template or generator and
  the existing regeneration command; do not patch generated output by hand.
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
UI control and surface selection belongs to the
[visual language](./visual-language.md#control-selection), including when tools
remain attached, float or detach. Reuse that contract before adding local UI rules.

These boundaries align with [W3C consistent identification](https://www.w3.org/WAI/WCAG21/Understanding/consistent-identification.html),
[GOV.UK contribution criteria](https://design-system.service.gov.uk/community/contribution-criteria/)
and [bounded contexts](https://martinfowler.com/bliki/BoundedContext.html): keep
repeated functions recognizable, justify shared patterns, and preserve real
domain distinctions.

## Ablation And Review

Test production implementations through their real construction paths. Replace
external I/O or platform boundaries only where the focused test needs it; keep
the behavior under test real instead of copying its algorithm or validator into
the test. Keep test-only setup and state seeding in the harness, and do not export
mutable resources solely for tests. Defaults and restoration use the production
construction path.

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

For a shared-resource failure, review both the failing child and a healthy
sibling through the real producer/consumer boundary. Compare preparation with
live operation, and current implementations with supported compatibility paths.
Exercise optional failure after success and a dependency that remains pending
after cancellation; a timeout constant or a close call alone proves no deadline.
Keep the shared resources production retains while changing the external
condition. New request/connection IDs alone do not prove that a dependency's
cached observations, failure state or resource lease have been refreshed.
For media adaptation, include partial capacity restoration on the retained
connection, not only recovery to a fast link. Check capture, encoded output,
actual send and remote decode separately. A dependency's algorithm does not
prove its adapter preserves assumptions about pacing, measurement or ownership.
For overlapping connections, preserve the actual shared local and remote
endpoints; giving each fixture an independent listener can hide demultiplexing
conflicts. Check both commit and rollback while the surviving media still flows.
Keep the regression at the owning boundary and verify it rejects the old
behavior. Report which failure sequences were exercised, rather than treating
test counts, file coverage or an earlier audit as proof of lifecycle coverage.

Trace acquisition, use, commit and retirement, including replacement and failure.
For async ownership, check A starting, B replacing it, then A completing or
cleaning up. Where compatibility is promised or being established for public
release, check actual old/new readers as well as the happy path. Ordinary private
changes do not require support for stale private clients. Run proportionate checks through
[the standard entry points](../../CONTRIBUTING.md#verification-entrypoints).
This discipline does not authorize an unrelated repository rewrite or a new
test suite for every helper.
