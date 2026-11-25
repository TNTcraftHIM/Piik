# Piik standards

Current product and engineering rules live here. Start with the affected subject;
the [ownership map](./documentation.md#owners) explains where each fact belongs.
[AGENTS.md](../../AGENTS.md) owns task authority and
[Contributing](../../CONTRIBUTING.md) owns delivery.

The 3.0 entries distinguish today's prototype from the target designs for
hosting and routing. Published 2.x rules are maintained in the
[2.x standards on main](https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/README.md). Engineering, visual language and
delivery rules apply to both lines.

| Subject | Standard |
| --- | --- |
| Module responsibility, resources, interfaces and contextual consistency | [Engineering](./engineering.md) |
| Product names, terminology, Chinese/English voice and content layers | [Naming and copy](./naming.md) |
| 3.0 authority, activities, routing and runtime lifetimes | [Channel/network model](../research/channel-network-design.md) |
| 3.0 room policy, history, identity and file storage | [Room-data model](../research/channel-storage-and-identity.md) |
| 3.0 target channel modes, authority and moderation | [Server hosting design](../research/server-hosting-plan.md) |
| 3.0 target forwarding model and candidate delivery details | [Channel, room and activity forwarding](../research/channel-forwarding-plan.md) |
| 3.0 remote input authorization, simultaneous control and release | [Remote control](./remote-control.md) |
| 3.0 capture, encoders, media adaptation and audio | [Media quality](./media-quality.md) |
| 3.0 App and Server UI language selection and launcher handoff | [Naming and copy · Interface languages](./naming.md#interface-languages) |
| Evidence behind each status, indicator, overlay and notice | [Media status](./media-status.md) |
| Action ownership, grouping, layout, controls, cast, colour and motion | [Interface design and visual language](./visual-language.md#action-ownership-and-grouping) |
| Website, README and introduction-film composition | [Public introduction](./public-introduction.md) |
| 3.0 Server and App settings, startup and diagnostics | [Server and App runtime](../../prototype/channel-server/README.md#run) |
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
