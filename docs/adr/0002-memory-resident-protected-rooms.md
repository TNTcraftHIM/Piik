# ADR-0002: Optional Durable Room Authority And Scoped Viewer Access

- Status: Accepted; implementation pending
- Date: 2026-08-26

## Context

Screener serves one Host and at most 20 trusted Viewers. The application server
owns a small room and authorization aggregate while WebRTC and LiveKit own live
media sessions. Frequent application releases should not force the Host to
create another room or redistribute invitations, but a database must not become
a second owner for transient signaling, routes, media, or diagnostics.

The same product therefore needs two deployment choices over one room model:

- lightweight mode keeps no server-side room data after process exit;
- stable mode keeps only room authority in one local SQLite file so surviving
  pages can reauthenticate and rebuild fresh media after an application restart.

## Decision

### One Room Authority Model

Every room owns:

- one random free code from `1000` through `9999`;
- a SHA-256 Host-token digest and Viewer-grant digest;
- a monotonically increasing Viewer authorization generation;
- `open | private` code entry and optional salted scrypt password material;
- one absolute dormant lease deadline, or an active-Host marker.

`ROOM_LEASE_SECONDS` defaults to 86,400 seconds. An authenticated Host keeps the
room active; stop or disconnect starts the dormant lease. The exact Host token
may resume before expiry. Viewer activity never renews the room. Expiry or
explicit replacement invalidates every credential and releases the code.

### Lightweight And Stable Storage

`ROOM_DATABASE_PATH` is optional and absent by default:

- when absent, the bounded RoomStore is process memory and restart loses every
  room and credential;
- when present, the same RoomStore persists its authority aggregate in one
  SQLite file. The production target enables this stable mode after its
  persistent-state deployment and recovery checks pass.

Stable mode stores only `roomId`, Host-token digest, Viewer-grant digest,
authorization generation, code-entry policy, optional password verifier, and
dormant lease deadline. It never stores raw tokens, grants, or passwords.

The schema is one exact current version using built-in `node:sqlite`, one
connection, one writer, and transactional room mutations. An unknown schema,
wrong application identity, corrupt row, inaccessible path, or second owner
fails startup before signaling or LiveKit mutation. This private pre-release
contract has no legacy reader or migration chain; an incompatible database must
be explicitly replaced from a verified recovery boundary.

On restart, expired rows are deleted. A saved dormant deadline remains exact. A
row last observed with an active Host becomes dormant until
`startup time + ROOM_LEASE_SECONDS`; restart never claims that the old Host,
socket, share, or media route is still online. Successful Host reauthentication
marks it active again.

Participants, display names, client/peer/session IDs, share generation, pause,
quality settings, codec decisions, route graph, pending operations, first-frame
proof, SFU tokens/resources/rooms, RTCStats, diagnostics, and logs remain
process-only. Every restart creates fresh session and route authority and media
must reconnect and recommit on a newly decoded frame. SQLite does not make a
LiveKit restart seamless or remove the browser gesture required after capture
itself ends.

### Host Ownership And Preferred Code

The Host browser keeps the raw Host token and creation profile in same-origin
local storage. The server keeps only the token digest. Clearing browser data or
changing device loses ownership; IP, UA, hardware and browser fingerprints are
never identity.

The browser also remembers one non-secret preferred room code with no local
expiry or renewal timer. It is only a future allocation hint. The server remains
the sole owner of room existence, expiry and code allocation: it reuses the hint
only when free, otherwise allocates another random free code and the browser
replaces its preference.

### Explicit Room Replacement

The Host room-code control includes a refresh action immediately before Copy.
With the exact Host token, one server operation allocates a guaranteed different
free code and retires the old room through the normal delete lifecycle. Failure
before commit leaves the old room unchanged. Success invalidates the old Host
token, Viewer grant, password, authorization generation, sessions, routes and
SFU resources, ends any active share, returns fresh room credentials, and updates
the local preferred code. No old room or media state is migrated.

### Viewer Access

Each room has one 128-bit, 22-character base64url Viewer grant independent of
code entry. A valid grant authorizes only the Viewer role for that exact current
room. The browser consumes it into room-scoped session storage and removes the
URL fragment. Stable mode preserves only its digest so an existing invitation
continues across application restart; rotation or revocation atomically updates
the digest and authorization generation.

`open` admits site-authorized code entry without a room password. `private`
disables passwordless code entry; without a password it is invitation-only, and
with a password it additionally admits a matching code-and-password attempt.
Missing or expired codes return `ROOM_NOT_FOUND`; expected existing-room denial
returns `ROOM_ACCESS_DENIED`.

## Consequences

- Lightweight mode remains the smallest complete server and leaves no durable
  room authority after process exit.
- Stable mode preserves room code, Host ownership, invitations, revocation,
  password policy and lease across application releases without persisting live
  topology or media state.
- Application restart in stable mode is a bounded reauthentication and media
  rebuild, not uninterrupted playback. LiveKit high availability remains a
  separate infrastructure decision.
- Production activation changes persistent state and therefore requires a
  verified writable directory, configuration backup, database backup/restore
  boundary and rollback procedure; it is not an ordinary app-only cutover.

## Acceptance Gates

- Both modes pass the same creation, ownership, admission, password,
  rotate/revoke, expiry, replacement and 9,000-code-capacity behavior.
- Stable restart preserves exact room authority and dormant deadlines, converts
  crash-active rooms to one configured dormant lease, and restores no participant
  or media authority.
- A surviving Host and Viewer can reauthenticate after restart, receive fresh
  sessions/routes, and recommit media; an old revoked grant stays revoked.
- Replacement never returns the old code, never partially retires the old room,
  and invalidates all old access before the new credentials are exposed.
- Raw credentials and private media/network identifiers never enter SQLite or
  logs. Corrupt, mismatched or multiply owned databases fail before service
  readiness.

## Decision Sources

- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [SQLite transactional guarantees](https://www.sqlite.org/transactional.html)
- [SQLite locking mode](https://sqlite.org/pragma.html#pragma_locking_mode)
- [LiveKit reconnect behavior](https://docs.livekit.io/intro/basics/connect/#network-changes-and-reconnection)
