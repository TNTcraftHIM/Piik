# ADR-0004: Peer-Assisted Media Experiment

- Status: Historical experiment
- Date: 2026-08-19
- Last updated: 2026-08-22

## Context

ADR-0001 accepted browser WebRTC P2P for the MVP. Multi-viewer measurements then
showed that sending one Host connection per Viewer does not fit the product's
small, bounded upload target. The repository therefore explored whether an
ordinary browser Viewer could relay the received screen stream to another
Viewer.

This ADR records that experiment and its reusable evidence. It does not set the
current endpoint capacity, SFU topology, TURN placement, fallback sequence, or
resource accounting. ADR-0005 owns current routing invariants.

## Experiment

The signaling server assigned a deterministic, bounded directed acyclic graph.
Each Viewer had at most one active upstream. Join, capacity release, endpoint
departure, and current-edge failure were the only reassignment triggers;
healthy unaffected branches remained sticky. The experiment intentionally
excluded continuous route scoring, periodic rebalance, multiple simultaneous
upstreams, and user-selected topology.

Each browser relay rendered the received `MediaStream` and added its remote
tracks to a separate downstream `RTCPeerConnection`. This is standard WebRTC,
not packet forwarding or encoded-frame reuse. The browser decodes and normally
re-encodes at each relay hop, and each downstream connection owns separate
packetization, pacing, congestion control, encryption, and upload traffic.

The experiment shared one strictly validated room quality object across current
and future senders. Values were bounded to the existing resolution, frame-rate,
bitrate, degradation-preference, codec, and screen-audio choices. Sender
mutation was serialized and read back from the browser. Requested settings were
treated as ceilings and preferences, never as proof of achieved media quality.

Ordinary peer connections remained STUN-only. A TURN candidate would alter the
transport of an authorized edge, not the graph semantics or downstream edge
count.

## Evidence retained

The experiment established these durable facts:

- standard browser track relay incurs a separate downstream sender and cannot
  be described as zero-copy or shared encode;
- an upstream receive edge is distinct from downstream upload work;
- endpoint capacity must be enforced by the server and revalidated during
  reconnect, replacement, and stale-signal handling;
- one active Viewer upstream plus an acyclic committed graph is a tractable
  safety invariant;
- route replacement must be bound to exact sessions, revision, share
  generation, assignment generation, and connection identity;
- ICE `connected` is not media proof; positive RTP, decoded-frame progress, and
  a live current-generation track are required before switching; and
- loopback tests can prove graph and signaling invariants but cannot establish
  real-device encoding cost, target-network latency, or production capacity.

Historical capacity-two and capacity-three runs remain measurement evidence.
They do not authorize a current release tier or a browser-specific policy.

## Experiment gates

A browser relay path is viable only if representative real-device tests record:

- end-to-end and per-hop latency;
- capture, encode, decode, and render frame rates;
- CPU, GPU, encoder count, and `qualityLimitationReason`;
- endpoint upload, packet loss, retransmission, and recovery;
- topology depth and the failure radius of a relay departure;
- audio continuity and synchronization when screen audio exists; and
- deterministic bounded recovery without stale edges or unauthorized signals.

The path fails closed if it requires a custom RTP injection layer, a new
congestion controller, hidden software encoding, unbounded fanout, or a quality
claim unsupported by measurements.

## Current interpretation

Peer relay remains a useful distributed-media candidate and deployed source
contains portions of the experiment. Those portions must be evaluated against
ADR-0005's current invariants rather than carried forward wholesale.

The current accepted endpoint rule is one server-authoritative downstream
capacity for every non-server endpoint, default `2` and statically configurable
as `1`, `2`, or `3`; upstream receive is free and role or user agent does not
create an exception. The separate SFU/TURN publication, subscription, transport,
server-resource, and migration-overlap model is still pending.

## Consequences

Positive:

- the browser path can extend a distributed graph using standard WebRTC;
- exact route generations and media-proven switching are reusable controller
  invariants; and
- the experiment supplies concrete resource and failure measurements.

Negative:

- every browser relay hop may add decode, encode, latency, and upload cost;
- browser APIs do not guarantee cross-`RTCPeerConnection` shared encoding; and
- experimental capacity results cannot substitute for current policy or a real
  browser and network matrix.

## Relationship to other ADRs

- ADR-0001 remains the direct browser P2P baseline.
- ADR-0005 owns current automatic routing and capacity invariants.
- ADR-0007 owns path-quality evidence and representation behavior.
- A future native shared-encode sender or relay requires its own decision and
  evidence; this experiment does not pre-approve it.

## References

Sources were checked on 2026-08-19:

- [WebRTC](https://w3c.github.io/webrtc-pc/)
- [WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/)
- [WebCodecs](https://www.w3.org/TR/webcodecs/)
- [WebRTC Data Channels, RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)
- [libwebrtc video send stream](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_send_stream_impl.cc)
- [libwebrtc video encoder factory](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_factory.h)
- [SplitStream, SOSP 2003](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)
