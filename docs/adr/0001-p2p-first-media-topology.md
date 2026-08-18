# ADR-0001: P2P-First Media Topology

- Status: Accepted for the MVP
- Date: 2026-08-18

## Context

The product targets one game broadcaster and a small group of trusted friends. Low glass-to-glass latency, private access, no-install browser viewing, and low server bandwidth cost matter more than large-room scalability. Public broadcasting is deliberately delegated to existing OBS/Twitch-class services. NATs, CGNAT, restrictive firewalls, variable publisher upload, and browser capture limitations prevent a direct-only design from being reliable for every user; partial room reachability is not acceptable behavior.

## Decision

Use separate control and media planes:

- A small HTTPS/WSS service owns identity, rooms, invitations, presence, and WebRTC signaling.
- A viewer can join through an authenticated, expiring Web link on desktop or mobile without installing the sharing client.
- ICE attempts a direct UDP path for every broadcaster-viewer pair, using STUN to discover candidates.
- Only pairs that cannot connect directly use authenticated TURN. Production requires STUN plus TURN over UDP and TCP; TURN/TLS is an optional restrictive-network enhancement, using its standard TCP port 5349 by default. Port 443 is optional and requires a dedicated public IP or a validated layer-4/SNI route when HTTPS already owns that address and port.
- Candidate selection is independent per pair. A room may simultaneously contain direct and relayed viewers without moving working peers onto the server.
- The broadcaster creates one peer connection per viewer. The PoC hard limit is three viewers; a later release may reconsider it only after publisher upload and encoder measurements.
- No SFU is planned for the normal product envelope. It is only a future reconsideration point if the small-room scope changes or measured relay/upload/encoder pressure makes the chosen envelope unworkable.

## Consequences

Positive:

- Direct sessions consume almost no server media bandwidth and normally take the shortest network path.
- TURN cost is paid only for failed direct pairs.
- The initial product can be built with standard browser WebRTC and a small backend.
- Friends can watch from a phone or unmanaged desktop through a link instead of installing a TeamSpeak-like full client.

Negative:

- Broadcaster upload scales approximately as `viewer_count * stream_bitrate`.
- Browser APIs do not guarantee that several peer connections share a single hardware encode.
- Direct peers learn one another's network addresses; this is acceptable only for the initial trusted-friends threat model.
- A room-level P2P-to-SFU migration adds state, keyframe, and reconnection complexity and is not part of the first prototype.
- TURN over TCP can suffer head-of-line blocking, and its `turn:` client-to-server transport is not TLS-wrapped. The WebRTC media remains protected by DTLS-SRTP independently of that TURN transport.
- Optional TURN/TLS on port 5349 or 443 can improve compatibility but cannot guarantee success through every authenticated proxy or policy-controlled network. A normal Cloudflare HTTP proxy does not proxy TURN; using Cloudflare for TURN requires a compatible layer-4 product such as Spectrum.

## Rejected For The MVP

- Always-SFU: operationally stable but makes the server carry all viewer egress, contrary to the main cost constraint.
- Public-broadcast scaling: Twitch/OBS-class services already solve this separate workload and it would distort the private-room design.
- MCU/transcoding: unnecessary CPU/GPU work and added latency for a single screen stream.
- Peer-assisted relay tree: adds churn handling, extra latency, trust problems, and browser re-encoding or a custom packet-forwarding protocol.
- Custom Parsec-like transport: duplicates capture, codec, congestion-control, NAT, and security work already provided by WebRTC.

## Revisit Triggers

- More than 20% of successful viewer connections use TURN in representative telemetry.
- The publisher is CPU-limited or cannot sustain the requested aggregate upload for three viewers.
- Product requirements raise the normal room size above four viewers.
- Protecting peer IP addresses becomes a product requirement.
