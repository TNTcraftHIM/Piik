# ADR-0002: Memory-Resident Rooms And Scoped Viewer Access

- Status: Accepted and deployed on strict v12
- Date: 2026-08-23

## Context

Screener serves one Host and at most 20 trusted Viewers. The media plane stays
distributed and P2P-first, while the application server owns the small room,
authorization, signaling, and route-control state. An application restart already
ends every active media session. Removing durable room storage additionally loses
the current code, invitation, and dormant lease, while same-browser creation
preferences can still be replayed locally. For this private, bounded product that
is a small and accepted recovery cost.

SQLite would preserve those identifiers across restart, but it also keeps a
schema, migrations, path and writable-directory configuration, backup/restore
operations, persistence tests, and cross-restart state semantics. That ongoing
surface is not justified by the limited recovery benefit and works against the
small, ephemeral control plane. The product therefore accepts restart-wide room
loss and does not include cross-restart room recovery in its current contract.

The room experience needs a memorable code, a direct invitation, optional
code-entry protection, and short-term reuse by the same browser. It does not need
accounts, browser fingerprinting, a user database, permanent room ownership,
schema migration, or high-availability coordination.

## Decision

### One Memory-Resident Room Model

All room state lives in the authoritative application process:

- a random four-digit room code from `1000` through `9999`;
- the room lease and current Host/Viewer membership;
- SHA-256 digests of the Host token and current Viewer grant;
- the current code-entry policy and, when enabled, a salted room-password
  verifier;
- authorization generations and the existing signaling/route state.

The free-code pool contains every currently unallocated four-digit code. A room
creation request may name one locally preferred code: the store takes it only if
it is still in the free pool, otherwise it selects uniformly from the current
pool. Room release returns the code to that pool. The complete `1000..9999`
space fixes active room capacity at 9,000; there is no separate room-limit
configuration. A room code is a locator and best-effort preference, not a
secret, reservation, or permanent identity.

`ROOM_LEASE_SECONDS` is the single room-lifetime setting and defaults to 86,400
seconds. An authenticated, actively sharing Host prevents expiry. When sharing
stops or the Host is no longer connected, the room remains dormant until the
lease deadline. The same Host token may resume sharing before that deadline and
renew the lease. Viewer presence never renews ownership. Expiry closes the room,
invalidates its credentials, and releases its code.

Process restart deliberately clears every room, lease, credential digest,
password verifier, and participant. Old Host records and invitations then fail
closed, and the next Host share creates a new room incarnation. There is no room database,
`ROOM_DATABASE_PATH`, persistent-room mode, schema migration, or compatibility
reader. The site-access secret remains deployment configuration rather than room
state.

### Ownership And Local Host Defaults

Room ownership uses the existing random Host bearer token, not an IP address,
user agent, hardware property, or browser fingerprint. The Host browser keeps the
raw token in same-origin `localStorage`; the server keeps only its digest in the
current room. Clearing local data or changing browser/device loses ownership.

The Host browser also keeps one local creation profile containing its display
name, code-entry policy, and optional room password, plus an independent
non-secret preferred room code with a deadline equal to that room's configured
lease duration (24 hours by default). Host sharing renews it every half lease;
normal stop renews it once more. When old ownership no longer works, the next explicit
share requests the still-current preferred code and atomically reapplies the
creation profile. A free code may therefore be reused, but the result always has
a new Host token, Viewer grant, password material, lease, and room incarnation;
an occupied or expired preference falls back to random allocation. The site-access
password is never part of this profile. A Host room password may be stored locally
as a convenience for this private product; the server receives it only over the
authenticated creation or update path, derives the verifier, and never stores or
logs the plaintext.

### Orthogonal Viewer Access

Every room has one room-scoped Viewer grant independent of code entry. The grant
is 16 cryptographically random bytes encoded as 22 base64url characters; its
SHA-256 digest is stored directly on that exact in-memory room incarnation. It
has no separate expiry clock or embedded room metadata. It remains usable only
while that room exists, and therefore ends on room reclamation or process
restart as well as explicit rotation or revocation. Reusing the same four-digit
code creates a new digest and never revives an old invitation.

The primary share action copies `/r/{code}#v={grant}`. A valid grant directly
authorizes only the Viewer role in that room. The browser consumes it into
room-scoped `sessionStorage`, immediately clears the fragment with
`history.replaceState`, and never places it in a cookie, query, log, error, or
`localStorage`.

Code entry is a separate two-state policy:

