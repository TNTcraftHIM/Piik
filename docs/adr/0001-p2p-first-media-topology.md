# ADR-0001: P2P-First Media Topology

- Status: Historical MVP baseline; superseded for current routing by ADR-0005
- Date: 2026-08-18

## Durable Rationale

Screener serves one broadcaster and a small group of trusted friends. Low
latency, private access, browser viewing, and low server media cost matter more
than public-broadcast scale. Direct WebRTC therefore remains the preferred
media path, while centralized media is fallback infrastructure rather than the
default topology.

The control and media planes are separate. HTTPS/WSS owns identity, rooms,
invitations, presence, and signaling; WebRTC owns encrypted media. STUN is
required for ordinary peer discovery. Every attempted route must end in bounded
success or a clear failure, because direct connectivity is not universal across
NAT, CGNAT, firewalls, and changing networks.

## Historical MVP Decision

The first MVP used one broadcaster-to-Viewer peer connection per Viewer and did
not implement automatic topology migration. That implementation proved the
browser-first product surface but did not establish a sustainable fanout,
fallback order, or server-resource policy.

The MVP explicitly excluded always-SFU conferencing, public-broadcast scaling,
MCU transcoding, and a custom Parsec-like transport. Those workloads either
contradict the private-room cost model or duplicate mature WebRTC capabilities.

## Current Ownership

[ADR-0005](./0005-automatic-hybrid-media-routing.md) owns current routing
invariants and assisted-route roles. Production runs exact deployed
application/runtime revision `679fe3e7af634309322bea83b316641f51ad3d09`, release
`679fe3e`; canonical `main` contains the same runtime code. Current source and
production use the strict `screener-v11` Browser wire and the same accepted route
model. Real-network validation remains open.
[ADR-0004](./0004-peer-assisted-media-experiment.md)
owns only historical peer-assisted evidence. Access and room lifetime are owned
by [ADR-0002](./0002-memory-resident-protected-rooms.md).

This historical record does not authorize a capacity, SFU/TURN order, topology,
runtime migration, or release gate.
