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
`tsconfig.json` connects them. Cargo manifests and locks stay with each Rust crate.

| Location | What belongs here |
| --- | --- |
| Root README, contribution and agent files | Project introduction and shared working constraints; detailed documents live in `docs/` |
| Root npm manifests, Vite/Vitest config, `index.html` | Shared Browser build/test startup; root `LICENSE` is authoritative |
| `src/client`, `src/shared` | Shared UI, media helpers and Browser orchestration; `src/client/channel` owns the 3.0 frontend adapter |
| `public/` | Static assets shipped with that Browser application |
| `prototype/channel-core` | Shared Rust domain/room authority, wire, storage, routing and file rules |
| `prototype/channel-browser` | WASM binding and IndexedDB room adapter over that core |
| `prototype/channel-native` | Native room participant, RTC/media, capture and input adapters |
| `prototype/channel-server` | Domain HTTP/WebSocket I/O, Server composition, App approval/launcher and static Web delivery |
| `prototype/channel-android`, `mobile/android` | JNI entry, Android service/consent shell and shared Rust App lifetime |
| `mobile/cloudflared`, root `.go-version` | Independent upstream tunnel helper's Android overlay and build toolchain |
| `cmd/piik-app` | Retained App guides and shared icon/Windows resource inputs |
| `native/capture`, `native/fixtures`, `native/probes`, `native/third_party` | Standalone platform helpers, synthetic workloads, probes and retained upstream provenance |
| `site/` | Independently published introduction, film and reader documentation |
| `scripts/` | Development checks, shared builds, probes and release packaging/publishing tools |
| `tests/` | TypeScript/tooling tests and retained Browser fixtures; Rust tests stay with their crates |
| `deploy/` | Operator scripts and container, proxy, service and certificate templates |
| `docs/`, `licenses/` | Documentation owners, dependency notices and pinned source attribution |
| `.github/`, `.githooks/`, `.agents/`, `.codex/` | Platform automation and scoped agent/tool integration |
| `build/`, Cargo `target/`, generated WASM `pkg/`, `node_modules/`, `coverage/` | Ignored output and dependencies; never current product truth |

This map describes the current Rust 3.0 source. Published compatibility remains
owned by [versioning](./versioning.md). Standalone native helpers retain their
own fixtures and provenance; the Rust App's capture owner is
`prototype/channel-native/src/capture`.
`site/` introduces Piik; the shared Web bundle is Piik's interactive application.
Node, Vite and WASM tools prepare assets; deployed App/Server runtimes serve their
sibling `web/` tree without Node.

## Module Map

| Owner | Responsibility and dependency boundary |
| --- | --- |
| `prototype/channel-core` | Domain admission, room authority, signed conversation/history, activity/publication plans and transport leases; no Browser/Native/Server adapter dependency |
| `prototype/channel-browser/src` | WASM calls, IndexedDB transactions and participant-owned file storage |
| `src/client/channel` | Browser session, peer carrier, media, room hosting, conversation, voice, files and attended input over core-owned plans |
| `prototype/channel-native/src/session.rs`, `hosted_room.rs` | Authenticated Native participant, SQLite-backed rooms and admitted peer resources |
| `prototype/channel-native/src/peer.rs`, `media` | RTC connections, encoded media forwarding and demand; the media library owns network adaptation |
| `prototype/channel-native/src/capture`, `input` | Platform source/encoder/input resources under the selecting page's lease |
| `prototype/channel-server/src/domain.rs` | Domain HTTP/WebSocket admission and directory effects over the shared core |
| `prototype/channel-server/src/lib.rs` | Explicit Server-owned Native hosting and service shutdown |
| `prototype/channel-server/src/app*.rs` | Local approval, site namespaces, App-owned domains, launcher and public-link lifetime |
| `prototype/channel-server/src/web.rs` | Shared static delivery, document cache policy and network entries; build-time compression belongs to `scripts/build-channel-web.mjs` |
| `src/client/components`, `locales`, `ui`, shared media/control helpers | Product controls, presentation and localized copy reused by App, Server and previews |
| `prototype/channel-android`, `mobile/android` | JNI runtime and Android permission/service ownership; reuse Native capture and shared App composition |
| `mobile/cloudflared` | Overlay against its separately pinned upstream Go module; no Piik business core |

The [channel/network model](../research/channel-network-design.md) and
[room-data model](../research/channel-storage-and-identity.md) own the 3.0 design.
Directory names locate responsibilities; they do not require another layer.

The website and public Demo are optional entry points, not runtime dependencies
of App or self-hosted rooms. Ship the shared Web assets with the binaries.
Keep optional help/download reachability checks outside room startup,
authorization and media lifecycles.

## Contract Map

| Boundary | Schema/validation owners |
| --- | --- |
| Domain admission and signaling | `prototype/channel-core/src/wire.rs`, `src/client/channel/protocol.ts`; I/O dispatch in `prototype/channel-server/src/domain.rs` |
| Room commands, confirmations and history | Core `host.rs`, `conversation.rs`, `history.rs` and storage adapters; Browser/Native deliver replies after the owned transaction commits |
| Browser/App discovery and approval | `src/client/channel/app-link.ts`, shared discovery/picker schemas, Server `app.rs` and `app_sites.rs` |
| Encoded capture/media | Native `capture`, `media` and `peer.rs`; platform producers retain their source clock and resource ownership |
| Attended input | Core `input.rs`, Browser `channel/input.ts` and Native `input`; consent follows the current publication/page lease |
| Files | Core `attachment.rs`/`file_delivery.rs`, Browser attachment/storage adapters and Native `file.rs` |
| Configuration and persistence | Rust startup/App composition and Core storage owners; runtime setup in the [Server/App guide](../../prototype/channel-server/README.md) |
| Release/update metadata | Existing packaging scripts and Rust `release.rs`; identity/compatibility in [versioning](./versioning.md) and operations in [deployment](../deployment.md) |

