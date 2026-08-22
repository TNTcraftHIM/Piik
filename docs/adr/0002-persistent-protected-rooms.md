# ADR-0002: Persistent Rooms And Scoped Viewer Access

- Status: Accepted; access boundary deployed, local privacy gate source-only
- Date: 2026-08-19

## Context

The trusted-friends workflow uses a site-access boundary and a room-access
boundary. Creating or publishing and navigating by room code require site
access. A room-scoped fragment grant remains the link-first path and does not
require sharing the site password with invited friends.

The superseded runtime used one optional `ACCESS_PASSWORD`, one stateless cookie,
and the same WebSocket upgrade gate for both roles. The deployed replacement now
separates site access from default private fragment grants and explicit
public-watch. The accepted source-only extension adds optional room-password
entry without reopening the old site-wide Viewer gate. Persistent sequential IDs
make a room-scoped boundary especially important.

Accounts, a user database, per-person ACLs, password recovery, and a server
session table would exceed the product need. A room-scoped bearer capability
remains the lowest-friction invitation, while an optional low-policy room
password lets a trusted friend enter from a numeric room code without weakening
site access. Media topology remains independent and is governed by
ADR-0001/0005.

## Decision

Keep site access and room authorization as two ordered checks:

- Replace `ACCESS_PASSWORD` with `SITE_ACCESS_PASSWORD`. Production startup
  requires it; local development and tests may explicitly disable it. It accepts
  8 through 128 visible ASCII bytes, must be independent from other deployment
  secrets, and issues a 12-hour stateless
  HMAC `HttpOnly`, `SameSite=Strict`, `Path=/` cookie (`Secure` and `__Host-` in
  HTTPS production). It authorizes room creation and an attempted Host role,
  and permits code-only Viewer attempts. The room's independent Host token is
  still required to publish.
- The atomic deployment change applies nginx per-source `limit_req` at `5r/m`,
  `burst=5 nodelay` to `/api/site-access`. It uses nginx shared memory and
  introduces no IP persistence/log field. Throttling returns generic 429;
  allowed failures use constant-time comparison and generic 401. Node gains no
  IP-keyed identity/LRU/session store; existing connection caps remain.
- Remove the old environment variable, `/api/session`, old cookie name, and old
  client gate in the same release. Supplying `ACCESS_PASSWORD` is a startup
  error. The replacement endpoint is `/api/site-access`; `POST /api/rooms`
  accepts only its cookie, not a Bearer shortcut.
- A WebSocket upgrade cannot know the future role. `/signal` therefore admits a
  browser without a site-access cookie after the existing exact Origin, empty-query,
  total-capacity, and unauthenticated-capacity checks. The server records whether
  the upgrade carried a valid site-access cookie. The first Host
  `authenticate` must pass both that recorded state and the room Host token. A
  Viewer may bypass site access only with a valid, unexpired grant for that
  exact room; otherwise site access is required before any room lookup policy
  or password verification can authorize it.
- At this ADR's release boundary, move the single wire literal from
  `screener-v1` to `screener-v2`. That migration had no negotiation, v1 parser,
  dual write, or translator. A v1 first message received the universal fatal
  refresh outcome before room lookup and did not reconnect. Later atomic
  migrations advanced the current wire to `screener-v5`.

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
- `public-watch` is an explicit Host choice. Site access plus a room code can
  acquire only the Viewer role. It creates no room directory and remains bounded by existing
  per-room Viewer, global connection, unauthenticated connection, route, and
  central-egress limits. Sequential public room IDs deliberately provide no
  privacy and must be labelled accordingly.

A private room may also have one optional Viewer password. An existing valid
fragment grant still enters directly. A code-only Viewer passes neutral site
access before seeing the neutral room-password form and, on success,
authenticates only that current Viewer session in that room. The Host can set,
replace, or remove it. The input accepts 1 through 64
visible ASCII characters without composition rules; this is a convenience
boundary for trusted friends, not an account credential or recovery system.

