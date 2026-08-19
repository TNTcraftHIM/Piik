# ADR-0004: Peer-Assisted Media Experiment

- Status: Proposed - Experiment Only
- Date: 2026-08-19

## Context

ADR-0001 accepted standard browser WebRTC P2P for the MVP and rejected a viewer
relay tree because it adds churn, latency, and either browser re-encoding or a
custom packet-forwarding protocol. Real multi-viewer use later degraded severely.
The product now also has a hard target that a broadcaster must never carry more
than two outgoing media edges.

Closed PR #12's explicit whole-room SFU proposal under ADR-0003 is historical
and superseded. Merged PR #17 instead supplies ADR-0005's default-off automatic
optional-SFU fallback. Making that fallback the normal path would still move
every viewer's egress cost to the server. TeamSpeak-style shared encoding
reduces host encode work but still sends one network copy to every viewer, so it
cannot meet the new fanout target alone.

The research in `docs/research/peer-assisted-media.md` finds no browser API that
can move one encoded frame between `RTCRtpSender` pipelines. Standard browser
track relay decodes and re-encodes at each hop. The first experiment accepts
that measurable cost because avoiding it requires a custom encoded-frame media
plane.

This ADR does not accept peer-assisted media for production. It proposes one
bounded experiment that must either meet explicit gates or be removed.

## Proposed Experiment

Preserve the product priority in this order:

1. direct P2P for one or two viewers;
2. peer-assisted forwarding for later viewers when this experiment is active
   and every required capability is present; and
3. the ADR-0005 SFU virtual parent as the flagship central fallback while
   retaining bounded peer descendants.

This bounded experiment implements only the first two levels. That scope must
not be read as requiring users to select a topology or rejecting automatic
cross-mode fallback as a product goal.

The experiment is gated by `PEER_ASSISTED_MEDIA`, which defaults to `false`.
Enabling it requires `MAX_VIEWERS_PER_ROOM` at or below eight; larger configured
rooms fail configuration rather than silently running a different topology.
A required non-empty `PEER_ASSISTED_ROOM_IDS` deployment allowlist restricts
the experiment to exact valid room IDs. Non-allowlisted rooms use the current
ordinary P2P authenticated wire, signaling, quality behavior, and lifecycle and
must never enter `HybridMediaRouter`. Missing, blank, invalid, empty-list-entry,
or duplicate values fail startup when the experiment is enabled; there is no
all-room fail-open. This exact-room gate is temporary validation scope and adds
no UI, percentage rollout, or routing score.

The signaling server assigns two sticky, balanced chains with a deterministic
breadth-first walk. The host has capacity for at most two children and each
viewer for at most one. Candidate parents are ordered by depth and server-issued
join sequence. Joining a viewer does not move existing assignments. If a parent
leaves, only its orphaned subtree root is assigned to the first available slot;
the root's descendants stay attached. No RTT, bandwidth, CPU, geography,
capability, or quality scoring is added.

For this ADR, one media edge is one downstream `RTCPeerConnection` carrying the
shared stream. Using TURN for that connection does not alter the edge count. The
host's two-child limit is a hard invariant across join, reconnect,
reparent, and recovery paths. If the deterministic topology has no connected
eligible parent, the viewer remains admitted but waits without media until a
slot becomes reachable; it must not create a third host connection.
Each logical edge still uses its own ICE process. In the repository candidate,
ordinary edges receive only STUN and route exhaustion proceeds to the bounded
SFU virtual parent or clear failure; the old production TURN behavior is not a
same-process compatibility branch.

Every edge uses the existing standard WebRTC media path. A viewer receives the
remote `MediaStream`, renders it, and sends those remote tracks through one new
downstream `RTCPeerConnection`. The browser therefore decodes and re-encodes at
every relay hop. Existing audio follows the same stream when capture provides
it; the experiment does not invent a separate audio protocol.

The authoritative peer-assisted wire value is one exact `QualitySettings`
object, not a profile ID. It accepts only 720p/1080p/1440p, integer 15-60 fps,
integer 2-12 Mbps, and clarity/balanced/fluid preference, with missing, extra,
or out-of-range fields rejected. The three presets remain UI recommendations,
not protocol states. The server keeps the latest object in bounded per-room
memory only; it is not persisted. Authentication carries it, the host reasserts
its local value before reconciling children, and live changes reach online
viewers without an acknowledgement protocol.

`HostPeer`, the current and future viewer relay sender, and an enabled SFU
publisher consume that same last-wins setting. Initial sender setup, successful
track replacement, and live changes use the same serialized mutation path and
read back requested/applied bitrate, frame rate, scale, and preference. A
rejected mutation rolls back or fails closed through the existing route
controller. The ordinary P2P authenticated wire remains unchanged and rejects
room-setting messages. These are sender ceilings and preferences, not proof of
achieved resolution, bitrate, frame rate, or resource cost.

Encoded Transform, DataChannel media, WebCodecs rendering, dummy-sender byte
replacement, custom congestion control, codec ladders, multiple trees, mobile
background relay, and cross-mode SFU migration are excluded from this spike.
They are not rescue work if standard track relay fails; a separate automatic
route-controller ADR owns cross-mode fallback.

## Shared Encoding Boundary

The browser spike may encode once for each of the host's one or two seed
connections because browsers do not guarantee cross-connection encoder reuse.
Each viewer relay also performs one downstream encode. This is tolerated only
for the experiment and must be measured honestly.

