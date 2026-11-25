# 3.0 Design Review Against Clean-Room Designs

- Date: 2026-11-25
- Reviewed tree: `35034f34`
- Status: evidence for decisions, not a decision. The proposals it supports are
  in [ADR-0017](../adr/0017-contracts-fixed-before-release.md) and
  [TODO](../todo.md).

## Why

Every earlier review of 3.0 started from the code, so each one inherited the
code's boundaries. This review asked what an architect would build from the
requirements alone and compared the answer with what exists. Where independent
designs agree with each other and differ from the tree, the comparison is worth
testing; it does not show which side is right, and the designers are one model
family. Where they agree with the tree, the choice follows from the product.

## Method

1. A requirements brief was written from the product's intent, with no term
   from the implementation: what people do in a room, who runs a site and
   where room data lives, the network they sit behind, and the qualities the
   owner asks for.
2. Three designers worked from that brief and from primary sources on the web.
   None read the repository. Two received the identical brief. The third was
   also told to test whether the conventional answer was wrong.
3. Separately, three audits read the tree: the wire and its schema, storage
   and the revision model, and the internal interfaces. Each finding was
   checked against the cited lines.

The requirements-only designs were not built or measured. A design from a brief does not know
what the project learned by running. The designers are instances of one model
family, so their agreement is weaker evidence than three human architects
agreeing would be.

## What All Three Designs Share With The Tree

These follow from the requirements and should stay.

- A site owns identity, the room directory and rendezvous.
- Each room has one single-writer authority, and the same code runs it on the
  creator's device or on the server. The two storage modes are one design in
  two places.
