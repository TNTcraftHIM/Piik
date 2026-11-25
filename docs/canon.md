# Canon

The settled core design of Piik: the founding ideas that the rest of the
project follows, and that would still hold if every line of code were
rewritten. Anyone may question a statement and propose a better idea, with
evidence. Only the owner changes one, and until then it holds. A departure is
raised with the owner before anything else changes. An owner decision that
departs from a statement changes that statement, and is written here.

A statement here is general and lasting. It carries no dates, incidents,
numbers or mechanism names. The design that follows from a statement, and the
decisions made along the way, live in the records linked beside it. Those can
be replaced by a better design that serves the same statement.

## Purpose

- **Everyone can share a screen.** Piik began so that anyone could share
  their screen with friends, and that stays its measure: low delay, and a
  picture that stays smooth and clear. Saving an encoder or bandwidth never
  justifies a worse picture.
- **A self-hosted home for friends.** Piik is a place a group of friends runs
  for themselves, in the way Discord or TeamSpeak is a place: rooms with
  conversation, voice, files and screen sharing, complete enough to stay in.
  It can also be used in its simplest form, as a direct way to share a screen
  beside whatever else people already use.
- **Friends, in private.** Piik is for people who know and trust each other.
  It is not a public broadcast platform.
- **Free, open, and anyone can host.** Anyone can host from their own device,
  and a server is optional. Nothing depends on a service the project runs or
  on infrastructure someone has to rent. Each channel stands alone.
- **A link and a browser.** Joining a friend takes a link and a browser: no
  installation, no account and no network setup. The App adds capability and
  is never a prerequisite.

## Shape

- **Channel, room, activity.** A channel owns identities, the room directory
  and signaling. A room owns its people, policy and history. An activity is
  something people do together in a room, and each activity starts and ends on
  its own. The interface calls a channel a site.
  [ADR-0016](./adr/0016-shared-rust-core.md)
- **One authority per room.** A room has exactly one writer, which commits
  before it confirms. Confirmed means saved.
- **Hosting places the room.** The hosting mode decides where a room's writer
  and records live: on its creator's device, or on the server when the channel
  is hosted. Who may enter is a separate choice, and running a channel grants
  no admission to its rooms. [Hosting](./research/server-hosting-plan.md)
- **Saved and live are separate.** Identities, policy and confirmed content
  are saved. Presence, routes, captures and calls are live: they are rebuilt
  from fresh sessions and never restored from storage.
  [Room data](./research/channel-storage-and-identity.md)
- **One implementation of the rules.** The same rules run in the Browser, the
  App and the Server from one shared core. A runtime executes them and owns
  only its local resources.
- **Two planes.** Metadata and light data travel on the basic channel
  connection. Media and large data travel on the routes chosen for them. Light
  data never waits for a route.
  [Network model](./research/channel-network-design.md)

## Media And Network

- **P2P first.** Media travels between participants, directly or through
  other participants. Forwarding by a server is the fallback, and it never
  replaces a healthy path between participants.
  [ADR-0001](./adr/0001-p2p-first-media-topology.md)
- **Load is shared.** No single machine should have to carry a room's media.
  Work follows actual demand, and whoever is able carries a part.
- **Direct paths are worth real effort.** Every pair that fails to connect
  directly costs someone else a full stream, so reaching through difficult
  NATs is part of the product. [NAT traversal](./research/nat-traversal.md)
- **Many ways to be reached.** A host can be reached through a free public
  tunnel, which is the baseline anyone can use, and equally through a tunnel
  or proxy of their own, a port mapping, a public address or a server they
  run. All are supported side by side. None is required, and none replaces
  another.
- **The same rule for every node.** Any admitted, capable participant may
  forward for another, and a server that forwards is one more candidate under
  the same grant, plan and proof. Each forwards in the way it is able to, and
  a node re-encodes only when that is needed.
  [Forwarding](./research/channel-forwarding-plan.md)
- **Automatic.** Routing and quality take care of themselves. Nobody chooses
  a topology or tunes a network for Piik to work well. What people and
  operators decide is policy: who may carry what.
  [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md)
- **Always improving, quietly.** The topology keeps improving by itself,
  judged by how playback actually goes and how well two nodes suit each
  other, until every node has its best upstream and downstream. Nobody
  notices it happen: a working path is replaced only by one already proved
  better, and the system never stops a person's activity on their behalf.
- **Proved, not inferred.** Reachability and readiness are established by
  real connectivity checks and delivered media, never by a label, an estimate
  or an open connection. Every attempt ends in usable media, bounded waiting
  or a clear failure.

## Trust

- **Admission.** A room is entered by invitation. Admission is full
  participation: friends configure no permissions to talk, share or watch.
  Everything that carries a room's content is authorized for that room, and
  only for what it carries. Losing access stops delivery; copies already
  received cannot be recalled.
- **Nothing starts without the person.** Capture, microphone, remote control
  and data leaving a device each begin only by that person's own act. None is
  restored, inherited or granted by someone else's authority.
- **Data stays with whoever is responsible for it.** A channel keeps only the
  basic metadata it needs, such as identities and the room directory.
  Everything else about a room stays with whoever hosts it. Original files
  stay with the people who hold them.
- **Honest about what can be seen.** Piik says plainly what each party can
  see: a channel can read the conversation it carries, and a forwarder the
  media it forwards. It claims no privacy or connectivity it does not provide.

## Experience

- **Simple to use, not simple inside.** Using Piik takes no knowledge of
  networks and no setup. That simplicity belongs to the person. The design
  behind it is as capable as the experience needs, and stays clear, general
  and efficient.
- **Polished.** A polished experience is part of the design, in interface,
  interaction and code. Working behaviour alone does not meet it.
- **Truthful.** The interface shows only what current evidence supports.
  Unknown stays unknown, and nothing invents progress, success or quality.
  [Media status](./standards/media-status.md)
- **One product everywhere.** Browser, App and Server share one interface,
  vocabulary and visual language. A deployment changes what is available,
  never what the product is, and an optional capability never blocks the
  basic path.
- **A living room, not a dashboard.** Warm and a little playful. Playfulness
  never replaces clarity. [Visual language](./standards/visual-language.md)

## How It Is Built

- **Correct, reasonable, elegant, general.** Every design is held to these
  four. Prefer one simple, direct mechanism that covers the general case, and
  let a rare failure stop at its owner. The
  [principles](../AGENTS.md#principles) and the
  [failure boundary](./standards/engineering.md#failure-boundaries) say how.
- **Mature first, not mature only.** Use a mature implementation wherever one
  meets the need. By default the WebRTC stacks own congestion control, pacing,
  loss recovery and rate adaptation. Where a mature piece falls short,
  building that part ourselves can be better than keeping a fork in step with
  its upstream or joining scattered libraries together. That is judged case by
  case, on evidence.
