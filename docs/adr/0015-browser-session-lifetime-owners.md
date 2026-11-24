# ADR-0015: Browser Session Lifetime Owners

- Status: proposed
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

1. Each lifetime gets an owner object with the same small shape: an
   `AbortSignal` that ends with the lifetime, `reconcile(next, previous)` over
   raw authority snapshots, `retire(reason)` that runs once, and `project()`
   returning its part of the view. An owner keeps its own operation in flight;
   nothing outside reads it through the view.
2. `ChannelSession` keeps the domain connection, signaling recovery, the request
   correlator and the previous and current raw snapshots. `applyState` stores
   the snapshot, calls each owner's `reconcile` in dependency order and
   publishes `derive(snapshot, owners)`.
3. The view is output only. `pending` and every per-activity field are
   projections of owners. Edge detection compares raw snapshots.
4. An operation's failure belongs to its caller. `action()` rejects and the
   surface that started the operation shows the result. `view.error` keeps
   connection and session facts. `reportError`, `clearError` and `errorRoomId`
   are removed.
5. Work started under an owner checks only that owner's signal after an await.
   Supersession, where the latest requested setting wins, is a separate explicit
   helper and not a signal.
6. Replacing the session identity for an archive or domain restore is done by
   the session's owner, `useChannel`, which closes one session and constructs
   the next. A session does not reconnect itself as another identity from
   inside one of its own actions.
7. External boundaries are constructor inputs with production defaults: the
   socket factory, the App connector, the room-hosting loader and the clock.
   Tests drive those and the public actions.

### Owners And Order

| Step | Owner | Lifetime it owns | Leaves the class |
| --- | --- | --- | --- |
| 0 | Constructor seams | None; it enables the rest | Private casts in tests |
| 1 | `RoomReader` per room binding | History pages, follow-latest, the interaction session and the read cursor | `PendingHistory` in the request map, three loops that walk every request, `readings` and `historyChannel` bookkeeping |
| 2 | Operation feedback | One result per started operation | The flags that arbitrate the global error slot |
| 3 | `VoiceParticipation` | Publication and mute per room | `voiceParticipation` and the voice arms of `applyState` |
| 4 | `Stage` per room | Source selection, screen share and watch-together, which share one stage slot | `sourceSelections`, `screenShares`, both watch-player maps and the three per-share setting loops |
| 5 | `ScreenWatches` | Viewing subscriptions and the App helper | `watching` and its playback-error edges |
| 6 | `BrowserHosting` | Hosted rooms and their cleanup | `hostedRooms` and `hostCleanup` |
| 7 | Identity replacement in `useChannel` | The session itself | Restore's close, reconnect and rollback inside actions |

Each step is a few commits that keep `npm test` passing, and the line can merge
between steps. Step 0 comes first because it removes the tests' need to write
private fields. No later step starts before the tests it touches go through a
seam. The microphone capture is shared by room voice and share commentary, so
it stays one shared lease that steps 3 and 4 both use.

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