- One sans-I/O Rust core is compiled natively and to WebAssembly
  ([sans-I/O](https://sans-io.readthedocs.io/how-to-sans-io.html)). Platform
  code decides how, never whether or for whom.
- Media is WebRTC, with the browser's stack in browsers and
  [str0m](https://github.com/algesten/str0m) natively. Congestion control,
  pacing and the jitter buffer are not rebuilt.
- Durable state is rows, not an event log, and there is no CRDT, federation or
  second writer. Immediate revocation needs one authority.
- The route planner is a pure function that belongs to the room authority.
  All three place it there. An earlier audit's suggestion to move it to the
  site is withdrawn.

## Where All Three Designs Differ From The Tree

Each row is something all three designers chose and the tree does not do. The
audits reached the same point from the code in every row marked †.

| Topic | The three designs | The tree |
| --- | --- | --- |
| Client logic † | The client engine is a state machine in the shared core, in a Worker in the browser. The interface holds no domain state: intents go in, view slices come out. | A 4,060-line TypeScript hub; the participant's rules exist again in Rust. |
| Schema † | One schema language is the source for wire and stored blobs. Only the core encodes and decodes; TypeScript types are generated. | Five hand-kept copies. |
| Compatibility † | A major version must match, and everything else is additive and announced by capability ([Protocol Buffers](https://protobuf.dev/programming-guides/proto3/), [RFC 9413](https://www.rfc-editor.org/rfc/rfc9413.html)). | The protocol number must equal 46. One outer watch-activity metadata reader accepts additions; source kinds, source fields and playback types are still validated. |
| Synchronisation † | A snapshot, then ordered events with a revision; a gap means subscribe again. History is paged, never part of the snapshot. | A full snapshot to every session on every change. |
| Requests † | A request id, an idempotency key on every mutation, and one reply. Errors are a closed code set with a stable reason and a retry class ([status codes](https://grpc.io/docs/guides/status-codes/)). | Several reply forms and about 120 string codes that do not tell rejected from unknown. In the Browser an unknown reply type resolves most room requests as success. |
| Storage † | One SQLite file per room with one schema in all three runtimes, using [SQLite on OPFS](https://sqlite.org/wasm/doc/trunk/persistence.md) in the browser. Numbered forward migrations run on a copy; a newer file is refused. | Two adapters with different shapes and an exact-version check. No format change has needed an upgrade yet. |
| Topology | The plan is replicated desired state and every endpoint reconciles its links to it ([controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/)). The lower endpoint id always offers, so collisions cannot occur. | One transport book in the domain; each session reconciles to its own filtered projection. Media proof and handoff are imperative. |
| Capacity | A budget in bits, 70 to 80% of an uplink learned from sustained aggregate send. Two links degrading together mean the shared uplink. Depth is bounded. | A fanout peer count, 2 by default, set per room from 1 to 20 and per session from 0 to 20. Capacity is not measured in bits, and depth is unbounded. |
| Picture † | Two modes. Sharp uses the `text` hint, never downscales and refines a still frame. Smooth uses `motion` ([content hints](https://www.w3.org/TR/mst-content-hint/)). | Every share is hinted `motion`. |
| Connectivity † | The site's own endpoint answers STUN and offers a passive TCP candidate ([RFC 6544](https://www.rfc-editor.org/rfc/rfc6544)). | No TCP path; third-party STUN. |
| Revocation | A lease: an endpoint that cannot hear the room authority for 6 to 10 s closes its links and stops capture. | Explicit room revocation, connection and binding retirement, bounded recovery and WebRTC consent. There is no separate room-authority heartbeat lease. |
| Extension † | Every activity, built-in ones included, implements one trait. A whiteboard is a schema, a reducer, a panel and two registry lines. | About eleven non-interface files per new kind. |
| Verification | A whole room runs in one process on virtual time with injected faults ([simulation testing](https://apple.github.io/foundationdb/testing.html)). | Control-plane tests run on explicit time with scripted pair and media failures. No seeded simulation of whole runtimes. |

## Where The Tree Knows More Than The Designs

- **Reaching a home-run site, and why direct paths matter.** All three designs
  assume a port mapping, IPv6 or a certificate for a bare address, and all
  three name a host behind carrier-grade NAT as their largest unsolved risk.
  The tree reaches such a host through a tunnel for signaling. Media then has
  to punch through, which is why the tree's hole punching goes further than
  any of the designs.

  All three reject port prediction. None argues that it is unreliable. Each
  says only that a forwarder always exists, so a failed pair is routed through
  it. That rests on two things the tree does not accept. The first is the
  reachability assumption above. The second is a gap in the brief: it allowed
  the site to forward and did not state that Piik is meant to be decentralized,
  with no machine carrying a room. Every pair that fails to connect directly
  costs a forwarder the full stream, about 1.35 GB an hour for one viewer at
  3 Mbps, and the designs' own arithmetic has the site endpoint saturating
  first.

  The published figures support the techniques for the cases they target.
  [Richter et al., 2016](https://arxiv.org/abs/1605.05606) classify the port
  allocation observed on TCP connections by autonomous systems detected as
  carrier-grade NAT: sequential in 22 to 26% and random in 36 to 45%.
  [Guha and Francis, 2005](https://www.usenix.org/legacy/event/imc05/tech/full_papers/guha/guha_html/)
  estimate TCP hole punching over the NAT pairings they sampled at 44.6%
  without port prediction and 84.3% with it. A UDP model gives about a 64%
  chance of hitting a mapping after 256 distinct probes and 98% after 1,024,
  given one known stable endpoint and 256 distinct live mappings toward it.
  With independent random mappings and exact return-tuple filtering on both
  sides, a reverse-tuple collision is small but not impossible
  ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works)). None of
  these is a field measurement of UDP traversal for this product. Piik has no
  project-operated relay network, so improving direct connectivity can reduce
  the forwarding work participants or their own servers must provide.

  What the designs do contribute is the shape: a predicted or searched address
  is a candidate for the one ICE agent, not a second traversal procedure
  beside it.
- **Handoff proof.** The tree commits a route change only on the receiver's
  decoded-frame proof. The designs assume a link that connects also carries
  media.
- **Encoder behaviour.** The tree's ports of the quality scaler and frame
  dropper, and its measurements of hardware encoders, are knowledge the
  designs list as open risks.

## Where The Designs Disagree With Each Other

| Topic | Positions |
| --- | --- |
| A Browser that relays by re-encoding | Never (one); last resort, one per path (two) |
| Desktop shell | Bundled Chromium (two); system web view (one) |
| Whether the site can read a device-hosted room | End-to-end encrypted room link (two); site trusted for control traffic (one) |
| Tree depth | Two forwarders (one); four hops (two) |

These are judgement calls, not errors in the tree.

## What The Audits Add

Findings with their lines are in the audit record that produced
[ADR-0017](../adr/0017-contracts-fixed-before-release.md). The ones no design
could have seen:

- The Browser writer can confirm a message before it is durable, because
  IndexedDB transactions default to relaxed durability. Persistent storage
  guards against eviction, which is a separate matter.
- A reader that was offline across a restore can miss new messages when the
  restored sequence catches up to its old cursor. A normal restart should keep
  read positions, and a restore should invalidate them. Room copies already
  have distinct IDs.
- The room writer's role is written twice, once in Native and once in the
  Browser, with no reachable difference found. The copies differ in the
  `host_session_id` check, first broadcastable record against one per reply,
  skipping replies addressed to itself, and a dispatch error ending Native's
  loop. None changes an outcome for input the current domain produces: it
  names the binding session as both recipient and `host_session_id`, each
  commit yields at most one broadcastable record, the Native writer is never a
  reader while the Browser writer tab usually is, and storage failures return
  through `abort` in both.
  Core already owns broadcast eligibility. Browser recipient selection occurs
  after queued access changes and signing; moving it into the earlier shared
  dispatch would snapshot readers before a queued revocation. Keep that timing
  at the adapter unless a shared result preserves the same order.
- The five cursors on a writer binding reduce to one applied position and
  named barriers.

## Outcome

The founding ideas that the brief left out, and that the designs departed from
for that reason, are stated in the [canon](../canon.md). A later brief should
carry them. The contract proposals are in
[ADR-0017](../adr/0017-contracts-fixed-before-release.md), and the remaining
work is in [TODO](../todo.md).
