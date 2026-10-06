# Rooms And Access

This file owns the current room, admission, invitation, interaction, and persistence
contract. [ADR-0002](../adr/0002-memory-resident-protected-rooms.md) explains
the storage decision; implementation detail belongs in code and tests.

## Room Authority

- A room has one Host and at most 20 authenticated Viewers.
- Room codes are random free four-digit values from `1000..9999`. A code locates
  a room within its site authority; it is not globally unique, a secret or a
  permanent identity. App public-link rooms belong to that App's local authority.
- Every room has a 256-bit Host token. The server stores only its digest; the
  owning Browser keeps the raw token locally.
- Each Host tab retains its current room in session storage. The origin keeps
  one persistent resume hint and a separate preferred code; a new tab may resume
  that room only when no other tab claims it. Secure Browser origins use Web
  Locks, including protection against copied tab storage. Without Web Locks,
  fresh tabs create independent rooms and same-tab reload can retain authority,
  but duplicated-tab exclusion is not guaranteed. Closing the tab releases its
  claim; losing Host authority clears that tab without erasing another tab's
  resume hint.
- Room identity and credentials have no inactivity expiry by default. The exact
  Host token resumes the room until explicit replacement or deletion, including
  the optional empty-room policy below. Grant rotation or revocation ends an
  invitation without changing the room code.
- The Host may replace its room code. Replacement atomically creates a different
  room and invalidates the old ownership, invitations, password, sessions,
  routes, and media resources. It ends an active share and stops its capture
  tracks; it does not migrate or automatically restart capture.
- A locally remembered preferred code is only a request. The server remains the
  authority and allocates another code when that code is unavailable. The store
  remains bounded by 9,000 codes; full allocation rejects new rooms when no
  empty room may be reclaimed under the deployment's retention policy.

### Optional empty-room retention

Hosted operators may enable `ROOM_EMPTY_TIMEOUT_SECONDS`; `0` (default) preserves
indefinite authority. A positive value retires a room after that many seconds
continuously without any authenticated Host or Viewer. Never-joined rooms start
empty at creation. Sharing, pausing and idle chat do not change this rule; failed
authentication and HTTP access do not renew it. The existing heartbeat performs
expiry checks, normally every 30 seconds.

With retention enabled, allocation first reclaims expired empty rooms; if none
are available, it may retire the earliest-created empty room before the timeout,
including when replacing a room code. Early reclamation observes the existing
20-second reconnect grace after creation, restore or the last departure. Occupied rooms
are never candidates; a replacement cannot reclaim its own old room before the
replacement commits. If all rooms are occupied, creation still returns capacity
exhaustion. Expiry and pressure retirement use the same storage-first deletion
and signaling cleanup as explicit abandonment; recycled codes never retain old
credentials, share generations or reconnect timers.