Plaintext room passwords exist only transiently in the current page state,
WebSocket authentication message, and KDF call memory. They never enter a URL,
cookie, browser persistent storage, log, error, or SQLite. The server uses Node's
asynchronous scrypt with fixed `N=16384,r=8,p=1`, a random 16-byte salt, a
32-byte verifier, two active KDF slots, and at most 16 waiters. A full queue fails
boundedly; a waiter rechecks its Viewer socket or Host session before starting
KDF and skips stale work. A target-machine benchmark
may tune those parameters after the feature is deployed; it does not block the
functional default. Unknown rooms, absent/wrong passwords, and a full room after
a correct password share generic rejection. Completion rechecks current room
material and socket/Host session so stale asynchronous work cannot authorize or
commit.

At this ADR's implementation checkpoint, the wire remained `screener-v2`.
Current source and production have since migrated atomically to `screener-v5`;
the paragraph below records the v2 compatibility boundary rather than the
current wire. Only a Web Host that advertises
`viewerPasswordSettings: true` may set/remove the password and receive
`viewer-password-updated`; Native v2 does not advertise the capability and sees
no new message type. Viewer `authenticate` may carry the current password
attempt. The generic `authenticated` message does not gain a password field.

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
The old grant or code-only session then cannot reconnect; a separately configured
room password remains an available future entry after current Viewers are
disconnected. A persistence failure
leaves the old digest, existing sockets, and topology unchanged. Switching from
private to public only broadens future Viewer admission and does not move
healthy media.

## Persistence And Migration

`ROOM_DATABASE_PATH` remains optional and now requires
`SITE_ACCESS_PASSWORD`. Without it, rooms use random numeric IDs and
`ROOM_TTL_SECONDS`. With it, SQLite allocates persistent decimal IDs using
`INTEGER PRIMARY KEY AUTOINCREMENT`.

Schema v3 keeps one `rooms` table and adds one nullable password-material field
to the deployed v2 shape:

```text
id                       INTEGER PRIMARY KEY AUTOINCREMENT
host_token_digest        BLOB NOT NULL
  CHECK (length(host_token_digest) = 32)
viewer_grant_digest      BLOB NULL
  CHECK (viewer_grant_digest IS NULL OR length(viewer_grant_digest) = 32)
viewer_password_material BLOB NULL
  CHECK (viewer_password_material IS NULL OR length(viewer_password_material) = 48)
```

For the grant, `NULL` means public-watch and 32 bytes mean private-link. Password
material is either `NULL` or one 48-byte BLOB containing a 16-byte salt followed
by a 32-byte scrypt verifier, so salt/verifier cannot be half-written. SQLite
stores no raw site-access or room password, Host token, Viewer grant, cookie,
display name, participant,
`clientId`, `peerId`, IP address, SDP, ICE candidate, media, or TURN credential.
There is no user, invitation, or session table.

Schema v1 or v2 migrates to v3 inside one `BEGIN IMMEDIATE` transaction. V1 first
adds the nullable checked grant `BLOB` and assigns every existing row a fresh
random 32-byte locked-private digest for which no grant is generated. Both v1
and v2 then add the checked nullable password-material column, default it to
`NULL`, and advance `user_version`. Existing Host
tokens still reclaim their rooms, after which the Host rotates once to obtain a
new invitation. Old code-only links fail closed. Deployment takes a v1 backup before migration; a
rollback to the old binary stops the service and restores that backup rather
than retaining dual-schema runtime code.

Display names and roster presentation remain a separate change: browser
`localStorage` plus current-room memory only. A unique display name is shown
without an identifier; duplicate names append the shortest room-scoped
`peerId` suffix (at least six characters, extended only when needed). Neither
the name nor suffix enters SQLite or participates in authorization, routing, or
quality decisions.

## Consequences

- Friends can watch a private room without learning the password that grants
  room-creation and Host capability.