`tests/fixtures/wire-samples.json` remains a retained 2.x Browser fixture.
It does not define the 3.0 domain, room, Native or capture interfaces. Change the
actual producer, consumer and relevant existing check together; do not create
another handwritten field list, DTO hierarchy or schema generator without a
demonstrated reduction in ownership or drift.

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
| Browser domain session | `channel/session.ts` opens the authenticated domain connection | current welcome/session and room bindings | page or admitted-session retirement ends that session's personal activities and peer resources |
| Browser room host | the Browser adapter opens IndexedDB and claims the room binding | Core-prepared confirmation/history after transaction commit | page/binding retirement releases hosting; another binding cannot be overwritten by stale work |
| Native room host | Native opens the admitted SQLite-backed room | durable Core transaction before confirmed reply | room/session/process retirement closes resources while retaining saved room data |
| Screen/camera publication | the selecting page acquires capture and publication leases | current source, plan and decoded-delivery proof | stop/replacement/page loss retires its captures and affected media/input leases |
| Room voice | Browser capture and explicit room participation | current voice publication and playback ownership | leave/page retirement releases the relevant voice resources; a floating tool's closure does not leave voice |
| Floating room tool | `ChannelRoomTool` presents existing conversation/couch/voice controls | current window/document owns presentation | closure returns the tool to the page; session retirement closes its detached surface |
| App hosting and capture | App service admits a site and starts Native hosting; the page separately selects capture | exact approved origin, room namespace and page capture lease | App shutdown ends its hosts; page loss stops its own captures without ending independent App hosting |
| Android runtime | service starts the Rust App through JNI; system consent supplies capture capability | current runtime and original pending permission/capture request | Stop/service retirement closes that runtime; Activity navigation does not replace it |
| Native physical peer | admitted transport lease creates RTC/socket/media resources | current physical pair and library-owned connection state | lease replacement or shutdown retires only those resources |

## Source Index

Start a change at the owning entry point, then follow the interfaces listed
above rather than searching the tree. NAT policy stays in [routing](./routing-transport.md),
visual rules in [visual language](./visual-language.md), and website behavior and publication
in [introduction design](./public-introduction.md) and the [website runbook](../operations/website.md).

| Change | Start at |
| --- | --- |
| Room UI, share/watch workflow and page lifecycle | [ChannelPreviewPage](../../src/client/pages/ChannelPreviewPage.tsx), [Browser session](../../src/client/channel/session.ts) |
| Browser peer/media, playback proof and quality | [Channel media](../../src/client/channel/media.ts), [transport](../../src/client/channel/transport.ts), [decoded-frame proof](../../src/client/media/decoded-frame-proof.ts), [shared capture profiles](../../src/client/media/quality.ts) |
| Domain admission, room authority and route plans | [Core](../../prototype/channel-core/src), [Domain I/O](../../prototype/channel-server/src/domain.rs) |
| Confirmed conversation, history and storage | [Core host](../../prototype/channel-core/src/host.rs), [Browser room adapter](../../prototype/channel-browser/src/room-host.ts), [Native hosted room](../../prototype/channel-native/src/hosted_room.rs) |
| Files and selected copies | [Core delivery](../../prototype/channel-core/src/file_delivery.rs), [Browser attachments](../../src/client/channel/attachments.ts), [Native file owner](../../prototype/channel-native/src/file.rs) |
| App discovery, approval and hosting | [Browser App link](../../src/client/channel/app-link.ts), [App composition](../../prototype/channel-server/src/app.rs), [site namespaces](../../prototype/channel-server/src/app_sites.rs), [local domain](../../prototype/channel-server/src/app_domain.rs) |
| Native RTC/media and gateway mapping | [Native peer](../../prototype/channel-native/src/peer.rs), [mapping](../../prototype/channel-native/src/peer/mapping.rs), [media](../../prototype/channel-native/src/media.rs), [dependency provenance](../../prototype/channel-native/README.md#rtc-dependency) |
| Platform source capture and encoding | [Rust capture](../../prototype/channel-native/src/capture), [standalone helper/fixture source](../../native) |
| Attended input and committed-route forwarding | [Core input](../../prototype/channel-core/src/input.rs), [Browser input](../../src/client/channel/input.ts), [Native executor](../../prototype/channel-native/src/input) |
| Android App and platform lifecycle | [Android guide](../../mobile/README.md), [JNI](../../prototype/channel-android), [Native capture](../../prototype/channel-native/src/capture/android), [system shell](../../mobile/android/app/src/main) |
| Voice, room tool and detached presentation | [Channel components](../../src/client/channel/components), [panel window](../../src/client/ui/panel-window.ts) |
| Shared UI, copy and previews | [components](../../src/client/components), [locales](../../src/client/locales), [UI primitives](../../src/client/ui), [catalogue](../../src/client/pages/TooltipPreviewPage.tsx) |
| Web build, compression and delivery | [shared builder](../../scripts/build-channel-web.mjs), [Rust static service](../../prototype/channel-server/src/web.rs), [frontend entry](../../src/client/main.tsx) |
| Configuration, updates and packaging | [Server/App guide](../../prototype/channel-server/README.md), [Rust release checks](../../prototype/channel-server/src/release.rs), [deployment](../deployment.md) |
| Independent Android tunnel helper | [Cloudflared owner](../../mobile/cloudflared/README.md), [builder](../../scripts/build-android.mjs) |
| Public website, film and guides | [site](../../site), [website builder](../../scripts/build-website.mjs), [documentation ownership](./documentation.md) |

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