The empty interval is process-local. Restored rooms receive a fresh interval so
surviving pages can reconnect; allocation pressure can still reclaim them while
empty. SQLite restores the insertion order of retained rows. This policy adds
no room lease, client renewal, wire field or persisted presence. Deletion ends
both ownership and invitations; ordinary missing-room/invalid-credential handling
applies. [Configuration](./configuration.md#room-retention) owns deployment values.
Disabling retention stops future reclamation; it cannot restore retired authority.

## Admission Paths

Three independent authorities exist:

1. **Site access.** `SITE_ACCESS_PASSWORD` is optional in every environment,
   including production. Unset or empty makes site access immediate without a
   cookie; room ownership and Viewer admission still apply. When configured,
   successful password entry creates a stateless, HttpOnly,
   `SameSite=Strict` cookie with a 24-hour rolling idle lifetime. An already
   authorized page renews it through the site-access check while it remains
   active. It authorizes room creation, Host role, and code-only Viewer
   attempts; it is not a room credential, and Viewer-grant admission cannot
   create or renew it. Cookie transport attributes follow the configured
   destination: public HTTPS retains the Secure host-prefixed cookie, while a
   separately configured HTTP LAN origin can use its HTTP cookie. Login,
   renewal, room creation and WebSocket admission use that same selection.
   Cookie signatures use a random process key independent of the password;
   restarting the Server/App requires site-password entry again. This does not
   revoke persisted room ownership or Viewer invitations. The application
   rejects framing through its own HTTP headers, including without a proxy.
   A signaling authentication failure alone does not establish site-access
   loss: its existing error also covers an incomplete or timed-out room
   handshake. The Host checks the site-access authority before entering the
   password gate; an allowed or unavailable check retains ordinary connection
   recovery. Explicit room credential rejection remains terminal.
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

The Host can omit the grant from the displayed/copied link. This page-local
choice defaults to including it and does not change admission policy, revoke
existing invitations or clear a recipient's valid authorization. The ordinary
room address retains the server-provided site and room path; it follows site
access and code-entry rules. An invite-only room has no ordinary-address entry.

Code-only admission is independent of invitations:

- `open` admits a site-authorized Viewer by room code;
- `private` without a password is invitation-only;
- `private` with a password additionally admits a site-authorized matching
  code-and-password attempt.

An unknown or deleted code returns `ROOM_NOT_FOUND`. A current room
that refuses a code-only attempt returns the generic `ROOM_ACCESS_DENIED` result
without exposing its exact policy. Invalid grants and Host ownership failures
remain separate.

Rotating or revoking the Viewer grant is a strong authorization change. The new
generation is committed before old Viewers, signaling grace, routes, and sender
edges are closed. An affected SFU Viewer's exact embedded subscription is closed
before its egress reservation is released. Room-authenticated signaling cannot
recreate a revoked subscription; no separate media token survives revocation.
Changing code-entry policy or password affects later
code-only attempts and does not silently revoke invitations.

## Room Interactions

Text and reactions reuse the authenticated room signaling connection. The server
derives sender identity from that session and accepts targeted reactions only
for participants still connected to the same room. Interaction subscriptions
inherit existing membership, replacement and revocation checks; they grant no
additional authority and do not modify media routes.

Delivery is transient and bounded. The server keeps no message history; each
page keeps only a bounded set of received messages and effects, without writing
them to storage or diagnostics. Re-admission to the same room may retain that
page's conversation, but refresh, leaving or authority loss clears it. There is
no history replay or offline outbox. HTTPS/WSS protects transport; chat is not
end-to-end encrypted, and the site operator can access live message contents.

[Presentation and lifecycle](./presentation-lifecycle.md#product-surface) owns
the distinction between a room session and its current media publication.
[Interaction research](../research/room-interactions.md) records delivery bounds,
compatibility and design rationale.

## Persistence Modes

- **Stable mode (Hosted default):** one exact-schema SQLite owner persists room
  authority across application restart. `ROOM_DATABASE_PATH` selects an absolute
  file path; absent or empty uses `rooms.sqlite` in the working directory.
- **Lightweight mode:** explicit `ROOM_DATABASE_PATH=:memory:` keeps room authority
  in process memory and all rooms disappear on restart.
- **App Local mode:** the packaged App composes the same memory RoomStore
  and ends every room when its local authority exits. Saved Site/password and
  last-confirmed mode preferences follow [App configuration](./configuration.md#piik-app-configuration);
  rooms and media state remain process-only. A blank password leaves that site open.

Persistence evidence, limits and the earlier cross-restart evaluation live in
[cross-restart recovery research](../research/cross-restart-room-recovery.md).

The App opens its own localhost Host page with the configured password, when
present, in a fragment. The page removes the fragment and uses the existing
SiteAccess endpoint; this does not create a fourth admission authority. LAN and
one-link Internet Viewers use the same room-scoped invitation grant; its
fragment never enters the public tunnel request, and the Host's Local RoomStore
remains the only authority.
Selecting a Site moves room authority wholly to that Site rather than
synchronizing two stores.

Stable mode does not persist participants, signaling sessions, sharing state,
routes, codec decisions, quality evidence, or SFU state. After restart, clients
reauthenticate and rebuild media. No restored room is considered online until
fresh sessions connect. [Status](../status.md) owns the selected deployment mode and
ADR-0002 owns storage validation.

The Host Browser may persist its creation preferences, including policy and an
optional room password. Raw Viewer grants never enter `localStorage`, cookies,
queries, server logs, or SQLite. Credentials, passwords, and invitation URLs are
never committed to the repository.
