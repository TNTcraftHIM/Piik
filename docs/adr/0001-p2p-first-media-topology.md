# ADR-0001: P2P-First Media Topology

- Status: Accepted for the MVP
- Date: 2026-08-18

Current clarification, 2026-08-19: the MVP remains unchanged, but statements
below that exclude automatic topology migration do not describe the product
target. Automatic, viewer-transparent routing through direct P2P,
peer-assisted media, and an enabled SFU fallback is a standing requirement and
is governed by ADR-0005.

Historical ADR-0003's explicit whole-room SFU mode is rejected/superseded.
Proposed ADR-0004 and the default-off ADR-0005 implementation do not yet
supersede this production baseline. ADR-0005 now accepts the target direct/peer
UDP -> SFU-root UDP -> optional exceptional-edge TURN ladder. Its config/wire
migration now exists only in the repository candidate; isolated exact-room
acceptance gates must still pass before production topology changes.

## Context

The product targets one game broadcaster and a small group of trusted friends. Low glass-to-glass latency, private access, no-install browser viewing, and low server bandwidth cost matter more than large-room scalability. Public broadcasting is deliberately delegated to existing OBS/Twitch-class services. NATs, CGNAT, restrictive firewalls, variable publisher upload, and browser capture limitations prevent a direct-only design from being reliable for every user; partial room reachability is not acceptable behavior.

## Decision

Use separate control and media planes:

- A small HTTPS/WSS service owns identity, rooms, invitations, presence, and WebRTC signaling.
- A viewer can join through a numeric room code on desktop or mobile without installing the sharing client. The viewer link has no separate token or fragment; the host publication token remains internal. A deployment may place one site-wide password gate in front of both hosting and viewing; access policy remains control-plane state and does not change the media topology. ADR-0002 owns the current room-ID and lifetime policy.
- ICE attempts a direct UDP path for every current broadcaster-viewer edge, using STUN to discover candidates. A later accepted peer-assisted topology must apply the same rule independently to each assigned parent-child edge.
- For the deployed MVP, only pairs that cannot connect directly use authenticated TURN. Its current production contract requires STUN plus TURN over UDP and TCP; TURN/TLS is an optional restrictive-network enhancement. ADR-0005 owns the accepted future change to optional, controller-selected exceptional-edge TURN.
- Candidate selection is independent per pair. A room may simultaneously contain direct and relayed viewers without moving working peers onto the server.
- The deployed MVP broadcaster creates one peer connection per viewer. Rooms default to eight viewers and deployments may configure a limit from 1 through 16. Eight is an admission default, not a validated media-performance promise. A newer product target caps host media fanout at two; the current implementation does not satisfy that target above two viewers, and Proposed ADR-0004 owns the isolated experiment rather than silently changing this accepted baseline.
- An SFU is not the default whole-room path. Closed PR #12's explicit whole-room mode is superseded by merged PR #17's default-off automatic fallback. Its current code selects SFU only after peer recovery fails and remains unconfigured in production. ADR-0005 accepts SFU roots as the primary central fallback after direct/peer UDP while retaining distributed descendants; rollout remains gated.

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
- If the site-wide password is disabled, the numeric room code is the sole viewing capability and does not provide a strong privacy guarantee.
- A room-level P2P-to-SFU migration adds state, keyframe, and reconnection complexity and is not part of the first prototype. This implementation boundary does not remove the product requirement for automatic, viewer-transparent fallback.
- TURN over TCP can suffer head-of-line blocking, and its `turn:` client-to-server transport is not TLS-wrapped. The WebRTC media remains protected by DTLS-SRTP independently of that TURN transport.
- Optional TURN/TLS on port 5349 or 443 can improve compatibility but cannot guarantee success through every authenticated proxy or policy-controlled network. A normal Cloudflare HTTP proxy does not proxy TURN; using Cloudflare for TURN requires a compatible layer-4 product such as Spectrum.

## Rejected For The MVP

- Always-SFU: operationally stable but makes the server carry all viewer egress, contrary to the main cost constraint.
- Public-broadcast scaling: Twitch/OBS-class services already solve this separate workload and it would distort the private-room design.
- MCU/transcoding: unnecessary CPU/GPU work and added latency for a single screen stream.
- Peer-assisted relay tree for the MVP: adds churn handling, extra latency, trust problems, and browser re-encoding or a custom packet-forwarding protocol. Proposed ADR-0004 permits only a bounded, removable experiment; production use remains rejected until a later ADR passes measured gates.
- Custom Parsec-like transport: duplicates capture, codec, congestion-control, NAT, and security work already provided by WebRTC.

## Revisit Triggers

- More than 20% of successful viewer connections use TURN in representative telemetry.
- The publisher is CPU-limited or cannot sustain the configured aggregate upload for representative rooms.
- Product requirements exceed the measured sustainable P2P room envelope.
- Protecting peer IP addresses becomes a product requirement.
