# ADR-0020: One Vocabulary For Extension

- Status: proposed
- Date: 2026-11-25

## Context

The [canon](../canon.md#how-it-is-built) asks for a small core that is open to
extension. The owner's direction: what a later extension needs from the first
release is decided before that release; an interface for community code is
built only when it can be general, simple and cheap to keep; until then the
project is the only source of new features, and its own interfaces and
protocols are designed for the growth and change to come.

The model is an agent harness built wholly from plugins on a small kernel: a
plugin declares what it needs and provides, every registration can be undone,
a seam has a definition, a provider and a consumer, and the product itself is
composed from plugins only. One thing does not carry over. That harness serves
one trusted person on one machine. In a room, other people are affected by
code they never approved, stored history cannot be undone, and each
participant may run different extensions, so the shared rules have to stay
fixed.

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

2. **The first release fixes three rules for later growth, and no interface.**
   After a release, the readers and writers already installed decide what a
   later version may add ([ADR-0017](./0017-contracts-fixed-before-release.md)).
   For a room's history:
   - *A reader shows what it understands.* A message carries its author,
     sequence, time, text and files. Optional presentation additions belong
     on that message. An older reader may ignore those fields and display
     the recognized text and files, including an attachment-only message.
     The signature covers the original payload before this projection.
     Nested structures retain their defined shapes; they are not separate
     extension points.
   - *The writer is strict and says what it stores.* A writer refuses a draft
     that carries anything it does not know at the existing signed-command
     boundary, with a rejection correlated to that request. A new feature
     adds its capability to the room's existing contract together with its
     producer and consumer. No generic capability registry is needed first.
   - *A program is a participant* (decision 5). It joins and acts through
     the wire a person's client uses, so no second interface has to keep
     step with the first, and joining never comes to depend on something only
     a browser has. The tree's own text participant already reads and writes
     this way from Node.

   Tests exercise an additive message field through each actual reader,
   preserve payload signature verification, and require unsupported drafts
   to be rejected through the existing reply. Editing
   ([ADR-0019](./0019-the-life-of-a-message.md)) supplies the first real
   additional presentation field. Deleting a message removes its additions
   with it. Archives remain strict and reject data the receiving writer
   cannot preserve before installation. Wire and stored-format compatibility
   remain under the existing versioning policy.
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
   person or software holds it. Current history reads require an admitted
   session and room access; they do not require the separate Browse state.
   Any stronger visible-reading rule needs its own product decision. A program
   gets its verbs through the core and the room's writer, as a person's client
   does. It attaches at no point, so it is not the second consumer that turns
   a point into a type, and it is no evidence for a registry.
6. **Providers stay on the operator's side, compiled in**, behind internal
   contracts where interchangeable implementations really exist. Planner and
   transport interfaces are not published without a consumer.
7. **Internal, proposed, stable** applies to extension points. A point starts
   internal, and becomes a promise when independent consumers use it, a
   conformance test exists and its absence has a defined result. The
   compatibility of the wire and of stored data stays with its present owner.
8. **Extract the owner first, then a paired experiment before any part
   interface.** The ADR-0015 extraction stands by itself and is done first.
   Then apply the same extraction to two arms of one feature, starting at
   watch media or at the stage's handoff. Credit the part interface only with the mappings
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

- [RFC 9170](https://www.rfc-editor.org/rfc/rfc9170.html): an extension
  mechanism stays usable only while it is used, a protocol's invariants are
  written down, and fewer extension points are safer than many.
- [XEP-0428, Fallback Indication](https://xmpp.org/extensions/xep-0428.html):
  a client that does not know an extension shows the message's body.
- [IRCv3 capability negotiation](https://ircv3.net/specs/extensions/capability-negotiation.html):
  a server lists what it supports, a client that asks for nothing gets the
  baseline, and a name outside the project begins with a domain.

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
- [Matrix client-server API](https://spec.matrix.org/latest/client-server-api/)
  and [room version 11](https://spec.matrix.org/latest/rooms/v11/): one event
  form for every type, a reserved namespace, and redaction that strips content
  and keeps a skeleton.
- [XEP-0424, Message Retraction](https://xmpp.org/extensions/xep-0424.html):
  archives may keep a tombstone in place of the retracted message.
- [Mattermost v1.0 post validation](https://github.com/mattermost/mattermost/blob/v1.0.0/model/post.go#L99-L101)
  and [v10.11 post model](https://github.com/mattermost/mattermost/blob/v10.11.0/server/public/model/post.go):
  one post form whose early validator accepted only built-in types, later extended
  with prefixed custom types.
- [Extensions over Any](https://protobuf.dev/design-decisions/extensions-over-any/):
  what a string type name costs on every record.
- [Discord message resource](https://docs.discord.com/developers/resources/message):
  a closed set of types, with a second component model added beside the first.
