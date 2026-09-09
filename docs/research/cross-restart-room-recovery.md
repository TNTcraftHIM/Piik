# Cross-Restart Room Recovery

- Research date: 2026-08-26; permanent-room revision reviewed 2026-09-10
- Status: SQLite authority verified; current behavior is owned by
  [rooms/access](../product/rooms-access.md)

## Current Conclusion

SQLite has one cohesive current consumer: the room authorization aggregate. It
is justified when application releases should retain not only a preferred code,
but the exact Host ownership, existing Viewer invitation, revocation high-water,
code-entry policy and password verifier. It is not a generic
store for future features.

Hosted defaults to SQLite over the same RoomStore contract. Process-only mode
remains an explicit composition; neither mode needs time-based room expiry.

## Stored Authority

| Field | Restart value |
| --- | --- |
| `roomId` | Retains the exact four-digit allocation. |
| Host-token SHA-256 | Lets a browser that still holds the raw token reclaim Host authority. |
| Viewer-grant SHA-256 | Keeps an existing invitation usable without persisting its raw grant. |
| Viewer authorization generation | Prevents rotate/revoke from rolling back across restart. |
| `open | private` | Preserves code-entry policy. |
| 48-byte scrypt material | Preserves optional password admission without plaintext. |

These values form one atomic row. Create, password/policy update, rotate/revoke,
abandon and room replacement update the row in the same
RoomStore mutation that changes memory authority.

## Deliberately Ephemeral State

SQLite does not store raw Host tokens, raw Viewer grants, room passwords, site
access credentials, participants, display names, client/peer/session IDs,
sharing generation, pause, quality settings, codec decisions, route graph,
pending operation, connection/revision, first-frame proof, SFU token/resource or
LiveKit room, SDP, ICE candidate/address, RTCStats, quality evidence, diagnostic
snapshot or log event.

Those facts describe a current process or media generation. Restoring them would
grant stale sockets or media false authority and could undercount physical sender
or SFU resources.

## Restart Behavior

After an application restart, the database restores room authorization only.
Surviving Host and Viewer pages reconnect with their existing raw credentials,
receive fresh session/peer/connection/route generations, and recommit media on a
newly decoded frame. A surviving Host capture track may therefore recover with a
bounded interruption; a page/browser restart still requires a new capture gesture.

The application continues to clear and rebuild LiveKit rooms and the process
resource ledger. SQLite does not make a LiveKit process restart seamless. True
LiveKit failover remains its separate Redis/distributed/draining architecture.

## Why Not A Signed Recovery Capsule

A signed Host capsule is smaller only when recovery may issue a new invitation.
It cannot prove that an older capsule is not replaying a Viewer grant revoked by
a newer one. Stable old invitations plus strong rotate/revoke therefore require
a durable latest-authorization-generation high-water mark. Once that durable
owner exists, keeping the code, credential digests, policy and verifier in
the same SQLite row is simpler than a client capsule, signing key and second
truth path.

## Storage And Deployment Boundary

The accepted implementation uses one embedded SQLite driver, one exact schema,
one process connection and transactional low-frequency room writes. No ORM,
event table, stats writer, compatibility reader or migration chain is added.
Unknown schema, wrong application identity, corrupt row, inaccessible file or a
second owner fails before signaling or LiveKit mutation.

Production activation is not an app-only cutover. It requires an access-restricted
writable directory, configuration backup, database backup/restore procedure and
rollback that restores matching data, environment and application together.
Old database backups can revive revoked credentials, so
restoring one later requires an explicit credential-invalidating decision.

For the permanent-room revision, an offline `DROP COLUMN` transaction on a
copy of the prior synthetic database preserved both active and formerly expired
rooms. All six remaining authority fields matched exactly; the source backup
was unchanged. The current reader accepted the converted schema without a
compatibility path. The [deployment procedure](../deployment.md#permanent-room-schema-cutover)
owns the operational steps and recovery boundary.

## Acceptance Matrix

1. Both storage modes pass identical room behavior within one process.
2. Stable restart preserves code, token/grant validation, password, policy,
   generation while restoring zero participants or media state.
3. A grant revoked before restart remains revoked afterward.
4. Presence and elapsed time do not mutate durable authority.
5. Explicit deletion/replacement releases codes; the allocation bound is unchanged.
6. Corrupt/mismatched/multiply owned state fails before accepting traffic.
7. Surviving Host/Viewer tabs reauthenticate and rebuild a fresh route; no test
   labels that bounded rebuild as uninterrupted media.

## Primary Sources

- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [`modernc.org/sqlite` driver](https://pkg.go.dev/modernc.org/sqlite)
- [SQLite transactional guarantees](https://www.sqlite.org/transactional.html)
- [SQLite locking mode](https://sqlite.org/pragma.html#pragma_locking_mode)
- [LiveKit reconnect behavior](https://docs.livekit.io/intro/basics/connect/#network-changes-and-reconnection)
- [LiveKit distributed deployment](https://docs.livekit.io/transport/self-hosting/distributed/)
