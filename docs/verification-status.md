# Verification Status

Last updated: 2026-09-13

This file owns physical evidence limits that change how the product may be
described. [Status](./status.md) owns the execution/deployment index.
Product modules own behavior; research owns measurements; Git owns completed
implementation and obsolete package history.

## Current Evidence

Windows App and Browser are the owner's primary acceptance targets. Current
Go packages embed their Web assets and do not run a Node backend. The current
contract is Browser/server v23, Native control v9 and capture v7.

Bounded current checks cover:

- Native H264/VP8 output, compatible encoding reuse, different weak-budget
  grouping, keyframe-safe retarget and independent retirement;
- Windows live/paused/quiet-source settings, source replacement and subsequent
  sharing, including media-object continuity where required;
- Native H264 SFU video and decoded Opus through a profile change and closure;
- Browser-to-App fanout and App-exit fallback;
- concurrent Native sessions with independent media and retirement;
- complete large encoded access-unit transport and bounded queue/cache behavior;
- Linux container startup as non-root with a read-only filesystem, memory/SQLite
  restart semantics, diagnostics export, STUN and listener lifecycle; and
- public embedded-SFU H264/VP8, audio, live profile changes and closure after the
  coordinated production cutover.

The owner confirmed Windows 10 whole-display capture resolved. Chromium
WebRTC/IP-handling policy explains the verified local-media failure; it is a
Browser policy limitation, not a Vivaldi-specific transport workaround.

NAT traversal and Auto codec selection are implemented features, not unfinished
functionality. On 2026-09-09 the owner confirmed that the new NAT traversal is
useful in actual use. That field confirmation is accepted; it does not claim a
population success percentage or identify which candidate won without a trace.
Neither a statistical NAT campaign nor exhaustive Auto hardware benchmarking
is required to close this phase. Investigate further only from a new failure
or a measured improvement worth its implementation and maintenance cost.

## Candidate Evidence Boundary

The 2026-09-11 functional test acceptance used two genuine Windows App packages
and matching Server source/Web builds under the same private contract. Both App/Site version
directions delivered decoded 1080p H264 from an isolated native test window.
Replacing the Server process preserved SQLite Host authority, private code-entry
policy, Viewer grant/password authorization and App configuration. Already-open
Host/Viewer pages reauthenticated without reloading and completed subsequent
sharing. Exact measured identity belongs to the package descriptors and local
structured acceptance result; Git retains the preparation history.

This is bounded single-machine Windows evidence. The local Server executables
were built for Windows from the matching source; this run did not execute the
Linux release archives. Process replacement used a forced stop on Windows and
does not promise uninterrupted media. It does not cover game/audio endurance,
storage faults, the wider device/network matrix or Go race detection.

The first public release passed real Server/three-platform App packaging and
GitHub/Gitee publication, including anonymous mirror checksum verification.
These packaging checks do not establish physical macOS/Linux capture or expand the device/network evidence
below. [Status](./status.md) owns current publication and activation state.

## Remaining Device And Network Acceptance

The following are broader coverage and endurance tasks, not automatically new
implementation mechanisms:

- heterogeneous public-network P2P and multi-hop Browser/Native/SFU-fed relays;
- Native IPv6 direct connections across separate networks with usable IPv6;
  local dual-stack checks establish socket and candidate behavior only;
- Host/Viewer TUN/VPN combinations, migration and all-UDP-blocked bounded failure;
- two-room public SFU load, real-game audio/video synchronization and sustained
  packet loss/recovery;
- weaker Hosts at 720p30, 1080p30 and 1080p60, CPU/GPU contention, thermals,
  long-running resources and the 20-Viewer bound; and
- physical mobile autoplay, background/lock, page reclamation, rotation,
  Wi-Fi/cellular migration and relay survival.

A short 20-Viewer topology run from an earlier revision proves only its tested
invariants; it is not current-contract endurance or a public-network quality
guarantee. A direct postflight with both endpoints on one machine proves public
signaling and local media, not restricted-NAT traversal.

macOS/Linux physical capture/audio/recovery remains explicitly deferred by the
owner. Linux producer compilation and older Mac SDK/package evidence do not
prove the current Windows multi-output adaptation contract on those platforms.

## Adaptation Boundaries

The [encoder-pool research](./research/webrtc-encoder-pool.md) retains both
successful and unsuccessful observations:

- A prolonged shaped-network run recovered original output about 1.5 seconds
  after release and stayed near 30 fps; an earlier twelve-second observation
  missed recovery. The cause of that difference is not established.
- H264's stock QP adaptation can take tens of seconds to restore full size.
- Extreme single-core VP8 overload produced multi-second encode gaps that reset
  the stock CPU detector's samples. That result does not establish normal-device
  or Browser parity and does not authorize custom CPU thresholds.
- Equal effective demands can share; incompatible demands may need more encoders.
  Extra fallback outputs, buffers and recovery keyframes have real costs.
- The 360-to-187 encode-call result compares a bounded prototype with independent
  encoders. It is not an old-versus-new Native product CPU benchmark.

The earlier borrowed-child Browser experiment failed independent quality and
accounting. The independent producer in ADR-0014 now has bounded H264/VP8
direct/relay, weak-path, lifecycle and A/V evidence on the acceptance candidate;
[its research](./research/browser-local-encoding-pool.md) owns results and limits.
The owner authorized its release on 2026-09-09. Browser relay shares local outputs
among its direct children; it still re-encodes received media. Native/SFU healthy
forwarding remains encoded.

## Interpretation

Configuration/unit/loopback checks prove their named invariants. Physical results
belong to the tested revision, device and workload. Missing counters remain
unknown. A new diagnostic collector must be checked in a real exported report,
including retention and failed-collector information; logging a method call alone
does not establish useful evidence. Browser/OS suspension remains a physical
limit rather than a keepalive guarantee.
