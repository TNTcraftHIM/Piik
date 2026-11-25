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

Three designers worked from the requirements and this evidence without
reading the repository, one of them asked to find where a plugin boundary
costs more than it gives. The implementer then traced the proposal against
the present consumers, authority, layouts and record formats. This record
holds what survived both.

## Decision

1. **One vocabulary, four places.** A *point* is a typed place of attachment
   declared by its owner. A *contribution* is what attaches to it. A *kind*
   names shared room data. Authority never comes from being an extension: it
   comes from admission, or from operating a machine. The words are settled
   now. A point becomes a type in the code when its owning operation has a
   second consumer.

   | Place | What runs there | What it can never do |
   | --- | --- | --- |
   | The room's writer | The compiled core only | Run community code, or let one record alter or block another |
   | A person's client | Parts compiled into the build | Start capture, the microphone or control except through that person's act |
   | A participant process | A bot or API client | More than a person can do on the wire |
   | The operator's machine | Providers | Decide admission or order |

2. **Built-in records keep their compiled forms.** A generic record for a
   community kind, with a namespaced name, an opaque payload and a fallback
   text, is added as a capability when the first extension needs it. Wrapping
   every present record in one envelope was measured: a short signed message
   grew from 727 to 789 bytes, a store of a thousand short messages grew by
   about a fifth, and an append-only record conflicts with how deletion
   removes a body, a thumbnail and a quote today. What has to hold before
   release is the compatibility rule of
   [ADR-0017](./0017-contracts-fixed-before-release.md), so that such a
   capability can be added without breaking a released client.
3. **Each owner undoes its own registrations.** A lifetime owner releases its
   listeners and the leases it borrowed when it ends, as
   [ADR-0015](./0015-browser-session-lifetime-owners.md) decided. Ending one
   owner does not end another: closing a tool, browsing another room or
   leaving one use of a shared connection leaves the other activities
   running. Events notify; nothing intercepts.
4. **The full place and plain screen sharing are two views of one session**,
   not two builds. Typed imports already make a missing dependency a compile
   error. There is no loader, dependency solver or reload at run time.
5. **A program is a participant.** A program is marked when it is enrolled
   through an authenticated act; an ordinary credential cannot show whether a
   person or software holds it. One gap stands in the way of saying that
   nothing reads a room unseen: an authorized history read does not require
   presence today.
6. **Providers stay on the operator's side, compiled in**, behind internal
   contracts where interchangeable implementations really exist. Planner and
   transport interfaces are not published without a consumer.
7. **Internal, proposed, stable** applies to extension points. A point starts
   internal, and becomes a promise when independent consumers use it, a
   conformance test exists and its absence has a defined result. The
   compatibility of the wire and of stored data stays with its present owner.
8. **A paired experiment before any part interface.** Apply the same
   ADR-0015 extraction to two arms of one feature, starting at watch media or
   at the stage's handoff. Credit the part interface only with the mappings
   and dependencies it removes beyond that extraction. Check that sibling uses
   survive and leases are returned. An abstraction that does not earn its
   place is not kept.

## Later, Under Conditions

- **Community interface code** runs in a sandboxed frame with no network,
  served by the person's own channel and pinned by its hash. It waits for the
  first activity that someone outside the tree wants to write.
- **Community rules at the writer**, as a pure function that accepts or
  refuses a record, wait for two real activities that a generic record and a
  referee participant cannot express, and for a measured bound on what it
  costs a Browser that hosts a room.

## Not Built

Community code in the writer or in a client's own realm. Hooks that intercept
or rewrite another person's record. Permissions or roles for extensions. A
registry run by the project, or code loaded from an address. A point with a
definition and no second provider or consumer.

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