A separate planned packaged/native sender must use custom libwebrtc encoder
proxies that share one encoded output while retaining independent standard
WebRTC packetizers for the host's edges. That work requires its own ADR and
measurements regardless of this browser relay experiment's result. It reduces
host encoding work but does not remove the upload copy for each outgoing edge.
It is not implemented or abstracted in advance by this spike. Standard browser
viewing remains required.

## Acceptance Gate

Test 1, 3, 5, and 8 viewers for 30 minutes across the three recommended ceiling
combinations, plus any advanced combination proposed for production, with
controlled per-edge RTT at or below 40 ms and loss at or below 1%. Current
desktop Chrome and Edge form the relay cohort; current Android Chrome and iOS
Safari join last as leaf checks. ADR-0005 now adds a per-session binary relay
capacity: detected mobile/iPad clients report zero and desktop-class browsers
report one. That heuristic, background lifecycle, and voluntary relay policy
remain unverified, so the spike is still unsafe for arbitrary-user deployment.

The proposal advances only if every condition holds:

- host media fanout is never greater than two and viewer fanout is never greater
  than one, including relay loss and reparenting;
- assignments are reproducible from depth and server join order, without a
  composite score, live optimization loop, or proactive rebalancing;
- every relay's expected outbound RTP encoder is measured through encode time,
  CPU/GPU load, and `qualityLimitationReason`; no result calls this shared or
  zero-copy forwarding;
- excluding explicit TURN paths, the application server carries no media;
- host and relay upload remain within 20% of `childCount * observedBitrate`;
- authentication and live setting changes leave every current and future child
  sender targeting the same latest room setting without altering the P2P wire;
- first picture is at most 3 seconds, a 60 fps run does not remain below 50
  decoded fps for more than 5 seconds, and depth-four p95 glass-to-glass
  latency is at most 350 ms;
- relay delta encode time per frame stays at or below 16.7 ms on the reference
  cohort and CPU limitation does not persist for more than 5 seconds;
- loss of either first-level relay that the server observes immediately first
  receives the default 5-second disconnect grace; if it does not reconnect,
  the same deterministic assignment rule produces a new decodable picture
  within the following 3 seconds (about 8 seconds total under defaults); and
- the common codec path works on the required desktop relays and mobile leaves.

The about-8-second gate covers a controlled page close that the server observes
immediately. A silent network partition depends on the default 30-second
heartbeat and can take 30 to 60 seconds to detect before the same 5-second
grace; that path is a separate, currently unverified measurement.

Fixing an ordinary implementation bug inside the bounded spike is allowed. If
meeting a gate requires Encoded Transform/DataChannel/WebCodecs media, custom
congestion control, FEC/RTX changes, multiple trees, relay scoring, transcoding,
a codec ladder, relaxed host fanout, or a browser-specific RTP injection hack,
stop. Change this ADR to Rejected and delete the experimental browser-relay
runtime path and dependencies. That result keeps standard P2P plus enabled
user-operated or central SFU fallbacks for the later automatic controller. It
does not cancel the separate planned
native shared-encode sender, and that sender cannot be used to mark an otherwise
failed browser-relay topology as passing.

Passing the gate does not change this ADR to Accepted. It permits a separate ADR
to propose a production design, including broader game-audio/A-V verification,
voluntary relay policy, and privacy disclosure. The native shared-encode sender
is the independent planned work described above, not a reward for passing this
gate.

## Consequences If The Spike Proceeds

Positive:

- The host upload and connection count become bounded without assigning normal
  viewer egress to an SFU.
- ICE, TURN, DTLS-SRTP, RTP recovery, congestion control, codec negotiation,
  jitter buffering, and browser rendering remain provided by WebRTC.
- Deterministic assignment is small enough to inspect and reproduce.

Negative:

- Every relay decodes and re-encodes, adding CPU/GPU load, latency, and
  generational quality loss.
- Every relay adds a network hop and becomes an availability dependency for its
  descendants.
- Relay upload, battery, background suspension, and peer IP exposure affect
  viewers, not just the broadcaster.
- Two one-child chains need depth four for eight viewers, so the latency target
  is uncertain by design.

## Relationship To Existing ADRs

- ADR-0001 remains the accepted production baseline. This proposal narrows its
  peer-tree rejection only enough to run an isolated experiment.
- ADR-0003/PR #12 is retained only as the rejected/superseded explicit
  whole-room SFU history. ADR-0005 and merged PR #17 own the default-off
  automatic optional-SFU fallback; this ADR does not accept that route for
  production.
- ADR-0007 owns demand-driven per-path quality representations. Its accepted
  product target does not add SVC, multiple representations, or adaptive
  switching to this bounded browser-relay experiment.
- If a later ADR accepts peer-assisted media, it must state exactly which parts
  of ADR-0001 and ADR-0005 it supersedes.

## References

Sources were checked on 2026-08-19:

- [WebRTC](https://w3c.github.io/webrtc-pc/)
- [WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [WebRTC Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)
- [libwebrtc video send stream](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)
- [libwebrtc video encoder factory](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_factory.h)
- [TeamSpeak single-encoding explanation](https://community.teamspeak.com/t/ts6-beta-community-update-insights/58116/208)
- [SplitStream, SOSP 2003](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)
