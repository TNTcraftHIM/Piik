# ADR-0020: One Vocabulary For Extension

- Status: proposed
- Date: 2026-11-25

## Context

The [canon](../canon.md#how-it-is-built) asks for a small core that is open to
extension. The owner's direction goes further: a bot, an API client, a plugin,
a new activity and a provider are the same kind of thing underneath, the
built-in features should attach through the points the community would use,
and the scaffolding should be designed now.

The model is an agent harness built wholly from plugins on a small kernel: a
plugin declares what it needs and provides, every registration can be undone,
a seam has a definition, a provider and a consumer, and the product itself is
composed from plugins only. One thing does not carry over. That harness serves
one trusted person on one machine. In a room, other people are affected by
code they never approved, stored history cannot be undone, and each
participant may run different extensions, so the shared rules have to stay
fixed.

Today a new activity touches about eleven files outside the interface, a
headless text participant already joins like a person, and the standards
refuse a generic plugin framework. Three designers worked from the
requirements and this evidence without reading the repository, one of them
asked to find where a plugin boundary costs more than it gives. They agree on
what follows.

## Decision

1. **One vocabulary, four places.** A *point* is a typed place of attachment
   declared by its owner. A *contribution* is data attached to a point, with
   code loaded when needed. A *scope* is a lifetime that undoes everything
   registered in it. A *kind* names shared room data. A *composition* is a
   named list of parts. Authority never comes from being an extension: it
   comes from admission, or from operating a machine.

   | Place | What runs there | What it can never do |
   | --- | --- | --- |
   | The room's writer | The compiled core only | Run community code, or let one record alter or block another |
   | A person's client | Parts compiled into the build | Start capture, the microphone or control except through that person's act |
   | A participant process | A bot or API client | More than a person can do on the wire, or be present without a marker |
   | The operator's machine | Providers | Decide admission or order |

2. **A kind is the only thing that crosses machines.** It is namespaced and
   carries a major version, an opaque payload and a short fallback text. The
   writer orders and stores it under one of three classes: *history*,
   appended; *state*, the latest value per key with a revision that a write
   must match; and *signal*, relayed and not stored. The writer checks the
   sender, the class rule, size and rate, and never the meaning. Built-in
   kinds are declared in the same registry. They may have validators compiled
   into the core, and that privilege is stated openly.
3. **Without the extension, a person sees the fallback.** Records stay with
   the room, are exported as they are, and are never migrated by the core.
   Removing an extension stops rendering and nothing else.
4. **The client is a tree of scopes**: application, channel, room, activity,
   capture. Every registration returns the means to undo it, and a scope that
   ends undoes them in reverse. This is the split of the session hub that
   [ADR-0015](./0015-browser-session-lifetime-owners.md) decided, not a layer
   above it. Events notify; nothing intercepts. The consent to capture, the
   indicators of who sees and hears, the join flow, the pools and the planner
   belong to the kernel and are not points.
5. **Compositions are static.** The full place and plain screen sharing are
   two lists of the same parts, resolved when the client is built. A missing
   need is a build error that names it. There is no loader, dependency solver
   or reload at run time.
6. **A program is a participant.** The writer records at admission that it is
   a program and who added it, and the kernel draws that marker. It has a
   person's actions and limits. Nothing reads a room without appearing in it.
7. **Providers stay on the operator's side, compiled in.** Storage has an
   internal interface, because three implementations exist. Reachability and
   forwarding get a published interface when a second independent implementer
   appears.
8. **Internal, proposed, stable.** A point starts internal and free to change.
   It becomes a promise when two independent consumers use it, one of them
   outside the tree, a conformance test exists, and its absence has a defined
   result. After that it only grows, and a break is a new name. The first
   release publishes the wire and storage contract and nothing of the client's
   part interface.
9. **Proof before promise.** Watch-together moves onto the framework first.
   Then a second activity must land without a change to the kernel, a hundred
   joins and leaves must return every connection, listener and timer to its
   baseline, a build without the part must show the fallback without error,
   the plain-sharing build must contain no conversation code, and the session
   hub must shrink by more than the framework adds. If a built-in needs a side
   door, or the code has grown after two features, the scopes and kinds stay
   and the part interface is dropped.

## Settled Before The First Release

These go into [ADR-0017](./0017-contracts-fixed-before-release.md)'s contract,
which deferred the activity envelope until a consumer needed it.

- The envelope on every room record: kind, major version, class, opaque
  payload and fallback text.
- A record of an unknown kind in a known class is ordered and stored. An
  unknown field is kept. An unknown class is refused with a stated reason.
- The handshake carries a version and an open set of capability names in both
  directions, and the writer states its limits.
- The membership record says whether a participant is a program and who added
  it.
- Refusals carry reasons from an open set, and an unknown reason is a plain
  failure.
- Stored records keep their payload as committed, under a format version.
- One reserved field for rules that a kind might later bring to the writer.

## Later, Under Conditions

- **Community interface code** runs in a sandboxed frame with no network,
  served by the person's own channel and pinned by its hash. It waits for the
  first activity that someone outside the tree wants to write.
- **Community rules at the writer**, as a pure function that accepts or
  refuses a record, wait for two real activities that the three classes and a
  referee participant cannot express, and for a measured bound on what it
  costs a Browser that hosts a room.

## Not Built

Community code in the writer or in a client's own realm. Hooks that intercept
or rewrite another person's record. Permissions or roles for extensions.
A registry run by the project, or code loaded from an address. Undoing a
shared effect: a retraction is another ordered record. A point with a
definition and no second provider or consumer.

## Where The Designs Differed

| Topic | Positions | Taken here |
| --- | --- | --- |
| Provider interfaces | Three published seams (two); storage only, internal (one) | Storage only, until a second implementer exists |
| Classes of shared state | Three (two); two, without signals (one) | Three, since signaling already exists |
| Rules of a community activity | A referee participant (two); the same reducer in every client (one) | Left to the first real activity |

## Consequences

- The sentence in the engineering standard that refuses a generic plugin
  framework gives way to this record for the points it defines.
- The activity envelope moves from deferred to settled before release.
- Each owner taken out of the session hub is written as a scope.

## References

- [Reference harness](https://github.com/deepseek-ai/deepseek-harness) and its
  [framework primer](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer):
  services, typed events, reversible effects, seams and profiles. Its plugin
  code is not sandboxed.
- [Extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)
  and [proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api):
  extensions outside the page, and proposed apart from stable.
- [Extension points](https://backstage.io/docs/backend-system/architecture/extension-points):
  declared by their owner, additions only, a new name to break.
- [Extensible events](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/1767-extensible-events.md):
  a text fallback for a type a client does not know.
- [How plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/):
  a sandbox with a narrow interface.
- [The future of developing add-ons](https://blog.mozilla.org/addons/2015/08/21/the-future-of-developing-firefox-add-ons/):
  what complete access to internals cost.
- [Extending Caddy](https://caddyserver.com/docs/extending-caddy): modules
  compiled in, with provision, validation and cleanup.
