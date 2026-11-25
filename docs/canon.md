# Canon

The settled core design of Piik: the founding ideas that the rest of the
project follows, and that would still hold if every line of code were
rewritten. Anyone may question a statement and propose a better idea, with
evidence. Only the owner changes one, and a departure is raised with the owner
before implementing it. An owner decision that departs from a statement
changes that statement, and is written here.

A statement here is general on purpose. It states a principle, not a case: no
dates, incidents, numbers or mechanisms, and no list of exceptions. The
records linked beside a statement hold the design that follows from it, and
that design can be replaced by a better one that serves the same statement.

## Purpose

- **Everyone can share a screen.** Piik began so that anyone could share
  their screen with friends, and that stays its measure: low delay and a
  smooth, clear picture. Quality comes before saving resources.
- **A self-hosted home for friends.** A place a group of friends runs for
  themselves, in the way Discord or TeamSpeak is a place, complete enough to
  stay in. It also works in its simplest form, as plain screen sharing.
- **Friends, in private.** For people who know and trust each other, not a
  public broadcast platform.
- **Free, open, and anyone can host.** Anyone can host from their own device.
  A server is optional, and nothing depends on a service the project runs or
  on rented infrastructure.
- **A link and a browser.** Joining takes a link and a browser: no
  installation, no registration, no network setup. The App adds capability
  and is never required.

## Shape

- **Channel, room, activity.** A channel owns identities, the room directory
  and signaling. A room owns its people, policy and history. An activity is
  something people do together in a room, with its own lifetime. The
  interface calls a channel a site.
  [ADR-0016](./adr/0016-shared-rust-core.md)
- **One authority per room.** A room has exactly one writer, which commits
  before it confirms.
- **Hosting places the room.** The hosting mode decides where a room's writer
  and records live: on its creator's device, or on the server. Running a
  channel grants no admission to its rooms.
  [Hosting](./research/server-hosting-plan.md)
- **Saved and live are separate.** Identity, policy and confirmed content are
  saved. Everything live is rebuilt from fresh sessions, never restored.
  [Room data](./research/channel-storage-and-identity.md)
- **One implementation of the rules.** The same rules run in every runtime
  from one shared core. A runtime owns only its local resources.
- **Two planes.** Light data travels on the channel connection and is handled
  by the authority of the channel or room. Heavy data travels on routes of its
  own and is distributed by the activity that originates it.
  [Network model](./research/channel-network-design.md)
- **Two shared pools.** Activities own neither connections nor encoders. Both
  are pooled. A pool serves a request from what already exists and improves
  itself slowly: connections toward a more reliable graph, encodings toward
  fewer encoders.
- **Subsets downward, built upward.** Each level uses a subset of the one
  above: channel, room, activity. Connections are built mostly the other way,
  by the activity that needs one, and kept for the next. When idle, the pool
  may also build and check connections ahead of need.
  [Forwarding](./research/channel-forwarding-plan.md)

## Media And Network

- **P2P first.** Media travels between participants, directly or through
  other participants. Forwarding by a server is the fallback.
  [ADR-0001](./adr/0001-p2p-first-media-topology.md)
- **Load is shared.** No single machine should have to carry a room's media.
  Whoever is able carries a part.
- **Direct paths are worth real effort.** Every pair that fails to connect
  costs someone else a full stream, so reaching through difficult NATs is part
  of the product. [NAT traversal](./research/nat-traversal.md)
- **Many ways to be reached.** A host can be reached through a free public
  tunnel, which anyone can use, or by means of their own. All are supported
  side by side, and none replaces another.
- **The same rule for every node.** Any admitted, capable participant may
  forward for another, and a server is one more candidate. A node re-encodes
  only when it must.
- **Automatic.** Routing and quality take care of themselves. Nobody chooses
  a topology or tunes a network.
  [ADR-0005](./adr/0005-automatic-hybrid-media-routing.md)
- **Always improving, quietly.** The topology keeps improving by itself,
  judged by how playback actually goes, until every node has its best
  upstream and downstream. It never disturbs what works.
- **Proved, not inferred.** Reachability and readiness come from real checks
  and delivered media. Every attempt ends in success, bounded waiting or a
  clear failure.

## Trust

- **Admission.** A room is entered under its own access policy, and admission
  is full participation. Whatever carries a room's content is authorized for
  it.
- **Nothing starts without the person.** Capture, microphone, remote control
  and data leaving a device begin only by that person's own act.
- **Data stays with whoever is responsible for it.** A channel keeps only
  basic metadata. A room's content stays with its host, and files with their
  holders.
- **Honest about what can be seen.** Piik says plainly what each party can
  see, and claims no privacy or connectivity it does not provide.

## Experience

- **Simple to use, not simple inside.** Using Piik takes no knowledge of
  networks and no setup. The design behind it is as capable as the experience
  needs.
- **Polished.** A polished experience is part of the design. Working
  behaviour alone does not meet it.
- **Truthful.** The interface shows only what current evidence supports.
  [Media status](./standards/media-status.md)
- **One product everywhere.** Browser, App and Server share one interface and
  one language. An optional capability never blocks the basic path.
- **A living room, not a dashboard.** Warm and a little playful, and always
  clear. [Visual language](./standards/visual-language.md)

## How It Is Built

- **Correct, reasonable, elegant, general.** Every design is held to these
  four. Prefer one simple, direct mechanism for the general case, and let a
  rare failure stop at its owner. The [principles](../AGENTS.md#principles)
  and the [failure boundary](./standards/engineering.md#failure-boundaries)
  say how.
- **Reuse mature stacks.** Lean on WebRTC and other mature implementations as
  far as they go, because their tuning is hard won. Building a part ourselves
  is the exception, judged case by case.
