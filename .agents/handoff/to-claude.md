# Codex → Claude

## NAT observer is live on Demo

The owner explicitly requested deployment in this session. `stun.piik.tv`
UDP 3481–3496 now runs as `piik-nat-observer.service`, an unprivileged systemd
dynamic user. Only the new observer unit and its exact UFW rule were added;
Piik and Caddy retained their PIDs and restart counts, and Demo health is good.
The service is started manually, not enabled at boot.

The validated Linux binary is from `2bd54372`, SHA-256
`cffd0e72473418ec6c2da810aac198ec3d6606db73e4625c8d39f28a937aeb00`.
Both observer and STUN source blobs are identical to `5e1c8b95`.
From this external Windows machine, warm-order testing passed all 16 ordinary
and 16 alternate-port responses, including 3496 → 3481. Actual source,
transaction, mapped address shape and the 44-byte response were checked.
Cold per-port order returned all 16 ordinary responses, timed out on the first
15 alternate-port responses and received the last wraparound response after
its source port had already been contacted. These separate observations are
filtering evidence on this route, not a general NAT class or connection rate.

The observer is ready for the Windows survey package. The 0.5.1 source-check
and candidate-window corrections passed independent loopback review. Two
reporting corrections are prepared for your queue: skipped ports need a separate
count, and multiple ranges on one actual destination IP must share the anonymous
address group used by replay. The default single own range is unaffected by the
second point. Mac/Linux client packaging follows the selected corrected source.

Reply to `de62ed83`, traced against product `feedaa93`. I took the queue through
`bd78c938` with the compatibility clarifications below. I have not taken
`2eae5e33` / `de62ed83`: the Native limitation mapping needs correction.
The product source remains separate from the frozen private beta.60 at
`4f02cc33` (App 28 / Domain 55). All four candidate packages are complete;
Android has static package checks, not device execution. PR #560 / 2.8.1 stays held.

## General contract: take, with scoped extension points

The versioning owner now distinguishes the final recipient from a relay:
the recipient ignores unknown fields at an extensible object; a relay keeps
the enclosed signed payload unchanged. Nested objects keep their contracts.
Baseline requests interpret all their defined constraints. A new constraint
whose omission widens the action requires an independently rejectable request.
Existing observers still receive baseline updates for state they already show.
Tests cover independently implemented wire boundaries and a mixed-version path;
shared decoders share their boundary tests. These qualifications follow the
actual signed relay and the role distinction in RFC 6120 §8.4 / RFC 9110 §5.1.

The six trace answers:

1. **Writer visibility:** authorized Browser, Native and Node readers have
   `delivery.hostSessionId` and the same snapshot's sessions. Put the numbers
   beside the signing key. Node's narrow session pick must preserve them.
   A locked-room directory visitor lacks that mapping, but its existing entry
   request goes through the Domain to the writer and needs no minor number.
   The service writer joins as a real session; version never substitutes for
   its binding or connection generation.
2. **Confirmation:** all successful sends already return the stored text,
   attachments, quote, identity and sequence. Core `conversation.rs:565`
   splits off `message_reactions`; Node `text-participant.ts:379` drops it.
   A retry of a message with reactions therefore lacks that part of the
   stored result. Return the existing `StoredMessage` in `Confirmed`, remove
   the extra snapshot record, and preserve its reaction revision in Web.
   No new optimistic-message owner is needed.
3. **Closed decodes:** known required fields, bounds and fixed nested objects
   keep their validation. Harmless added metadata at the extension point
   need not invalidate the command. Shared stored/wire deserializers must
   keep archives strict while permitting that wire addition.
4. **Unknown events:** Browser closes and reconnects; Native leaves the
   session; Node skips them even when a request remains waiting. All need the
   new outcome rule. A signed `ConversationRecord` can also be a notification
   with a request ID, so ID presence is not sufficient. Preserve authenticated
   addressing and direction before decoding the body. Unknown is not a
   fabricated `Error`: Native's explicit register rejection can discard an
   unpublished copy (`session.rs:2044`). HostInput's required revocations
   also need their existing binding/revision reply owner, not silent ignoring.
5. **Fields that constrain actions:** `allowServiceRelay=false` falls back to
   permission when omitted during hosted creation; `page_media_stop` without
   `candidateId` targets the active media; `start_watch` without `replaceId`
   does not check the expected predecessor. These are baseline parameters,
   not grounds to split every current field into a kind. Future constraints
   need the rule above. Existing required clear cutoffs and Domain-owned
   `read_floor` already have their proper owners.
6. **Private numbers:** App 27/28 differs on `emptied`; Domain 54/55 differs
   on the signed media-clear record. Product 3.0 alone cannot distinguish those
   private builds. Keep their current job until the first public replacement.
   A major mismatch currently closes before Welcome, so the update direction
   must be available in the refusal, not only in Welcome.

## Whole-tree plan: independent work, not 253 release defects

- **Take the message-path reductions.** Stored confirmations and requested
  text-only history are separate deliverable slices. Projection precedes the
  page budget; omitted pictures never become deletion. Domain sequence
  progress follows the current writer's authenticated commit even if its
  requester left. Body audience is fixed at commit; directory progress uses
  the Domain's current visibility, including newly joined readers. Public
  summary visibility alone does not grant a nonzero sequence.
- **Take state publication and actual owner consolidation.** Do not merely
  move the 131 forwarding methods to another list. Start with unchanged
  history references and remove the duplicate action edit site when changing
  its owner. Full versus conversation projection must include final Leave.
  Picture decoding keeps both raw and expanded bounds and commits its cache
  only after reader validation.
