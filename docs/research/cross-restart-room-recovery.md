# Cross-Restart Room Recovery

Status: Later optional persistence research. ADR-0002 continues to own the
default behavior: application restart loses every room, credential, lease,
invitation, route, and media authority. The owner accepts that default and does
not reopen persistence merely to preserve a preferred room code.

## Current Boundary

The application process owns the complete `RoomStore`, while the Host browser
keeps its raw Host token, creation profile, and best-effort preferred room code.
After restart the old token and Viewer grant cannot authenticate; replaying the
preferred code and profile creates a new room incarnation. LiveKit rooms and the
Screener SFU resource ledger are also generation-scoped and process-resident.

LiveKit resume covers a transient signaling or network interruption while the
same server-side session exists. A full reconnect rebuilds participants, tracks,
publications, and subscriptions. The current deployment additionally deletes
managed LiveKit rooms before admitting a new application generation. Neither
WebRTC nor LiveKit can restore application authorization or route ownership from
surviving media packets.

## Minimal Recoverable Model

The smallest candidate is Host-led lineage recovery, not persistent room-state
reconstruction:

- a random stable `lineageId` identifies the Host-owned room across application
  generations;
- every successful creation or recovery allocates a fresh random
  `authorityEpoch`;
- the server signs a bounded Host recovery capsule containing the lineage,
  Host-token digest, preferred code hint, server-owned expiry, and purpose;
- the Host retains the capsule and raw Host token locally; a Viewer can never
  create, recover, reserve, or renew a room;
- recovery atomically verifies site access, capsule, Host token, expiry, code
  availability, and replayed policy/password before publishing the new room;
- session, share, connection, route, authorization, and SFU generations are
  fenced by the fresh authority epoch. Old asynchronous results fail closed.

The room code remains a best-effort locator. If another lineage already owns it,
recovery must not evict that Host; the recovering lineage receives another free
code or fails according to the future accepted contract. Client clocks, local
lease extensions, roster, graph, first-frame proof, and resource counts never
become server truth.

## Invitation And Revocation Boundary

A signature proves that the server issued a capsule; it does not prove that the
capsule is the newest one. Restoring the old Viewer-grant digest and authorization
generation from a still-valid capsule can replay a grant that the Host rotated or
revoked before the crash. Rejecting that stale checkpoint requires a server-side
latest-generation high-water mark or accepting replay until the capsule expires.
There is no stateless third option.

An old invitation must always bind to its lineage and authorization generation.
It cannot fall through to code-only admission, enter a different lineage that
reused the same four-digit code, or create a missing room. A private room whose
local password material is unavailable must fail closed rather than become open.

The lowest-risk first phase would recover only Host lineage, control, lease
ceiling, and a free preferred code, then issue a new invitation. Stable old
invitations are a separate decision that must settle revocation high-water and
code relocation first.

## Media Boundary

Control recovery can be automatic while the Host tab and capture track remain
alive, but a page or browser restart still requires a new user gesture for screen
capture. Every recovered route must close or fence old P2P/SFU senders, rebuild
the graph and resource ledger, and recommit on a newly decoded frame. Media may
briefly survive a process crash, but it has no current authority and cannot be
advertised as uninterrupted service.

True multi-node LiveKit continuity requires its distributed Redis deployment and
draining model. That is a different infrastructure and availability decision,
not a consequence of Host lineage recovery.

## Decision Needed

1. Is Host lineage/control recovery sufficient, with new invitations and a
   bounded media gap?
2. If old invitations must survive, does the product accept bounded stale replay
   or one small durable latest-authorization-generation owner?
3. May a recovered lineage move to another room code when its hint is occupied,
   and should a lineage-bound invitation resolve that new code?
4. Is a same-browser bearer recovery capsule an acceptable ownership boundary?
5. Are application and LiveKit restart targets both bounded rebuild, or is
   LiveKit high availability a separately funded requirement?

An optional SQLite mode may reopen this decision only as one complete durable
room-authority contract, disabled by default. It would own room lineage, code,
credential digests, authorization generation, policy/password verifier and a
bounded inactive-retention fact atomically; live participants, routes, stats and
SFU resources still rebuild. Unknown future data is not justification for a
generic database. SQLite can make room identity and authorization robust across
an application restart, but it cannot preserve WebSocket, WebRTC or LiveKit
process state without client reconnect and media recommit.

## Primary Sources

- [W3C Capability URLs](https://www.w3.org/TR/capability-urls/)
- [RFC 6750 bearer-token threats](https://www.rfc-editor.org/rfc/rfc6750.html#section-5.2)
- [RFC 7519 expiration and token IDs](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1)
- [RFC 9246 signed-URI replay boundary](https://www.rfc-editor.org/rfc/rfc9246.html)
- [Kubernetes names and UIDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/)
- [The Chubby lock service](https://storage.googleapis.com/gweb-research2023-media/pubtools/4444.pdf)
- [WebRTC ICE restart](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-restartice)
- [LiveKit reconnect behavior](https://docs.livekit.io/intro/basics/connect/#network-changes-and-reconnection)
- [LiveKit distributed deployment and draining](https://docs.livekit.io/transport/self-hosting/distributed/)
