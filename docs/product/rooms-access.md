# Rooms And Access

This file owns the current room, admission, invitation, and persistence
contract. [ADR-0002](../adr/0002-memory-resident-protected-rooms.md) explains
the storage decision; implementation detail belongs in code and tests.

## Room Authority

- A room has one Host and at most 20 authenticated Viewers.
- Room codes are random free four-digit values from `1000..9999`. A code locates
  a room; it is not a secret or permanent identity.
- Every room has a 256-bit Host token. The server stores only its digest; the
  owning Browser keeps the raw token locally.
- Dormant rooms have a configurable lease, default 24 hours. An authenticated
  online Host clears the lease deadline whether or not it is currently sharing;
  Host absence starts the dormant lease. The exact Host token resumes an
  unexpired room; Viewer activity never renews it.
- The Host may replace its room code. Replacement atomically creates a different
  room and invalidates the old ownership, invitations, password, sessions,
  routes, and media resources. It ends an active share and stops its capture
  tracks; it does not migrate or automatically restart capture.
- A locally remembered preferred code is only a request. The server remains the
  authority and allocates another code when that code is unavailable or expired.

## Admission Paths

Three independent authorities exist:

1. **Site access.** Production requires an independent
   `SITE_ACCESS_PASSWORD`. Successful entry creates a 12-hour stateless,
   HttpOnly, `SameSite=Strict` cookie. It authorizes room creation, Host role,
   and code-only Viewer attempts; it is not a room credential.
2. **Host ownership.** The exact Host token authorizes that room's Host and
   access-management operations. It cannot authorize another room.
3. **Viewer invitation.** Every room creates a 128-bit, 22-character base64url
   Viewer grant. It authorizes only the Viewer role for that exact room
   incarnation and bypasses site access and code-entry policy.

The invitation grant is carried in the URL fragment, removed from the address
bar on first read, and retained only in room-scoped `sessionStorage`. Refreshing
the same tab preserves it. It is not intentionally persisted across independent
tabs or Browser sessions; tab duplication and opener initialization remain
Browser behavior. The grant has no independent TTL and ends with the room or
when the Host rotates or revokes it.

Code-only admission is independent of invitations:

- `open` admits a site-authorized Viewer by room code;
- `private` without a password is invitation-only;
- `private` with a password additionally admits a site-authorized matching
  code-and-password attempt.

An unknown, reclaimed, or expired code returns `ROOM_NOT_FOUND`. A current room
that refuses a code-only attempt returns the generic `ROOM_ACCESS_DENIED` result
without exposing its exact policy. Invalid grants and Host ownership failures
remain separate.

Rotating or revoking the Viewer grant is a strong authorization change. The new
generation is committed before old Viewers, signaling grace, routes, and sender
edges are closed. Changing code-entry policy or password affects later
code-only attempts and does not silently revoke invitations.

## Persistence Modes

- **Lightweight mode:** without `ROOM_DATABASE_PATH`, room authority is process
  memory and all rooms disappear on restart.
- **Stable mode:** with an explicit SQLite path, one exact-schema owner persists
  room authority across application restart.

Stable mode does not persist participants, signaling sessions, sharing state,
routes, codec decisions, quality evidence, or SFU state. After restart, clients
reauthenticate and rebuild media; a room that was active becomes dormant with a
fresh lease. [Status](../status.md) owns the selected deployment mode and
ADR-0002 owns storage validation.

The Host Browser may persist its creation preferences, including policy and an
optional room password. Raw Viewer grants never enter `localStorage`, cookies,
queries, server logs, or SQLite. Credentials, passwords, and invitation URLs are
never committed to the repository.