- One digest scopes leaked Viewer authority to one room and one role; rotation
  provides a clear recovery operation.
- Public watching remains explicit. Optional password entry adds one nullable
  fixed-size material column, not an account or authentication subsystem.
- A capability link is a bearer credential. Anyone who obtains it can join
  before expiry and remain until disconnect or room-wide rotation/revoke;
  targeted per-person revocation is unavailable.
- Clearing the fragment sacrifices bookmark/copy-from-address-bar behavior.
  Closing the only Host tab loses its raw copy; the Host must rotate to produce
  another link, although room ownership remains recoverable from its Host token.
- Rotation/revoke deliberately disconnects all Viewers and rebuilds their routes.
- SQLite v3 is not readable by the old runtime, so rollback requires the
  pre-migration backup.
- Public-watch consumes bounded Viewer/media capacity and offers no privacy.

## Rejected Alternatives

- One password for Host and Viewer: over-grants every invited Viewer and couples
  deployment abuse control to room privacy.
- A room password as the only private mechanism: loses the direct fragment-grant
  workflow and encourages password reuse. The password is an optional parallel
  Viewer entry, while the grant remains the default invitation.
- Query/path grant: request targets are commonly logged; RFC 6750 likewise warns
  against bearer tokens in URI queries. A fragment plus first WS message keeps
  it out of ordinary HTTP and proxy request logs.
- Viewer cookie or `localStorage`: broadens retention and ambient authority.
  Room-scoped `sessionStorage` is enough for the required refresh/reconnect.
- Plaintext SQLite grants, per-Viewer grants, ACLs, accounts, JWTs, or a session
  table: unnecessary credential exposure/state without a current consumer.
- Letting a site-access cookie satisfy private Viewer admission: collapses the
  two authorization scopes. It permits the room attempt but never replaces a
  private room grant or password.
- Keeping v1 compatibility: risks ambiguous old-tab behavior and leaves a
  second security model in product code; Git history and database backup own
  rollback.

## Acceptance Gates

- The auth matrix proves production site access, grant-without-site-cookie,
  8-byte minimum/independent secret, ingress rate limit, exact-room/role grant
  scope, correct/wrong/replaced/removed room passwords, non-enumerating failures,
  public code-only rejection before site access, public entry after site access,
  and v2 Native wire isolation.
- Leak tests cover HTTP/WS targets, Referrer, browser storage, SQLite, application
  and proxy logs, and errors; fragment consumption immediately clears the URL.
- Rotation/revoke/public-to-private proves commit-before-disconnect, complete
  grace/route cleanup, old receive/send media teardown, one-time grant semantics,
  old reconnect rejection, locked revoke, and no change after persistence failure.
- Production-copy v1/v2 `STRICT` databases migrate transactionally to checked v3
  with locked-private v1 grants and nullable single-BLOB password material;
  malformed non-null values fail closed and rollback restores the backup.

## Implementation Status

The deployed boundary implements the single-version v2 runtime, ordered site
access for code-only Viewers, private/public room policy, fragment consumption,
room passwords, and commit-first grant teardown on SQLite v3.

The source-only `npm run gate:access-privacy` gate builds the current Web client,
uses an ephemeral real-Chrome context against a loopback persistent room, and
reports only fixed booleans and counts. It proves that the fragment is consumed
through `replaceState` before `DOMContentLoaded`, the grant appears only under
that room's `sessionStorage` key, and the run's site password plus grant do not
appear in observed request/referrer records, the tracked nginx combined-log
model, or captured application diagnostics. None of those values or the room
password appears raw in temporary SQLite files. The room password enters at the
RoomStore boundary, so this gate makes no claim about its browser/WebSocket/log
ingress. It also runs the complete signaling test file containing the strong
rotate/revoke media-edge teardown case.

This local headless gate neither reads production credentials nor inspects a
production request log, nginx log, service journal, database, or headful browser.
Those exact-environment checks and a production rotation/revoke remain separate
acceptance work.
