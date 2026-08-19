# ADR-0002: Persistent Rooms And Scoped Viewer Access

- Status: Accepted; runtime candidate implemented, deployment pending
- Date: 2026-08-19

## Context

The trusted-friends workflow needs two different boundaries. Creating and
publishing a room can consume meaningful endpoint or central-media resources,
so the deployment owner must control Host admission. Watching should remain a
normal-browser, link-first action and should not reveal the deployment's Host
password to every invited friend.

The superseded runtime and current production deployment use one optional
`ACCESS_PASSWORD`, one stateless cookie,
and the same WebSocket upgrade gate for both roles. A Viewer then authenticates
with only a numeric room code. This is simple but conflates deployment admission
with room privacy: sharing the site password grants broader access than a Viewer
needs, while disabling it makes a random room code the only weak capability.
Persistent sequential IDs make that problem more visible.

Accounts, a user database, per-person ACLs, human room passwords, and a server
session table would exceed the product need. A single room-scoped bearer
capability provides the intended delegation with less user and operational
state. Media topology remains independent and is governed by ADR-0001/0005.

## Decision

Separate Host admission from Viewer authorization in one atomic release:

- Replace `ACCESS_PASSWORD` with `HOST_ADMISSION_PASSWORD`. Production startup
  requires it; local development and tests may explicitly disable it. It accepts
  16 through 128 visible ASCII bytes, must be independent from other deployment
  secrets, and issues a 12-hour stateless
  HMAC `HttpOnly`, `SameSite=Strict`, `Path=/` cookie (`Secure` and `__Host-` in
  HTTPS production). It authorizes only room creation and an attempted Host
  role. The room's independent Host token is still required to publish.
- The atomic deployment change applies nginx per-source `limit_req` at `5r/m`,
  `burst=5 nodelay` to `/api/host-admission`. It uses nginx shared memory and
  introduces no IP persistence/log field. Throttling returns generic 429;
  allowed failures use constant-time comparison and generic 401. Node gains no
  IP-keyed identity/LRU/session store; existing connection caps remain.
- Remove the old environment variable, `/api/session`, old cookie name, and old
  client gate in the same release. Supplying `ACCESS_PASSWORD` is a startup
  error. The replacement endpoint is `/api/host-admission`; `POST /api/rooms`
  accepts only its cookie, not a Bearer shortcut.
- A WebSocket upgrade cannot know the future role. `/signal` therefore admits a
  browser without a Host cookie after the existing exact Origin, empty-query,
  total-capacity, and unauthenticated-capacity checks. The server records whether
  the upgrade carried a valid Host-admission cookie. The first Host
  `authenticate` must pass both that recorded state and the room Host token. A
  Viewer ignores Host admission and is checked only against the room policy.
- Move the single wire literal from `screener-v1` to `screener-v2`. There is no
  negotiation, v1 parser, dual write, or translator. A v1 first message receives
  the universal fatal refresh outcome before room lookup and does not reconnect.

Every room has one of two Viewer policies:

- `private-link` is the default. The server creates a grant containing a
  256-bit random value and bounded expiry, stores only SHA-256 of the canonical
  full grant, and accepts it only for the Viewer role in that exact room. A
  temporary-room grant cannot outlive the room; a persistent-room grant lasts
  seven days unless rotated earlier. Expiry rejects later authentication and
  reconnects; it does not schedule a mid-session disconnect. Rotate/revoke is
  the immediate removal operation. Seven days is a configuration-free first
  release bound: reusable across short friend sessions, but not a permanent
  capability attached to a persistent sequential room.
- `public-watch` is an explicit Host choice. A room code alone can acquire only
  the Viewer role. It creates no room directory and remains bounded by existing
  per-room Viewer, global connection, unauthenticated connection, route, and
  central-egress limits. Sequential public room IDs deliberately provide no
  privacy and must be labelled accordingly.

Private invitations use `/r/{roomId}#v={grant}`. RFC 3986 separates a fragment
before dereference, and the WebSocket API rejects fragment-bearing URLs, so the
client never appends it to HTTP or `/signal`. On first load the client strictly
parses the grant into room-scoped `sessionStorage` and immediately calls
`history.replaceState` with canonical `/r/{roomId}`. Refresh and in-page
reconnect use that page session's value; an independent page without a fragment
or room key fails closed. The raw grant is never put in `localStorage`, a
cookie, query, Referrer, log, or error. Host creation and
rotation keep the returned raw grant only in memory and room-scoped
`sessionStorage` while constructing a copyable link. The persistent Host-room
object keeps the room ID, canonical URL, Host token, and room expiry, not the
Viewer grant.

The fragment and production `Referrer-Policy: no-referrer` prevent ordinary
request/referrer logging, but do not make the invitation harmless. The original
message, a browser extension, a screenshot, or deliberate forwarding can still
disclose it. The UI treats it as an access credential and provides Host
rotation/revoke.

Rotation, explicit revoke, and public-to-private changes are strong revocation
operations. The server first commits the new digest and authorization generation.
Only after a successful commit does it clear Viewer grace, connection
generations, and route state, tell Viewers to close receive PCs/media, tell every
Host/relay/SFU upstream owner to close the old-generation send edge, and close
every current Viewer socket. Closing signaling alone is insufficient because a
healthy P2P edge can keep playing without it. Rotation and public-to-private each
return one new grant. Revoke stores a fresh random locked-private digest for
which no grant was generated and returns no grant until a later rotation.
The old grant or code-only session then cannot reconnect. A persistence failure
leaves the old digest, existing sockets, and topology unchanged. Switching from
private to public only broadens future Viewer admission and does not move
healthy media.

