# ADR-0002: Memory-Resident Rooms And Scoped Viewer Access

- Status: Accepted; implemented and deployed in exact release `39fcf93`
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

The free-code pool contains every currently unallocated four-digit code. Room
creation selects uniformly from that pool, and room release returns the code to
it. `MAX_ROOMS` must not exceed the 9,000-code space; its product default remains
1,000. A room code is a locator, not a secret or permanent identity.

`ROOM_LEASE_SECONDS` is the single room-lifetime setting and defaults to 86,400
seconds. An authenticated, actively sharing Host prevents expiry. When sharing
stops or the Host is no longer connected, the room remains dormant until the
lease deadline. The same Host token may resume sharing before that deadline and
renew the lease. Viewer presence never renews ownership. Expiry closes the room,
invalidates its credentials, and releases its code.

Process restart deliberately clears every room, lease, credential digest,
password verifier, and participant. Old Host records and invitations then fail
closed, and the next Host share creates a new room. There is no room database,
`ROOM_DATABASE_PATH`, persistent-room mode, schema migration, or compatibility
reader. The site-access secret remains deployment configuration rather than room
state.

### Ownership And Local Host Defaults

Room ownership uses the existing random Host bearer token, not an IP address,
user agent, hardware property, or browser fingerprint. The Host browser keeps the
raw token in same-origin `localStorage`; the server keeps only its digest in the
current room. Clearing local data or changing browser/device loses ownership.

The Host browser also keeps one local creation profile containing its display
name, code-entry policy, and optional room password. When an old room no longer
exists, the next explicit share creates a new room and atomically reapplies that
profile, so the same browser retains its preferences but receives a new code,
Host token, and Viewer grant. The site-access password is never part of this
profile. A Host room password may be stored locally as a convenience for this
private product; the server receives it only over the authenticated creation or
update path, derives the verifier, and never stores or logs the plaintext.

### Orthogonal Viewer Access

Every room has an expiring, room-scoped Viewer grant independent of code entry.
The primary share action copies `/r/{code}#v={grant}`. A valid grant directly
authorizes only the Viewer role in that room. The browser consumes it into
room-scoped `sessionStorage`, immediately clears the fragment with
`history.replaceState`, and never places it in a cookie, query, log, error, or
`localStorage`.

Code entry is a separate three-state policy:

- `open` is the default: after site access, the four-digit code admits a Viewer
  without a room password;
- `password`: after site access, the code also requires the room password;
- `disabled`: code-only admission is rejected and the grant remains the entry
  path.

The Host may rotate or revoke the grant without changing code-entry policy, and
may change code-entry policy without changing a healthy media route. Strong
grant revocation advances the authorization generation, clears Viewer grace and
route state, closes the old receive and send edges, and disconnects the affected
Viewers before they can reconnect with the old grant.

`SITE_ACCESS_PASSWORD` continues to protect room creation, Host admission, and
all code-only Viewer attempts. A valid room grant may bypass that site gate only
for the exact Viewer role and room. Neither a code, room password, nor Viewer
grant can create a room or become Host authority.

The current `screener-v9` room-entry boundary uses exactly one
`ROOM_ACCESS_DENIED` result. It applies only after site access to a well-formed
code-only Viewer attempt whose expected admission rejects an unknown or expired
room, disabled code entry, an absent or incorrect room password, a full room, or
another bounded admission refusal. Every such case uses the same code, public
message, and connection-close behavior, so neither the wire nor the UI reveals
room existence or code-entry policy. The UI may offer an optional room-password
retry and tell the Viewer to use an invitation link supplied by the Host; it
does not request, discover, or mint an invitation through the server.

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
- A room unused beyond the lease is released. With a 24-hour value, any dormant
  interval longer than 24 hours produces a new code.
- Recycled code-only bookmarks may eventually identify a different room. A stale
  grant remains unusable because the new room has a different digest.
- Multi-process room coordination, seamless restart, and horizontal scaling are
  outside the current contract. They require a new accepted storage decision if
  they become real requirements.

## Acceptance Gates

- Allocation uses only `1000` through `9999`, never duplicates an active code,
  respects `MAX_ROOMS`, and returns released codes to the free pool.
- An active Host is not expired. Stop/disconnect starts the configured dormant
  lease; the exact Host token resumes before expiry; Viewer activity does not.
- Expiry and process restart reject the old Host token, Viewer grant, room
  password, and code-bound room state. Reusing a released code never accepts the
  old grant.
- Default creation atomically produces `open` code entry with no room password
  and an independent token-bearing invitation. `open`, `password`, and
  `disabled` code entry are covered independently from grant rotate/revoke.
- Same-browser recreation reapplies the Host profile; another browser or cleared
  storage does not. No fingerprint or server user record participates.
- Raw site passwords, Host tokens, Viewer grants, and room passwords remain out
  of application/proxy logs and server durable storage.
- On `screener-v9`, every expected denial of a well-formed, site-authorized
  code-only attempt yields only `ROOM_ACCESS_DENIED` with the same public
  message and connection-close behavior. Tests cover unknown/expired rooms,
  disabled entry, absent/wrong passwords, full and bounded admission, while
  exact-room grant, Host-authentication, and unexpected-server-fault paths keep
  their independent typed outcomes.

## Implementation Status

Production exact `39fcf93bae057fcbb1002702c3be6b90bac9027f`, release `39fcf93`,
runs the single `screener-v9` wire and implements this complete room boundary,
including allocation, leases, orthogonal grant/code admission, rotate/revoke,
password policy, local profile replay, restart loss, browser storage privacy,
and the neutral `ROOM_ACCESS_DENIED` result. All expected code-only denials use
that same public result followed by the shared authentication-failed close code.

The atomic deployment postflight passed. Its rollback boundary is
`/opt/screener/backups/39fcf93-pre-v9-20260824T004257Z`; exact operational
evidence remains owned by deployment and verification status.
