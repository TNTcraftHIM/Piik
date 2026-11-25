# ADR-0015: Browser Session Lifetime Owners

- Status: accepted on 2026-11-25; steps 4 and 7 start after the refinements
  named under Consequences
- Date: 2026-11-24

## Context

`ChannelSession` in [session.ts](../../src/client/channel/session.ts) is one
4,000-line class with about 45 private fields. It carries the domain connection
and every activity a page can start: room reading and history, Browser room
hosting, the App link, screen viewing, source selection and sharing,
watch-together, voice, and archive restore. One reconciler, `applyState`,
retires all of them from each snapshot.

Three properties of this shape produce repeated defects. Each was verified on
`f17a57e3`:

- Lifetimes share fields. `local`, `watching`, `screenShares`,
  `voiceParticipation` and `requests` each have several writers, including one
  another's retirement paths.
- Currency after an await is proved again with a different predicate at each
  site: socket identity, binding IDs, map-entry identity, symbols, a generation
  counter, abort controllers and pending keys.
- The view is an input. `view.pending` is the lock that `action()` tests and
  that the reconciler reads to decide retirement. `view.state`, a projection
  filtered by local intent, is read back as the previous authority state.

On this line the file was changed by about 250 commits in thirty days. About
140 were fixes, which added 967 lines net, and a third of all fix subjects on
the line begin with keep, preserve or retain. The 15,000-line test writes
private fields at about 44 places, which makes the class expensive to split.

[Engineering](../standards/engineering.md#implementation-rules) requires one
owner per lifetime. This decision applies that rule to the Browser session.

## Decision

1. Each lifetime has one owner for its resources, pending work and retirement.
   Its interface follows the operations its callers need.
2. `ChannelSession` keeps the domain connection, signaling recovery, the request
   correlator and the previous and current raw snapshots. `applyState` stores
   the snapshot, updates affected owners in dependency order and
   publishes `derive(snapshot, owners)`.
3. The view is output only. `pending` and every per-activity field are
   projections of owners. Edge detection compares raw snapshots.
4. An operation's failure belongs to its caller. `action()` rejects and the
   surface that started the operation shows the result. `view.error` keeps
   connection and session facts. `reportError`, `clearError` and `errorRoomId`
   are removed.
5. After an await, verify the resource and operation are still current before
   publishing success or failure. A newer request may supersede work within a live binding.
6. Replacing the session identity for an archive or domain restore is done by
   the session's owner, `useChannel`, which closes one session and constructs
   the next. A session does not reconnect itself as another identity from
   inside one of its own actions.
7. Inject an external dependency with a production default when a public-action
   test needs control over it.

### Owners And Order

| Step | Owner | Lifetime it owns | Leaves the class |
| --- | --- | --- | --- |
| 0 | First RoomReader test seam, if needed | First binding-scoped history scenario | Its private test setup |
| 1 | `RoomReader` per room binding | History pages, follow-latest, the interaction session and the read cursor | `PendingHistory` in the request map, three loops that walk every request, `readings` and `historyChannel` bookkeeping |
| 2 | Initiating dialog or page control | One result per started operation | The flags that arbitrate the global error slot |
| 3 | `VoiceParticipation` | Participation, mute, deafen and the voice publication per room, and the microphone the rooms share | `voiceParticipation`, `microphone` and `microphoneRequest`, the voice arms of `applyState`, `reconcileLocalMedia` and `projectActivity`, and the microphone release in `action()`, `refreshActivity` and `applyState` |
| 4 | `Stage` per room | Source selection, screen share and watch-together, which share one stage slot | `sourceSelections`, `screenShares`, both watch-player maps and the three per-share setting loops |
| 5 | `ScreenWatches` | Viewing subscriptions and the App helper | `watching` and its playback-error edges |
| 6 | `BrowserHosting` | Hosted rooms and their cleanup | `hostedRooms` and `hostCleanup` |
| 7 | Identity replacement in `useChannel` | The session itself | Restore's close, reconnect and rollback inside actions |

Each step is a few commits that keep `npm test` passing, and the line can merge
between steps. Step 0 adds only the dependency needed by the first RoomReader test.
Request correlation stays with the session. RoomReader assembles confirmed pages
and applies live changes within the binding. Optimistic updates keep their
operation identity until confirmation or failure.
Room voice and share commentary capture separate microphones. The voice rooms
share one microphone, which `VoiceParticipation` releases after its last
consumer, and commentary stays with its share in step 4. The session keeps the
local publications, personal playback and the input preference, and voice uses
them through one interface.

## Consequences

- A transition no longer carries another lifetime's state by hand. That is the
  defect class behind most of the `preserve` and `retain` fixes in this file.
- `applyState` shrinks to ordering, which becomes the explicit place to reason
  about dependencies between lifetimes.
- Step 2 changes where failures appear. `ChannelPage.run` discards rejections
  today and relies on the global slot, so page-level display moves first.
- Step 7 needs a handoff design, because dialogs hold the session reference
  that `useChannel` creates once.
- While a step is in progress the file it restructures is on
  [hold](../../CONTRIBUTING.md#working-with-a-second-agent).
- Two questions stay open: whether WASM should return validated history pages
  instead of the session reassembling `history_message`, `message_reactions`
  and `history_end`, and the shape of the per-operation result surface.

## References

- [Engineering: one owner per lifetime](../standards/engineering.md#implementation-rules)
- [OTP supervision principles](https://www.erlang.org/doc/system/sup_princ.html):
  a parent owns the start, stop and failure of its children.
- [AbortSignal](https://dom.spec.whatwg.org/#interface-AbortSignal), the
  platform's cancellation primitive.