## Persistence And Migration

`ROOM_DATABASE_PATH` remains optional and now requires
`HOST_ADMISSION_PASSWORD`. Without it, rooms use random numeric IDs and
`ROOM_TTL_SECONDS`. With it, SQLite allocates persistent decimal IDs using
`INTEGER PRIMARY KEY AUTOINCREMENT`.

Schema v2 keeps one `rooms` table and one additional field:

```text
id                       INTEGER PRIMARY KEY AUTOINCREMENT
host_token_digest        BLOB NOT NULL
  CHECK (length(host_token_digest) = 32)
viewer_grant_digest      BLOB NULL
  CHECK (viewer_grant_digest IS NULL OR length(viewer_grant_digest) = 32)
```

`NULL` means public-watch; 32 bytes mean private-link. SQLite stores no raw
password, Host token, Viewer grant, cookie, display name, participant,
`clientId`, `peerId`, IP address, SDP, ICE candidate, media, or TURN credential.
There is no user, invitation, or session table.

Schema v1 migrates inside one `BEGIN IMMEDIATE` transaction. It adds the nullable
checked `BLOB` column, assigns every existing row a fresh random 32-byte
locked-private digest for which no grant is generated, and advances
`user_version`. Existing Host
tokens still reclaim their rooms, after which the Host rotates once to obtain a
new invitation. Old code-only links fail closed. Deployment takes a v1 backup before migration; a
rollback to the old binary stops the service and restores that backup rather
than retaining dual-schema runtime code.

Display names and roster presentation remain a separate change: browser
`localStorage` plus current-room memory only, displayed with at least six
characters of room-scoped `peerId` and extended on collision. Neither enters
SQLite or participates in authorization, routing, or quality decisions.

## Consequences

- Friends can watch a private room without learning the password that grants
  room-creation and Host capability.
- One digest scopes leaked Viewer authority to one room and one role; rotation
  provides a clear recovery operation.
- Public watching remains explicit, and persistent state grows by one nullable
  digest column rather than a new subsystem.
- A capability link is a bearer credential. Anyone who obtains it can join
  before expiry and remain until disconnect or room-wide rotation/revoke;
  targeted per-person revocation is unavailable.
- Clearing the fragment sacrifices bookmark/copy-from-address-bar behavior.
  Closing the only Host tab loses its raw copy; the Host must rotate to produce
  another link, although room ownership remains recoverable from its Host token.
- Rotation/revoke deliberately disconnects all Viewers and rebuilds their routes.
- SQLite v2 is not readable by the old runtime, so rollback requires the
  pre-migration backup.
- Public-watch consumes bounded Viewer/media capacity and offers no privacy.

## Rejected Alternatives

- One password for Host and Viewer: over-grants every invited Viewer and couples
  deployment abuse control to room privacy.
- Human per-room passwords: adds input, password handling, and recovery without
  improving the link-sharing workflow over a high-entropy capability.
- Query/path grant: request targets are commonly logged; RFC 6750 likewise warns
  against bearer tokens in URI queries. A fragment plus first WS message keeps
  it out of ordinary HTTP and proxy request logs.
- Viewer cookie or `localStorage`: broadens retention and ambient authority.
  Room-scoped `sessionStorage` is enough for the required refresh/reconnect.
- Plaintext SQLite grants, per-Viewer grants, ACLs, accounts, JWTs, or a session
  table: unnecessary credential exposure/state without a current consumer.
- Letting a Host cookie satisfy private Viewer admission: collapses the two
  authorization scopes and makes room privacy depend on deployment trust.
- Keeping v1 compatibility: risks ambiguous old-tab behavior and leaves a
  second security model in product code; Git history and database backup own
  rollback.

## Acceptance Gates

- The auth matrix proves production Host admission, Viewer-without-Host-cookie,
  16-byte minimum/independent secret, ingress rate limit, exact-room/role grant
  scope, non-enumerating failures, and public-watch caps.
- Leak tests cover HTTP/WS targets, Referrer, browser storage, SQLite, application
  and proxy logs, and errors; fragment consumption immediately clears the URL.
- Rotation/revoke/public-to-private proves commit-before-disconnect, complete
  grace/route cleanup, old receive/send media teardown, one-time grant semantics,
  old reconnect rejection, locked revoke, and no change after persistence failure.
- A production-copy v1 `STRICT` database migrates transactionally to checked,
  locked-private v2; malformed non-null values fail closed, rollback restores its
  backup, and v1 tabs terminate without compatibility code.

## Implementation Status

The 2026-08-20 repository candidate implements the single-version v2 runtime,
same-row SQLite migration, private/public room policy, fragment consumption,
Host admission, and commit-first generation teardown. Focused automated tests
cover protocol bounds, exact-room grants, persistent-write failure, active
peer/SFU edge retirement, old-generation socket rejection, and v1 migration
rollback. The tracked nginx limiter and backup/restore procedure are present.
Production ingress loading, browser storage/request/log leak inspection, a
production-copy migration rehearsal, and deployment remain acceptance work.