- `open` is the default: after site access, the four-digit code admits a Viewer
  without a room password;
- `private` disables passwordless code entry. Without a room password the room
  is invitation-only; with one configured, matching code-and-password entry is
  also admitted.

There is no third code-entry-disabled state; invitation access remains owned by
the independent Viewer grant.

The Host may rotate or revoke the grant without changing code-entry policy, and
may change code-entry policy without changing a healthy media route. Strong
grant revocation advances the authorization generation, clears Viewer grace and
route state, closes the old receive and send edges, and disconnects the affected
Viewers before they can reconnect with the old grant.

`SITE_ACCESS_PASSWORD` continues to protect room creation, Host admission, and
all code-only Viewer attempts. A valid room grant may bypass that site gate only
for the exact Viewer role and room. Neither a code, room password, nor Viewer
grant can create a room or become Host authority.

After site access, a well-formed code-only attempt for an unallocated, reclaimed,
or expired room returns `ROOM_NOT_FOUND`; the Viewer shows "房间不存在或已过期"
and does not offer a room-password input. Other expected code-only admission
failures retain `ROOM_ACCESS_DENIED` and the existing optional password retry.
This intentionally reveals only that no current room owns the submitted code;
it does not expose the policy or password state of an existing room. The UI does
not request, discover, or mint an invitation through the server.

Exact-room grant failures remain `INVALID_TOKEN`, Host authentication retains
its independent role-specific outcomes, and unexpected internal faults remain
the generic `SERVER_ERROR`. None of those paths is folded into
`ROOM_ACCESS_DENIED`.

## Consequences

- Normal operation and the 24-hour renewable-room experience require only one
  bounded in-memory room map and no writable database directory.
- The central control plane stays small and ephemeral; media distribution and
  bandwidth remain governed by the P2P-first route model rather than moved to the
  application server.
- A deployment, crash, or restart invalidates 100 percent of current rooms and
  invitations. Active media already disconnects at that boundary; the additional
  cost is a new room code and invitation. Same-browser Host preferences are
  reapplied automatically on the next explicit share.
- A room unused beyond the lease is released. The local code preference is
  renewed while sharing and once on normal stop, then expires after the same
  configured lease duration.
- Recycled code-only bookmarks may eventually identify a different room. A stale
  grant remains unusable because the new room has a different digest.
- Multi-process room coordination, seamless restart, and horizontal scaling are
  outside the current contract. They require a new accepted storage decision if
  they become real requirements.

## Acceptance Gates

- Allocation uses only `1000` through `9999`, never duplicates an active code,
  admits at most the fixed 9,000-code capacity, and returns released codes to
  the free pool.
- An active Host is not expired. Stop/disconnect starts the configured dormant
  lease; the exact Host token resumes before expiry; Viewer activity does not.
- Expiry and process restart reject the old Host token, Viewer grant, room
  password, and code-bound room state. Reusing a released code never accepts the
  old grant.
- Default creation atomically produces `open` code entry with no room password
  and an independent 22-character token-bearing invitation. The grant remains
  valid for exactly the current room incarnation and has no independent expiry.
  `open` and `private` code entry, including private rooms with and without a
  password, are covered independently from grant rotate/revoke.
- Same-browser recreation reapplies the Host profile and requests a current
  preferred code only while it is free; another browser, cleared storage, an
  expired preference, or an occupied code uses random allocation. No fingerprint
  or server user record participates.
- Raw site passwords, Host tokens, Viewer grants, and room passwords remain out
  of application/proxy logs and server durable storage.
- On the accepted `screener-v12` Browser wire, a well-formed, site-authorized
  code-only attempt for an unallocated, reclaimed, or expired room yields
  `ROOM_NOT_FOUND` and no
  password prompt. Existing-room policy, password, full, and bounded admission
  failures retain `ROOM_ACCESS_DENIED`; exact-room grant, Host-authentication,
  and unexpected-server-fault paths keep their independent typed outcomes.

## Implementation Status

Current source and production use the strict `screener-v12` wire and implement the
22-character room-incarnation grant, exact digest validation, rotate/revoke,
browser-storage privacy, `open | private` code entry, and the `ROOM_NOT_FOUND`
split without a v11 parser.

Exact release and operational evidence are owned by deployment, status, and
verification status.

## Decision Sources

- [Node.js `crypto.randomBytes()`](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptorandombytessize-callback)
- [NIST SP 800-57 Part 1 Rev. 5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)