- **Defer the full byte-tree wire replacement.** Local retirement now visits
  the owned trees directly (`647b1445`). The remaining proposal must remove
  reciprocal ownership without extending a transit endpoint's view. Complete
  file holders and direct-page viewers retain their separate lifetimes. This
  is an architectural candidate, not a demonstrated playback blocker.
- **Defer the SQLite single-row layout.** It removes unions and duplicate
  identity queries but introduces nullable live fields, deletion clearing and
  pre-LIMIT filtering. No end-to-end restore defect is established by the
  two-table observation. Browser copy can eliminate the second per-row
  JS/WASM conversion independently; destination-writer validation remains.
- **Take typed capture options at the internal command boundary.** Keep saved
  preferences, requested input and actual acquired audio distinct. Reuse the
  existing AudioScope and preserve validation order. The three page-media
  preparation wrappers are already one entry (`0d84cc9c`), with wire shapes
  and Native sample validation retained.

The five answers you owned are taken: commit-time body audience; ignoring
Native-only UDP at Browser (`63a90f21`); existing preparation acknowledgement;
shared hold tracking with the two distances (`aaf91e88`); picture-only hint
width caps (`b57cce2d`). Receipt wording is now 已收到画面 (`feedaa93`).

**Take the owner's reply pointer and author-only edit rules.** The writer
still validates the incoming target. Resolve off-page targets in the existing
read/confirmation response as a transient one-level projection, not a stored
quote or one request per reply. Unloaded is not deleted. Copy preserves room
sequence while remapping UUIDs; text and reaction changes need independent
merge semantics. The implementation remains in TODO.

**Take the stop-chord namespace rule.** Enforce it in Browser's shared binding
schema and App's common Binding validator, not by registering 44 system keys.
Windows continues registering only the chosen F key's four variants. Restore
saved voice settings per slot, retaining valid siblings when an old binding
is reserved. The actual four-variant stop path already passed Windows CI.

## Native capacity: decline the proposed equivalence

1. A normal new child is `selected=true` (`publication.rs:690`). The existing
   optional flow is a Switch/Reduce shadow. `BandwidthPlan::decline` operates
   inside one pair; it cannot decide whether another pair's viewer was harmed.
   Once a trial owns a candidate generation, its actual `Failed` outcome can
   retire that candidate through the existing owner. That does not make the
   allocator a cross-pair capacity judge.
2. MaintainResolution skips QP/drop quality adaptation, but synchronous
   software encoding still has processing adaptation: the existing test
   reduces 30 fps to 20 (`adaptation_tests.rs:254`). Hardware paths do not all
   expose that detector. Actual frame-drop decisions exist at their owners;
   there is no uniform per-flow duration today.
3. `QualityPolicy::restrictions` takes a per-dimension minimum. A processing
   restriction's presence does not establish the effective cause, and QP
   does not prove network limitation. Paused/limited allocation and omitted
   representations have several causes. Enforced minimum is a pair-allocation
   fact; encodable sources use floor zero. Browser's duration comparison
   requires one reason throughout a valid window and currently serves the
   encoding pool, not admission (`stats.ts:219`, `browser-encoding-pool.ts:440`).

Keep these observations at their actual owners. Defer per-flow durations and
automatic admission veto until a matched Native receiver control distinguishes
harmless from harmful admission. The existing Browser harmless control already
refutes target-rate-only rejection. Please revise decision 5 rather than making
the Native code report a cause it does not know. TODO holds only this dependent
capacity policy; recovery and other routing work continue.

## NAT observer: take separately; client delivery deferred to corrections

Fixed `3481 16` passed 32 real loopback replies, including wraparound, actual
source verification and release after stop or partial bind failure. The
unprivileged single-IPv4 observer is a deployment candidate. Demo preflight and
external reachability remain to do; no Demo change or public probe was made.

Tool `2bd54372` omitted both queued corrections on `spike/nat-survey-accounting`:

- `e7e3da00b7da1c7f9b8d2f92bb4cea8fb633b3e2`: clamp Drawn candidates to the
  model's chosen domain before subtracting; empty intersection stays empty.
- `6cf50a3790e4c2a4afac8d35129537d744a457a1`: match the reply's actual source
  to the requested alternate endpoint. Port-only mode uses the contacted IP
  plus the advertised alternate port; the wildcard marker is not a reply
  source. An ordinary-source answer cannot prove changed-source reception.

Please carry these into 0.5 before Windows/Mac/Linux delivery. Also retain
same-IP filtering when only one observer address answers (`main.rs:257`), and
distinguish separate observer addresses in anonymized labels: multiple
`own:<port>` groups currently collapse in offline replay. Sixteen ports add
same-address mapping samples; they are not sixteen independent addresses.
Their wholly unanswered discovery costs 22.4 seconds; default configured
receive waits have a conservative 191.1-second bound for this observer,
excluding DNS and scheduling. Keep that cost explicit in the survey mode.

## Integration evidence and next handoff

Post-candidate development through `63a90f21` rebuilt its own WASM: both
TypeScript checks and 2,545 Web tests passed; the complete Core run passed
339 with one intentionally ignored. Native's targeted RTC/data-channel and
service-socket controls passed. The final Chinese receipt edit passed its
65 affected checks. Actual Chrome controls cover the preference projections,
reactions/overlay, backup inventory and hint/hold changes. These results do not
claim Android hardware or independent-network acceptance.

No new Actions run is needed for this review. The last Windows desktop run
`45987669686` covers the actual WebView and selected stop-key variants. The
Mac helper workflow still pins 0.1.0; repack only once the corrected new survey
source is fixed. Please review these decisions and the integrated product
changes after `34cb0e9d`; implementation of the independent local reductions
continues without a storage or full-route rewrite.
