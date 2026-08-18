# ADR-0002: Persistent Protected Rooms

- Status: Accepted
- Date: 2026-08-18

## Context

The trusted-friends workflow benefits from short room numbers, reusable links,
and a room that remains available while its broadcaster is offline. The previous
ephemeral policy used random room codes and invalidated a room after its TTL.
Making short sequential IDs public would create a trivial enumeration surface,
while adding accounts, per-room passwords, invitations, or a general database
would exceed the current product need.

The media topology is independent of this decision. Rooms still use the
P2P-first WebRTC design in ADR-0001, with TURN only for viewer pairs that cannot
connect directly.

## Decision

Keep persistence an explicit, protected deployment option:

- `ACCESS_PASSWORD` remains the single whole-site gate. An unset or empty value
  means public mode; a non-empty value must contain 1 through 128 visible ASCII
  characters (`0x21` through `0x7e`).
- `ROOM_DATABASE_PATH` is optional and requires `ACCESS_PASSWORD`. Configuring a
  database path without the password is a startup error.
- When both values are configured, the service creates persistent protected
  rooms. SQLite allocates positive decimal room IDs with
  `INTEGER PRIMARY KEY AUTOINCREMENT`, beginning at `1`. These rooms and their
  `/r/{roomId}` links do not expire.
- Without `ROOM_DATABASE_PATH`, rooms remain temporary and use random numeric IDs
  plus `ROOM_TTL_SECONDS`. Public mode is therefore always random and temporary;
  a password-only deployment is protected but still temporary.
- An explicit `stop-sharing` or capture track ending ends only the current
  publication. The room remains joinable and viewers enter a waiting state. A
  brief host signaling disconnect does not stop healthy P2P media. A temporary
  room is removed only when its TTL expires; a persistent room is not
  automatically deleted.
- A canceled request may abandon a newly allocated room only before the host
  client claims it. SQLite `AUTOINCREMENT` ensures that an abandoned numeric ID
  is never reassigned. Normal stop and reload paths never abandon the room.
- The built-in `node:sqlite` database stores only the room ID (the table rowid)
  and SHA-256 host-token digest. It never stores the host token in plaintext, the
  site password, access cookies, participants, SDP, ICE candidates, IP addresses,
  TURN credentials, or media.
- The host browser retains the plaintext room response in same-origin
  `localStorage` so it can reclaim publication rights after a reload. Clearing
  site data or moving to another device loses that local ownership token; the
  server cannot recover it from the digest.
- Persistence remains a single-process, single-file facility. Do not add an ORM,
  Redis, an account service, or multi-node coordination without a measured need.
- The systemd example uses `StateDirectory=screener`; its protected-room database
  path is `/var/lib/screener/rooms.sqlite`.

This decision supersedes only the fixed room-code and room-lifetime details in
ADR-0001. It does not change that ADR's media topology.

## Consequences

Positive:

- A protected instance gets memorable room numbers and links that survive a
  stopped share or application restart.
- The persistent state is deliberately small and uses the Node.js runtime's
  built-in SQLite implementation, so deployment gains no additional service.
- Public deployments retain random temporary identifiers rather than exposing a
  predictable room sequence.

Negative:

- Anyone who knows the whole-site password can enumerate persistent room IDs.
  This is accepted for one trusted friend group; the password is not per-room
  authorization.
- The SQLite file becomes operational state that must have restricted
  permissions and be included in backups when room continuity matters.
- Deleting or losing the database loses room ownership mappings. A SHA-256
  digest cannot recover a lost plaintext host token.
- `MAX_ROOMS` bounds new room creation against the in-process room count.
  Persistent rooms have no automatic retention policy, so an operator must
  deliberately handle future cleanup if the small-instance assumption stops
  holding.
- If SQLite commits a new room but the HTTP response never reaches the host,
  its plaintext host token is unrecoverable and the row remains until an
  operator cleans it up. `MAX_ROOMS` bounds this failure mode; adding an
  idempotency or administration subsystem is deferred until it is observed.
- The first rollout cannot migrate rooms that existed only in process memory;
  those temporary links end with the deployment restart.
- This design does not provide horizontal scaling or failover across multiple
  application processes.
- In Node.js 24.19.0, `node:sqlite` has Stability 1.2 (release candidate), not
  stable status. It is accepted here to avoid a native addon and hand-written
  JSON transaction/recovery logic; follow its status and rerun persistence tests
  with each Node LTS update. See the
  [official Node.js SQLite documentation](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html).

## Rejected Alternatives

- Sequential IDs in public mode: easy to enumerate and unnecessary.
- Persisting every deployment automatically: changes the simple public/local
  default and creates filesystem state where none is required.
- Accounts, per-room passwords, invite tokens, or a general authorization
  database: additional concepts without a current trusted-friends requirement.
- Storing plaintext host tokens: unnecessary credential exposure.
- An external database, ORM, Redis, or distributed room allocator: operational
  complexity without a present multi-node consumer.
- Deleting a room whenever sharing stops: breaks reusable links and turns a
  temporary media action into an unrelated room-lifecycle action.

## Revisit Triggers

- Multiple application processes or regions must allocate and serve the same
  room namespace.
- Different friend groups need isolation beyond one deployment-wide password.
- Persistent room count makes deliberate archival or deletion necessary.
- Product requirements need revocable invitations, accounts, or auditable room
  ownership.
