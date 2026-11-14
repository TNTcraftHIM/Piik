# Piik standards

Current product and engineering rules live here. Start with the affected subject;
the [ownership map](./documentation.md#owners) explains where each fact belongs.
[AGENTS.md](../../AGENTS.md) owns task authority and
[Contributing](../../CONTRIBUTING.md) owns delivery.

The room, routing, media and lifecycle product contracts below describe published
2.x. Isolated 3.0 uses the accepted [channel/network model](../research/channel-network-design.md)
and [room-data model](../research/channel-storage-and-identity.md). Engineering,
visual language and delivery rules apply to both lines.

| Subject | Standard |
| --- | --- |
| Module responsibility, resources, interfaces and contextual consistency | [Engineering](./engineering.md) |
| Product names, terminology, Chinese/English voice and content layers | [Naming and copy](./naming.md) |
| 3.0 authority, activities, routing and runtime lifetimes | [Channel/network model](../research/channel-network-design.md) |
| 3.0 room policy, history, identity and file storage | [Room-data model](../research/channel-storage-and-identity.md) |
| Published 2.x room authority, invitation/password access and persistence | [Rooms and access](./rooms-access.md) |
| Published 2.x routes, capacity, P2P/SFU transitions and route operations | [Routing and transport](./routing-transport.md) |
| Published 2.x capture, encoders, media adaptation and audio | [Media quality](./media-quality.md) |
| Published 2.x workflow, playback and Browser/App lifecycle | [Presentation and lifecycle](./presentation-lifecycle.md) |
| Evidence behind each status, indicator, overlay and notice | [Media status](./media-status.md) |
| Action ownership, grouping, layout, controls, cast, colour and motion | [Interface design and visual language](./visual-language.md#action-ownership-and-grouping) |
| Website, README and introduction-film composition | [Public introduction](./public-introduction.md) |
| Runtime settings, defaults, bounds and diagnostics | [Configuration](./configuration.md) |
| Compatibility, build identity, publication and release notes | [Versioning](./versioning.md) |
| Documentation responsibilities and updating a rule | [Documentation ownership](./documentation.md) |

Before another implementation of a familiar concept, identify its fact, owner,
scope and lifetime. Apply the existing rule, or explain the contextual difference
at that rule's owner. Source schemas and focused tests own exact implementation
details; standards need not repeat every field or function.

[ADRs](../adr/) preserve decisions and supersession. [Research](../research/)
preserves dated observations and limits. [TODO](../todo.md) owns work that remains,
including accepted targets not yet implemented. A recorded target is not a claim
of completed verification. User guides remain in the [documentation index](../README.md).
