# Backend Audit Reconciliation

- Reviewed: 2026-09-06
- External evidence baseline: `1b01048e558cfa69b2c8216e658374d06037bfe4`.
- Integration baseline: `d3232cfd2929eafc94a0e3f003cd2bcdcd47089c`.
- Scope: verified lifecycle fixes and removal of the optional Host-star route.
  This is not the Go server rewrite or a new physical-media acceptance claim.

The external package contains 244 raw claims, not 244 confirmed defects.
Its handoff, source patch, and machine-readable findings remain external
evidence. This document records the independent reconciliation; the
[TODO ledger](../todo.md) alone owns remaining work.

## Accepted Corrections

- A quality candidate rejected before preparation consumes its existing
  opportunity, preventing an identical prepare/deny loop.
- Disposing a Native media bridge settles its pending start. Native relay
  callbacks bind the actual peer, including prepared children.
- A failed Native pause remains paused locally; a failed resume returns to the
  paused intent. No new pause protocol or parallel state owner is introduced.
- Prepared Native receive deadlines follow the server operation. Viewer teardown
  retires pending candidates and their recovery timers; terminal signaling
  teardown uses its existing stop owner.
- Authentication is an authoritative route snapshot, even when a replacement
  controller restarts revision numbering. Ordinary route updates retain their
  monotonic fence; session and media identities still reject stale callbacks.
- Only explicit `committed: true` publishes a newly committed connection
  identity. Stop-sharing presence is emitted after graph teardown.
- Room expiry and explicit abandonment share termination cleanup. Shutdown
  closes Vite before its shared listener and attempts every SFU drain even when
  one fails. Hosted shutdown reports failure explicitly.
- Native Receiver creation releases its unused GCC observer-map entry. Local
  startup rejects an already occupied health port; this is a duplicate-instance
  guard, not atomic socket handoff or cryptographic process identity.
- Native control keeps one reader, a bounded queue, and serial handling so socket
  close can cancel an outstanding system-picker operation. Explicit share close
  is a clean end; natural capture-process EOF still needs cause attribution.
- Gates use current loopback constants and explicit test STUN configuration.
  Packagers reject in-repository output. Deployment templates specify production
  mode and failed cutover cleanup removes its temporary links.
- Hygiene skips only GitHub's all-zero base SHA; a missing nonzero commit remains
  an error. Uncalled exports and obsolete gate aliases are removed.

## Resolved Decisions

The owner removed `PEER_ASSISTED_MEDIA`. Hosted and Local now use the same
bounded graph controller; absent LiveKit configuration still means P2P-only
service. Room privacy and topology-optimization controls remain independent.
The old environment variable must be removed before the next deployment.
There is no Host-star compatibility path to port. Removing the unused
authentication fields requires the coordinated private `screener-v21` release;
rollback to the prior server must also restore its environment configuration.

[ADR-0009](../adr/0009-optional-nat-prediction.md) distinguishes server-owned
three-attempt NAT acquisition from active Browser edge recovery. Active recovery
first restarts ICE, then rebuilds the connection if needed. Uncommitted candidates
return failure to their route operation; the unreachable extra local restart
branch was removed. Neither kind of restart guarantees a new NAT mapping.

The Client launch marker remains origin activation, not proof that the process
is alive. One failed discovery can mean contention or a permission delay, so
automatically deleting the marker would break the accepted saved-Site workflow.
Browser capture remains available in the existing picker.

## Claims Not Adopted Wholesale

- Catching every SQLite exception and continuing is not a complete recovery
  strategy: failed disconnect persistence can leave an active room indefinitely.
  Keep failure observable; design storage failure handling with its authority,
  rather than adding scattered catch-and-continue guards.
- A Local public invitation URL does not identify the transport used by a LAN
  visitor. Cookie issuance must support both HTTP LAN and HTTPS public access;
  globally dropping Secure or trusting arbitrary forwarded headers is not an
  acceptable shortcut.
- Audio capture can end silently while video continues. Ending healthy video is
  not accepted as the fix; explicit audio availability/recovery needs a coherent
  media contract. Native prepared-bridge fallback likewise needs a shared
  session-level failure owner, not a per-candidate flag that is immediately lost.
- Registering Receivers with Engine, deduplicating media ledgers, splitting page
  owners, and replacing full graph snapshots are refactor candidates, not proven
  present-day leaks or measured performance wins.
- No replacement media pipeline, custom scoring, periodic retries, TURN, IDL
  framework, compatibility readers, or new revision namespace was accepted.

## Refactor Direction

The [consolidation research](./server-consolidation.md) owns the shared Go module
layout that replaced the single TypeScript backend. Hosted and Local preserve
one graph/operation owner, with the Node runtime and superseded server packaging
removed in that same boundary.
Browser UI and native capture adapters are reuse boundaries, not rewrite targets.

Use the current behavioral tests as an oracle, not a requirement to preserve
private class structure. Extract cohesive packages without duplicating mutable
state; neither a file split nor one interface per old file is inherently an
improvement. Measure package size, startup, memory, and contract parity.

## Sources

- [WebRTC restartICE](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-restartice)
  defines ICE restart, not a promise of different network mappings.
- [coder/websocket](https://pkg.go.dev/github.com/coder/websocket)
  documents the connection read and cancellation contract.
- [Go module layout](https://go.dev/doc/modules/layout)
  supports multiple commands and shared internal packages.
