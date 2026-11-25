# Lifetimes in the Browser client and the shared core: a map

Checkout `E:/Research/Piik`, branch `refactor/claude-review`, HEAD `a0dd6ea6`.
Read-only pass; no file other than this report was changed. Labels: **code**
(read in the source), **doc** (a document or code comment claims it, cited),
**test** (a test asserts it), **measured** (a recorded measurement; none found
for this area). Paths are relative to the repository root.

## Summary

The Browser has one hub, `ChannelSession` (`src/client/channel/session.ts`,
3,839 lines, read in full). Most of its private fields (ADR-0015 counts about
45) hold a lifetime: the domain socket and its two timers, the request correlator, room
readings and histories, the App link, local captures, screen shares, source
selections, screen watches, three watch-player maps, successor-following maps,
and the sub-owners it constructs (`VoiceParticipation`, `BrowserHosting`,
`ChannelMedia`, `ChannelConversation`, `ChannelInput`, `ChannelAttachments`,
`WatchBytes`). Two owners have been extracted (voice, Browser hosting), but
both still reach back into session state: voice shares the session's `local`
map by reference (`session.ts:260`) and asks the session to retire its
publications; hosting reports failures into the session's global error slot.

Four retirement paths exist for a whole session and they are not ordered the
same way: a fresh Welcome for another session (`session.ts:547-548`), the
20-second recovery deadline (`3801-3806`), `close()` (`3819-3838`, also the
page-unload path through `use-channel.ts:21-24`), and identity replacement
(`connectBackupIdentity`, `restoreDomainBackup`, `joinAsNewIdentity`), which
call `close()` and then `connect()` from inside a session action.

Below the hub the owners are mostly sound: each WebRTC pair
(`ChannelTransport`), each pooled encoder (`BrowserEncodingPool`), each watch
player (`WatchPlayer`), each microphone (`MicrophoneInput`), each App page
(`AppPage`, reference-counted) and the file and watch byte runtimes have one
owner with an idempotent close. The weak points are where a lifetime is held in
two or three maps at once, where a deadline exists on one side of a wire and
not the other, and where an await is followed by a currency check that differs
from its sibling's.

The core (`prototype/channel-core/src`) is sans-I/O: every deadline is a
`u64` milliseconds value computed from a `now` the runtime passes in. The
domain clock is advanced by `Domain::expire(now)` (`lib.rs:606-623`), which a
runtime must call (the Server calls it every second, `channel-server/src/domain.rs:853-856`,
not mapped here). Core lifetimes with deadlines: session resumption
(`RECOVERY_MS` 20 s), transport discovery (`DISCOVERY_TIMEOUT_MS` 20 s,
retry `REQUIRED_RETRY_MS` 5 s), one route operation per publication
(`SCREEN_PREPARE_MS` 20 s), a room repair (`REQUIRED_REPAIR_MS` 5 s) and a
deferred file pull (unnamed `5000`). Core lifetimes without a deadline: the
domain's pending room replies (bounded at 64 per binding), the outstanding
route wake, creation reservations, source handoffs, peer watch reads and the
room host's single pending operation.

Sharpest questions (detail under "Questions for the reviewer"): the session
recovery window is two independent 20-second timers on two clocks (Q1); a
pair attempt is bounded by two independent 20-second timers (Q2); the core's
pending room replies have no deadline, so a host that never answers holds a
slot until it re-binds (Q3);
peer watch reads have no deadline on either side, while file reads do (Q4);
`close()` closes the App link before it asks the App to stop captures, the
other paths do the opposite (Q5); a host's brief signaling drop cancels local
source selections and can leave a closed watch player in `watchPlayers` (Q6);
`joinAsNewIdentity` silently becomes the old identity after a socket retry,
and a test pins it (Q7).

## How to read the tables

Each row is one lifetime. Columns: where it is declared; the owner as the code
has it (the object whose field holds it); where it starts; where it ends
(S success, F failure, C cancellation, R replacement by a newer one, E session
end, U page unload); what happens to work awaiting it; the currency check after
an await, with its predicate. "E" means `releaseMedia` (`session.ts:3725-3751`)
or `closeConnection` (`3819-3838`) unless stated. "U" is `pagehide` →
`session.close()` (`use-channel.ts:21-24`) → `closeConnection`; React-owned
resources end only when the next render unmounts them.

## 1. Domain connection and session identity (Browser)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Domain WebSocket `socket` (`session.ts:205`) | `ChannelSession` | `connect()` `488-492`, called by `start` `412-414`, retry timer `538`, `reconnect` `3713`, `joinAsNewIdentity` `3718`, `connectBackupIdentity` `1938` | S: none (lives until closed). F: invalid frame → `socket.close()` `527`; welcome with wrong protocol → `closeConnection` `514`; unauthenticated error → `closeConnection` `648-650`; `onopen` signer failure → `closeConnection` `501-503`. R: `reconnect` nulls then closes old `3708-3710`. E/U: `closeConnection` `3829-3831` | `rejectRequests("disconnected")` on close `534`, `("closed")` on `closeConnection` `3832` | socket identity: `this.socket !== socket` in every handler (`497`, `508`, `532`) |
| Reconnect timer `retry` (`208`) | `ChannelSession` | `onclose` `538`, fixed 1000 ms, no backoff | fires → `connect(acceptWelcome)`; cleared by `reconnect` `3706` and `closeConnection` `3825` | n/a | the closure carries `acceptWelcome` only; `newIdentity` is not carried (Q7) |
| Recovery deadline `recoveryDeadline` (`209`) | `ChannelSession` | `beginRecovery` `3798-3807` from `onclose` `537` and `reconnect` `3712`; 20000 ms literal | S: `endRecovery` on Welcome `545`. E: `closeConnection` `3824`. Fires: `releaseMedia` + `releaseHosts` + view `sessionId:null, error:"session_expired"` `3802-3805` | interactions get `disconnected()` `3799` | none; fires unconditionally (Q1) |
| Session identity (`view.sessionId`, `credential` `216`, `ownerBootstrap` `218`) | `ChannelSession` | Welcome `549-573` | new session id → `releaseMedia` `547`, `releaseHosts` `548`; `close()` nulls view `3837`; identity ops overwrite `credential`/`ownerBootstrap` `1926-1927`, `1912-1914` | n/a | `identityGeneration` (`211`) counter, bumped only by `close()` `3815`; read by `connectBackupIdentity` `1928`, `1951`, `admitBackupIdentity` `1919-1921`, `restoreDomainBackup` `1978-1979` |
| `closed` flag (`210`) | `ChannelSession` | `connect` sets false `468-470` | `closeConnection` sets true `3822` | n/a | read with socket identity in `sessionContext` `1686` |
| Queued signals `signals` (`235`) | `ChannelSession` | `send()` while not connected, cap 256 `908` | flushed on Welcome if pair still listed `601-603`; cleared `releaseMedia` `3750` | none | pair id presence in the Welcome |
| Conversation signer (`ChannelConversation.identity`, `conversation.ts:22`) | `ChannelConversation` | `initialize()` on `onopen` `session.ts:496`, `conversation.ts:34-43` | `close()` frees signer `conversation.ts:119-124` from `closeConnection` `3835` | `ready()` throws `disconnected` if identity replaced `conversation.ts:26-32` | promise identity |
| Forwarding budget (WASM `ForwardingBudget`, `forwardingBudget` `206`) | `ChannelSession` | Welcome `571` | `releaseMedia` frees `3726-3727`; `reconnected()` on resumed Welcome `572` clears its in-flight capacity requests (`forwarding.rs:27-29`) | capacity requests are raw `write`s with a requestId (`887`), not in `requests`; cleared by `capacity_reply` on `room_reply`/`ack`/`error` `609`, `633` | none |
| Debug collector `releaseDebug` (`212`) | `ChannelSession` | `connect` `472` | `closeConnection` `3820` | n/a | n/a |
| Feedback audio (`feedbackAudio` `213`; `AudioContext`, document listeners, `feedback-audio.ts:34-80`) | `ChannelSession` | `connect` configures `470`; `applyFeedbackSound` `423-427` | `closeConnection` `3823`; disabled → `close()` `feedback-audio.ts:61` | n/a | n/a |
| Feedback clip import (`feedbackImports` `214`, Symbol per cue) | `ChannelSession` | `setFeedbackClip` `429-431` | `finally` `440`; `closeConnection` clears `3821` | caller of `setFeedbackClip` | map-entry identity (Symbol) `434` |

Session-level retirement paths (code):

```
Welcome with different sessionId:   releaseMedia(); releaseHosts()          // 547-548
recovery deadline fires:            releaseMedia(); releaseHosts()          // 3803-3804
close() / pagehide / identity ops:  releaseHosts(true)  [app.close() inside]
                                    write(leave); socket.close(); rejectRequests("closed")
                                    outgoingMessages.clear(); releaseMedia() [app?.stopCaptures() is now a no-op]
                                    conversation.close()                    // 3827-3835
```

## 2. Request correlation, the pending lock and waits (Browser)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Pending request (`requests` `220-224`) with timer, abort listener and, for history, a page in `RoomHistory` | `ChannelSession` (pages held by `RoomHistory.pages`, `room-history.ts:45`) | `request()` `939-977`; history page opened `966-967` | S: reply in `receive` (`room_reply` `613-617`, `room_created` `621-622`, `profiles` `627-629`, `ack` `637-639`), `receiveConversation` `1061-1062`. F: `error` `639`; result validator throws `959-962`; `conversation.send` rejects `969-972`; timeout 10000 / 30000 ms `941`. C: abort signal `932-937`, `retireReadings` aborts reading pages `1383-1386`. R: binding change rejects `room_unavailable` `775-780`. E: `rejectRequests` `3721-3723`. All go through `retireRequest` `1140-1147`, which drops the page | the caller's promise | before arming: `reading.ready` awaited `923`, then: reading map-entry identity `925`, socket identity `926`, `conversationBinding` equality `927`. After the reply: none in `request()`; callers re-check |
| Pending lock (`view.pending`, `199`) | the view (written only by `action()`) | `action()` adds key `1285` | `finally` removes `1291-1294` | concurrent `action` with same key rejects `operation_pending` `1282` | read by reconciliation: `applyState` `730`, `763`; Welcome `596`; `syncAppWatching` `1225`, `1240`; `browseRooms` `1347`; `requestHistory` `1616`; `selectScreen` `2433`; `resumeWatches` `2654`; `reconcileWatchBytes` `2873`; `commitExternalScreen` `3309`; voice `busy` (`voice-participation.ts:98-101`) |
| Error report of an action | the view slot `view.error` | `action()` catch, if `socket === socket` and `ownsError()` `1288-1289` | `clearError` `2369`; Welcome clears `573`; next action with `clearError` `1285` | n/a | socket identity (`1289`) |
| `waitForState` subscription (`1890-1899`) | the caller's frame | `acceptInvitation` `1465`, `importHostedRoomCopy` `2052`, `installRoomHistory` `2154`, `reconcileWatchBytes` `2874` | S: predicate true; F: 10000 ms timer `1897` or `closed` `1895` | the caller | predicate re-evaluated on every `patch` |
| `abortWhenStale` subscription (`1692-1696`) | the caller's frame | `sendMessage` `1503`, `exportRoomArchive` `1850`, `installRoomHistory` `2142` | `dispose()` in the caller's `finally` | aborts the caller's signal when the check throws | caller-supplied check |
| `commitExternalScreen` busy wait (`3310-3318`) | the call's frame | each `prepared` App event `1193` | resolves on a `patch` after which `prepared() && busy()` is false | the commit | `prepared()` (app identity, share identity, input identity, captureId, room available) — no timer, no abort (Q12) |
| Profile loads (`profileLoads` `202`, `missingProfiles` `203`) | `ChannelSession` | `loadProfiles` `364-368` | S/F: `finally` deletes own key `367`; Welcome clears `568`; `closeConnection` clears `3836`. `missingProfiles` has no expiry inside a session (key includes the profile version `340`) | all callers sharing a key await the same promise `359-369` | socket identity `365` |

## 3. Room reading, history and interactions (Browser; ADR step 1)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Room reading `readings` (`RoomReading`, `59-68`, `239`) | `ChannelSession` | `browseRooms` `1336-1341` for each wanted room (`wantedReadings` `1305-1322`) | stale socket/binding/authorization/availability `1327-1331`; `ready` rejected `1367-1372`; not wanted `retireReadings` `1381-1389`; Welcome `574` (does not close interactions); channel change `769`; `releaseMedia` `3730` | `request()` for conversation commands awaits `ready` `923` | map-entry identity + socket identity + `wantedReadings().has` (`1344`, `1423`) |
| `ready` (the `browse` request) | the reading | `1339` | as request (10 s) | history loop, conversation requests | as above |
| History follow loop `reading.history` | the reading | `browseRooms` `1353-1366`; `requestHistory` `1619` | loop ends when `before` undefined or selection/reading changes `1359` | `sendMessage` follow-latest `1534` | map-entry + socket identity `1363` |
| Follow-latest intent `reading.followLatest` (Symbol) | the reading | `sendMessage` `1495` | deleted by `loadMessage` `1551`, `requestHistory` `1615`, follow `1530` | n/a | Symbol identity `1527`, `1529` |
| `readingRooms` (the domain's per-room `browse active` flag) | `ChannelSession` | Welcome `575`; `request(browse active)` `974`; room returned `846` | `retireReadings` writes `browse active:false` `1390-1396` (kept while room authorized but unavailable `1393`); `releaseMedia` clears `3731` | n/a | n/a |
| `RoomHistory` per room (`histories` `238`) | `ChannelSession` | lazily `roomHistory` `1123-1125` | dropped on unreadable room or fresh binding `781-782`; window reset `retireReadings` `1387`. Not cleared by `releaseMedia` or `closeConnection`; cleared indirectly because after `close()` every room with delivery counts as a fresh binding (`772-773`, `view.state` is null) | pages tied to requests | binding id per page (`room-history.ts:52-55`) |
| Interaction session (`RoomInteractionSession`, stored in `view.interactionsByRoom` `187`, referenced by `reading.interaction`) | the view map (resource held in the view) | `syncRoomReading` `1428-1449` (reuses an existing view entry `1428`) | `closeInteraction` `1398-1407` from `browse` `1301`, `browseRooms` `1330`, `retireReadings` `1380-1382`, fresh binding `774`, `settleInteraction` `1413`, channel change `769`, `releaseMedia` `3729` | the interaction's send callback | map-entry identity `current?.interaction !== interaction` `1430`, `1442` |
| Interaction subscribe request (`interactionReadyRequestId`) | the reading | `1440` | `interaction_ready` reply `998-1000`; refusal → `closeInteraction` `1413` | n/a | requestId equality `999`, `642` |
| Outgoing message retry (`outgoingMessages` `242-244`) | `ChannelSession` | `sendMessage` `1522` | S `1526`; user discard `1484-1487`; binding change `783-786`; `closeConnection` `3833`. Kept after failure on purpose | n/a | object identity `1526`, binding equality `1498` |
| Attachment preparation (`sendMessage` `1502-1511`) | the call | `attachments.describe` | `lifetime.dispose()` `1511` | the call | `abortWhenStale` check: `closed`, session id, binding `1503-1506` |

## 4. Browser hosting (Browser; ADR step 6, done)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Hosted room (`BrowserHosting.rooms` `browser-hosting.ts:33`; the `BrowserRoomHost`, IndexedDB connection and WASM `RoomHost`) | `BrowserHosting` | `restore` `117-124`; `register` `158-163` (from `createRoom` `session.ts:1674`, `installRoomHistory` `2152`) | F: `bind` rejected → `host_stop` + retire + report `51-58`. S(delete): `dispatch` result `deleted, dataRemoved` `70-73`. R: `register` replaces `162`; `replace` after commit `171-179`. Not listed → `update` `81-88`. Not stored / summary failure / refused register → `restore` closes directly `105-108`, `127-135`, `140-147`. E: `release` `182-191` from `releaseHosts` (`session.ts:1156-1161`) | `restore` awaits `cleanup` before opening `97` | `current()` = socket identity + session id + `!closed` (`session.ts:582`); per room: map-entry identity and binding id (`52`, `66`) |
| Host binding (`hosted.bindingId`) | `BrowserHosting` entry | `host_bound` → `bound` `46-50` | replaced by next `host_bound`; entry removal | `dispatch` is queued behind `bind` on the host's turn (`room-host.ts:345-350`) | `bindingId` equality at dispatch (`room-host.ts:372`) |
| Close chain `cleanup` (`35`) | `BrowserHosting` | `retire()` `203-206` | settles when all chained closes settle | `restore` `97` | n/a. Direct `await host.close()` calls in `restore`/`replace` (`108`, `119`, `121`, `132`, `146`, `177`) are not on the chain (Q11) |
| Stored-room failures (`failed` `34`) | `BrowserHosting` | `fail(id, failure)` `194-201` | `fail(id)` without failure; `release` `186-189` | n/a | n/a |
| Room host turn (`BrowserRoomHost.tail`, `room-host.ts:345-350`) and WASM pending operation (`RoomHost.pending`, `host.rs:913`) | `BrowserRoomHost` | `dispatch` `room-host.ts:371-375` → `host.rs:1999` | `finish` `host.rs:2008-2061` or `abort` `2063-2070` (`room-host.ts:388-391`); close waits on `tail` `523-529` | domain request (via `host_output`) | binding id `room-host.ts:372`, `roomTransaction` re-reads stored binding `364` |

## 5. App link (Browser)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| App control link (`ChannelApp`, `app-link.ts:276`; `session.app` `233`) | `ChannelSession` | `connectApp` `session.ts:1176-1197` (from `activateApp`, `startNativeScreen` `3560`, `startExternalScreen` `3294`, `prepareWatchPage` `2703`, `prepareWatchingPage` `2938`, `nativeSources` `3268`) | socket close / bad frame / hello failure → `lost()` → `close()` + session `onClose` `app-link.ts:356-362`, session clears `this.app` `session.ts:1178-1182`. C: `waitReady` signal before ready `app-link.ts:523-527`. E: `releaseHosts` → `app.close()` `session.ts:1158-1160` | `ready` (no timer) `app-link.ts:363-372`; `waitReady` | `this.app !== app` after `waitReady` `session.ts:1202`; App identity checks across the session (`1214`, `1235`, `1274`, `1744`, `2197`, `2206`, `3270`, `3306`) |
| App requests (`ChannelApp.requests` `278`) | `ChannelApp` | `request()` `473-482` | reply `460-466`; abort signal `476`; `close()` rejects all `814-815`. No timer (Q12) | callers | per-capture `captureId` re-check after await (`695`, `704`, `716`, `726`, `766`, `784`, `795`) |
| Capture leases (`captures` `283`, `prepared` `286`, `externalInputs` `284`, `audioStates` `285`) | `ChannelApp` | `prepareCapture` `633-634`, `commitCapture` `729-735`, `prepareExternalInput` `651-657`, `external_input_state` `438-458` | `capture_ended` `419-427`; `stopCapture` `761-778`; `cancelCapture` `753-759`; `cancelExternalInput` `743-751`; `stopCaptures` `799-801` from `releaseMedia` `session.ts:3740`; `close()` clears `806-809` | `prepareCapture` re-checks its preparation `644` | preparation object identity `641`, `644` |
| App page (`AppPage`, `113-238`) with owner count and holds | `ChannelApp.pages` + reference count (`owners` `124`) | `preparePage` `484-501` | last owner released (`close` `223-225`, hold release `126-131`) → `retire` `229-237` → `page_close`; `page_closed` event `218`; `ChannelApp.close` retires all `812` | page reads abort with `lifetime` (`160`, `171`, `188`, `203`) | page lifetime signal |
| Capture source read (`pendingSources` `292`) | `ChannelApp` | `sources()` `555-579` | S/F; last reader aborts it `569-573`; 8000 ms timer `584` (`SOURCE_LIST_TIMEOUT_MS` `26`) | multiple readers share one read | reading controller identity `561`, `570` |
| Preview queue (`previewTail` `291`) | `ChannelApp` | `preview()` `607-623` | each preview settles; cancel sends `cancel_preview` `612` | serialized | signal |

## 6. Local captures, shares and source selection (Browser; ADR step 4)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Local capture/publication (`local` `258`; mirror in `ChannelMedia.local`, `media.ts:46`) | `ChannelSession`, shared by reference with `VoiceParticipation` (`260`) | `publish` `2374-2376`; `startScreen` replace/transfer `2589-2590` | F: publish failure `2391-2393`. Authority dropped publication `681-687`. Native/external takeover `3340`, `3582`. `stopScreen` with successor `3641`; `retireScreenPublication` `3659-3667`; voice via `retire` (§7). E: `releaseMedia` disposes audio, `media.reset`, `local.clear` `3744-3746` (no per-capture `retireCapture`). Tracks stopped only in `ChannelMedia.removeLocal` `media.ts:159-165` or `reset` `737` | `publish` awaits the room | map-entry identity `local.get(id) !== capture` `2381`, `3525`, `3640` |
| Source-ended listener (`observeScreen` `2454-2459`) | the track (`{once}`) | publish `2388`; replace `2591` | fires once; never removed | n/a | `local.get(id)?.stream === stream` `2457` |
| Host audio mixer (`HostAudio`, `host-audio.ts:12`) incl. its `AudioContext`, commentary `MicrophoneInput`, `microphoneRequest` | the `local` entry (`audio`) | `startScreen` `2527-2533` (context activated in the gesture `2482`) | `retireCapture` `3754`; `releaseMedia` `3744`; replaced unless retained `2594`; `releaseCandidate` `2485-2493` | commentary `setMicrophone` `host-audio.ts:83-115` | `microphoneRequest` controller identity `112`; `microphone === input` `99` |
| Screen share record (`screenShares` `246`, `ScreenShare` `102-117`) | `ChannelSession` | `selectScreen` `2424-2445` | authority drop `684`; `forgetInactiveScreen` `2447-2452` (from `finishSourceSelection` `2422`, App `onClose` `1180`, App capture state `1185`, `cancelExternalScreen` `3287`); `stopScreen` `3647-3651`; `releaseMedia` `3735` | per-share operations below | `screenShares.get(roomId) === selected` `2444` |
| Per-share operations `microphoneChange` `112`, `qualityChange` `115`, `audioChange` `113` (coalescing loops) | the share | `setSourceMicrophone` `3395-3424`, `setScreenQuality` `3453-3482`, `setSourceAudio` `3514-3550` | loop ends when requested equals applied; `finally` clears | later callers receive the same promise (`3392`, `3450`, `3512`) | three different predicates for one share (Q10) |
| Source selection (`sourceSelections` `257`, `SourceSelection` `85-100`): controller, page, embed, candidate releases, page lease, discovery, pending candidate | `ChannelSession` | `selectSource` `2397-2405` from `selectScreen`, `prepareWatchEmbed` `2675`, `startWatch` `2689`, `prepareWatchPage` `2701`, `commitExternalScreen` `3321`, App share picker `3198` | all through `finishSourceSelection` `2410-2423`: R `2399`; room not available `659-661`; `cancelScreenSelection` `2471`; `finally` of `startScreen` `2623`, `commitWatch` `3033`, `startExternalScreen` `3299`, `commitExternalScreen` `3345`, `startNativeScreen` `3588`; page closed `2710-2712`, `3202-3205`; `stopScreen` `3649`; `releaseMedia` `3734` | every awaited step in a selection | `sourceSelections.get(roomId) === selection` (`2444`, `2768`, `2824`, `2981`, `3325`) plus `selection.controller.signal` |
| Browser capture candidate (stream, `HostAudio`, `AudioContext`) | the `startScreen` frame, exposed as `selection.releaseBrowserCandidate` | `captureBrowserSource` `2497` (late grants stopped by `acquireMediaStream`, `capture-stream.ts:9-12`) | moved into `local` `2589-2593`; `releaseCandidate` in `finally` `2620-2622` or from `finishSourceSelection` `2417` | n/a | `current()` + signal (`2498`, `2522`, `2537`, `2557`, `2572`) |
| Capture lifetime signal (`captureLifetime` `245`) | `ChannelSession` | constructor; renewed in `releaseMedia` `3733` | aborted in `releaseMedia` `3732` | voice microphone requests, screen-watch endpoint query `2288`, `connectBackupIdentity` `1929`, `exportDomainBackup` `1966` | signal |

## 7. Voice (Browser; ADR step 3, done)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Voice participation per room (`rooms`, `voice-participation.ts:84`) | `VoiceParticipation` | `join` `105-106` | `leave` `136-142`; failed join `127`; authority dropped and not busy `update` `275-278`; `close` `336-340` from `releaseMedia` `session.ts:3748` | voice actions | map-entry identity `rooms.get(roomId) !== intent` `110`, `112`, `118`, `189`, `193` |
| Voice publication (clone of the shared microphone stream) | three holders: `intent.publicationId` (`voice-participation.ts:15`), session `local`, `ChannelMedia.local` | `join` `114-117`; `setMuted` `190-192` via `session.publish` | through `session.retire` (`retireCapture` `session.ts:3753-3758`) from `leave` `139`, `update` `277`, join failure `128`, unmute failure `199`, `captureEnded` `330`; session-initiated: authority drop `681-687`, publish failure `2392`; `releaseMedia` clears maps without `retireCapture` | n/a | `capture.stream !== stream` `324-326` |
| Shared microphone (`MicrophoneInput` `85`, `microphone-input.ts:17`) with `AudioContext`, gate and suppressor worklets | `VoiceParticipation` | `getMicrophone` `378-424` | `release()` when no room needs it `366-376`; device `ended` callback `394-398`; processing error `401` (reports to the global slot) | `setMicrophoneMode`/`configureInput` await `microphoneRequest.promise` `227`, `248` | `this.microphone !== input` `259`; session lifetime signal `228`, `249` |
| Microphone request (`microphoneRequest` `86`) | `VoiceParticipation` | `getMicrophone` `386`, `422` | `finally` `421`; `release()` aborts `368-373` | joins share the promise `380` | `AbortSignal.any([session lifetime, request])` `387` |

## 8. Screen viewing (Browser; ADR step 5)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Screen watch (`watching` `236`, `ScreenWatch` `77-83`) | `ChannelSession` | `watch` `2274-2278` | F: `2302`; `unwatch` `2321`, `2325`; retry failure `2358-2361`; Browser/App takeover of own screen `2602`, `2616`; `stopScreen` with successor `3654`; `retireScreenPublication` `3662`; authority dropped publication `728-730`; `releaseMedia` `3749`. All via `retireWatch` `2311-2317`, which also closes input `2312` | the watch action | map-entry identity `watching.get(id) !== watch` `2295`, `2298`, `2300`, `1239`, `2358` |
| Endpoint query `watch.query` (AbortController) | the watch | `2287` | `2292`; `retireWatch` `2315`; `unwatch` `2320-2322` | `app.localEndpoint` | `AbortSignal.any([query, captureLifetime, caller])` `2288` |
| Picture retry `watch.retry` | the watch | `retryPicture` `2339-2340` | `finally` `2364`; a new `watch()` aborts the old record's retry `2277`; `retireWatch` `2314` | `retryPicture` | `controller.signal`, session context, publication context `2345` |
| Playback error (`watch.playbackError`) | the watch record, four writers | `screenPresentation` callback `374-379` (from `ChannelVideo.issue`, `ChannelMedia.tsx:469-478`) | deleted by media stream change `298-301`, by `patch()` for local screens `399-402`, by `applyState` edge `731-739`, by `retryPicture` `2341-2342` | n/a | n/a |
| App helper association (`watch.helperSessionId`) | the watch | `syncAppWatching` `1241` | retry `2353`; watch retirement | n/a | socket + session id + app identity `1234-1235`, then map-entry `1239` |
| Declined successors (`declinedSources` `255`) | `ChannelSession` | `unwatch` `2327`, `declineSuccessor` `3143`, `leaveWatch` `3125-3126` | settled `702-705`; `watch` `2279`; `joinWatchAndSyncClock` `2637`; `releaseMedia` `3738` | n/a | n/a |
| Local Native endpoints (`localNativeEndpoints` `234`) | `ChannelSession` | `rememberLocalEndpoint` `1213-1219` | session gone `662`; `releaseMedia` `3747` | n/a | app identity, `connected`, `closed` `1214` |

## 9. Watch-together (Browser; ADR step 4)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Active player (`watchPlayers` `256`; `WatchPlayer`, `watch-playback.ts:14`: lifetime, 1000 ms align interval `89`, operation queue) | `ChannelSession` | `commitWatch` `2991`; `selectWatchingPage` `2968`; `joinWatchMedia` `3081`, `3099`; `resumeWatch` `3253` | via `retireWatchPlayer` `2626-2634`: subscription removed `747`, activity removed `762-763`, owner byte source session gone → `stopWatch` `750-752`, replaced `2967`, `3080`, `3098`, start cancelled `3027`, screen replacement `3170`, leave `3127`, stop `3152`, `releaseMedia` `3739`. `resumeWatch` replaces without `retireWatchPlayer` (`3253-3254`). Media `closed` event → `stopWatch`/`leaveWatch` `2664-2667` | `serialize` queue `watch-playback.ts:288-292` | map-entry identity `watchPlayers.get(id) === player` (`2657`, `2824`, `2868`, `2904`, `3003`, `3103`, `3187`, `3212`, `3228`, `3250`) and `player.signal` |
| Candidate player (`pendingWatchPlayers` `247`) | `ChannelSession` | `prepareWatchingPage` `2944`; `joinWatchMedia` embedded path `3069` (same object also in `watchPlayers` from `3081` to `3087`) | `retirePendingWatchPlayer` `2913-2920` (closes the player) from `applyState` (activity missing or room not available) `741-744`, Welcome `576-578`, `cancelWatchPage` `2921-2927`, `leaveWatch` `3119`, `releaseMedia` `3736`; promoted without close `2964`, `3087` | `selectWatchingPage` | map-entry identity `2948`, `2963`, `3086` |
| Successor waiting (`waitingWatchPages` `248-253`) | `ChannelSession` | `applyState` `712-718` | `applyState` `803-812`, `820`; joined `2965`, `3110`; leave `3123`; `releaseMedia` `3737` | `joinWatch` for the successor `815` | socket identity + map-entry identity `819` |
| Watch media (`HTMLVideoMedia`, `AppPageMedia`, `PageSuppliedMedia`, `YouTubeMedia`, `PeerTubeMedia`) | the player | player construction | `player.close()` → `media.close()` (`watch-playback.ts:300`); `HTMLVideoMedia.ready` failure disposes itself (`watch-media.ts:239-242`); selection `embed` also closed by `finishSourceSelection` when not committing `2420` | n/a | media lifetime signal |
| App page held by a watch (`AppPageMedia.release` `watch-media.ts:352-365`; `PageSuppliedMedia.pageLease`/`ownsPage` `watch-page-media.ts:139-158`) | the media | `page.hold()` `2736`, `2785`, `2845`, `3200`; ownership by default | media close releases; `transferPageTo` moves it `3251`; `commitPortableWatch` closes the page after commit `2796` | n/a | page lifetime |
| Owner page reactions (`activateWatchOwner` `3191-3231`): share-picker hook, media-source listener, view subscription | the player signal | commit `3013`, resume `3255` | `player.signal` abort `3224`; `onSharePicker` is a field on the page and is not cleared | n/a | `watchPlayers.get(id) === player` `3196`, `3212` |
| Peer byte reads (`WatchBytes.pending`, `watch-bytes.ts:28`; WASM `WatchDelivery`) | `WatchBytes` (session field `315`) | `read` `70-90`, cap 32 | `received`/`failed` effects `112-115`; plan source changed `64`; caller abort `80-83`; `reset` `146-152` on session change and `releaseMedia` `3743`. No timer (Q4) | the HLS/MP4/DASH loader | runtime lifetime identity `50` |
| Service-worker resource lease (`openWatchResource`, `watch-resource.ts:39-121`) | `HTMLVideoMedia.resource` | `watch-media.ts:157-159` | media dispose `269`; signal | worker fetches (max 4) | `closed` flag, request signal |
| HLS loader deadline (`watch-hls-loader.ts:44-48`) | loader | per request | timer only when `deadlineOwner === "loader"` | hls.js | n/a |

## 10. Peer media (Browser)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| Physical pair (`ChannelMedia.peers` `media.ts:42`; `ChannelTransport`, `transport.ts:86`: `RTCPeerConnection`, data channels, writers) | `ChannelMedia` | `update` `183-234` per new plan | plan removed `173-179`; `setRooms` throw `245-250` (transport closed, entry kept); transport `failed` `215-221` (closed, entry kept until the next snapshot); `reset` `732-739` from `releaseMedia` | data senders `sendData` `300-308` | `peers.get(id)?.transport === transport` (`200`, `207`, `211`, `217`) |
| Preparation deadline (`transport.ts:103`, 20000 ms `TRANSPORT_PREPARE_MS` `16`) | `ChannelTransport` | constructor `145`; re-armed by `syncDeadline` `357-363` while rooms wait for an open data channel | cleared when connected and data lane open or no rooms `358-359`; `close` `1017`. Fires: connected → `failRoomData` (report `room_data_state:false`), else `fail()` → `link_state:failed` (`365-370`) | n/a | `closed` flag |
| Negotiation queue (`operations` `102`) | `ChannelTransport` | `enqueue` `994-997` | rejection → `fail()` | n/a | `closed` before each action |
| Data lanes (`channel`, `bulk`, `input`; `ChannelWriter` `1043-1113`) and `dataLifetime` `112` | `ChannelTransport` | `setRooms` `259-262`, `ondatachannel` `169-179`, `setInputEnabled` `197-209` | `closeData` `347-355`; lane error/close `294-307`, `221-227`; writer `close` rejects queued frames | `sendData` callers; queue cap from WASM `data_queue_frames` | lane identity `current()` `292`, `215` |
| Sender binding (`SenderBinding.lifetime` `34`) and sender clone track (`cloneSenderVideoTrack`, `sender-video-track.ts:17-61`) | `ChannelTransport` | `addSender` `574-675`; `replaceSource` `539-563` | `removeSender` `810-821` (aborts lifetime, stops clone); clone pipe end → `failOutput` (`527-529`) | sender operations wait under `waitForConnectionOperation(lifetime)` | `ownsSender` `512-514` |
| Incoming input proof (`MediaInput.stopProof`, 100 ms poll `decoded-frame-proof.ts:1`) | the `MediaInput` | `prove` `386-393` | proof → `ready` `372-380`; `release` `358-364`; `owns()` false | n/a | `ownsInput` `396-403` |
| Candidate quality comparison (`stopQuality`, 2000 ms timer `VIEWER_QUALITY_EVIDENCE_INTERVAL_MS`) | the `MediaInput` | `compareCandidate` `468-523` | `stop` `485-489`; `release` | n/a | `owns()` `481-484`, re-checked after `getStats` `497` |
| Relay codec probe (`codecProbe`) | the `MediaInput` | `refresh` `553-560` | `release` `359`; paused `262` | n/a | probe identity + `ownsInput` `556` |
| Relay playback element (`relayMedia` `49`; hidden `<video>`/`<audio>` in `document.body`) | `ChannelMedia` | `syncRelayMedia` `616-630` | `syncRelayMedia` when tracks change `608-615`; `reset` → `refresh` with no needs | n/a | map-entry identity `626` |
| Encoding pool (`BrowserEncodingPool`, `browser-encoding-pool.ts:44`; members, groups, 500 ms interval `BUDGET_SAMPLE_MS` `41`) | `ChannelMedia.videoPool` `50` | `create` `52-81` from `attachPool` (`transport.ts:697`) | member `remove` `444-453` (from `removeSender` `815`); group `prune` `455-463`; pool `dispose` `83-87` from `ChannelMedia.reset` `735` | `updateProfile` promise per member | `member.disposed`, `groups.has(group)` |
| Pool producer (`BrowserEncodingProducer`: two loopback PCs, hidden `<video>`, startup timer 8000 ms `LOCAL_CONNECTION_TIMEOUT_MS`) | the pool group | `startGroup` `373-393` | `dispose` `browser-encoding-producer.ts:188-208` from `prune` or `fail` `210-215` | `start` | `checkAlive` `222-224` |

## 11. Files (Browser)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency after await |
| --- | --- | --- | --- | --- | --- |
| File runtime (`ChannelAttachments.runtime`, WASM `FileDelivery`, `lifetime` `attachments.ts:60-61`) | `ChannelAttachments` (session field `316`) | `ensure` `135-153` | `reset` `767-785` (from session change `166`, `releaseMedia` `session.ts:3742`, `applyForwarding` without user `886`) | effects | `runtime.lifetime === this.lifetime` `154` |
| Core-owned deadline timer (`expiry` `64`) | `ChannelAttachments` | `invoke` sets one timer from `delivery.next_deadline()` `156-163` | replaced on every `invoke`; `reset` | n/a | `current(runtime)` |
| Receive sink (`sinks` `74`: OPFS file, writer, `lifetime`) | `ChannelAttachments` | `content` `593-602` | complete `724-739`; `stopSink` `746-753`; last consumer cancels `607-613`; room unauthorized `178-184`; cache clear `275-279`; `reset` `776` | per-consumer promises `605-618` | map-entry identity `sinks.get(id) === entry`, runtime identity |
| Download (`downloads` `77`) | `ChannelAttachments` | `download` `516-555` | S/F; `cancelDownload` `556-562`; replaced `521`; room unauthorized `200-205`; `reset` | caller | map-entry identity `528`, `537`, `548` |
| Transfer storage lease and sink disposals (`transferStorage` `75`, `sinkDisposals` `76`) | `ChannelAttachments` | first sink `621` | `reset` closes after disposals `777-783` | n/a | n/a |
| `FileStore` IndexedDB connection | per transaction (`file-store.ts:31-48`) | each call | `finally` closes | n/a | n/a |

## 12. Components and hooks (Browser)

| Lifetime (decl) | Owner | Starts | Ends | Currency |
| --- | --- | --- | --- | --- |
| The session itself | `useChannel` `use-channel.ts:10` (`useState`, created once) | `start()` on mount `20` and on `pageshow` persisted `22` | `close()` on `pagehide` `21`, `24` and on unmount `37`; restarted in place by `start()`; replaced identities stay inside the same object (ADR step 7) | n/a |
| Screen `<video>` binding (`ChannelVideoInput`, `ChannelMedia.tsx:355-370`) | the component | layout effect | effect cleanup pauses and clears `srcObject` `369` | `active` flag `367-368` |
| Viewer listening graph (`ViewerAudio`, `viewer-audio.ts:36`) in `ChannelVideo` | `ChannelVideo` ref `output` | swap effect `ChannelMedia.tsx:519-546` | replaced on swap `530-531`; unmount `563` | `ref.current === element` |
| Voice `<audio>` and `ViewerAudio` (`ChannelAudio` `ChannelMedia.tsx:677-704`) | the component | effect | cleanup `695-703` | `current` flag `688-691` |
| Shared voice `AudioContext` (`VoicePlaybackContext`, `viewer-audio.ts:12-34`) | `ChannelPage` `useState` (`pages/ChannelPage.tsx:339`), reference-counted | `acquire` | `release` at zero | n/a |
| Stage picture-in-picture follow (`useStagePicture`, `use-stage-picture.ts:12-87`) | the hook | layout effect | cleanup exits PiP `78-84` | `attempt` element identity |
| Detached panel window (`usePanelWindow`/`openPanelWindow`, `panel-window.ts:20-155`) | the hook's `lifetime` controller | `open` `39-50` | `close` `51-56`; unmount `37`; window `pagehide` `128` | signal |
| Native page slot (`useWatchPageSlot`, `use-watch-page-slot.ts:13-79`) | the hook | layout effect | cleanup unmounts `72-76` | `revision` counter `51-56` |
| Source list read (`ChannelShareControl` `request`, `ChannelShareControl.tsx:177-202`) | the component | `refresh` | replaced or unmounted | controller identity `195` |
| Source selection started from the watch dialog | the session (`sourceSelections`), cancelled by the dialog's `close` (`ChannelShareControl.tsx:436-441`) | dialog actions | dialog `close` → `cancelScreenSelection`; no unmount cleanup in `WatchSourceDialog` | n/a |

## 13. Core lifetimes (`prototype/channel-core/src`)

| Lifetime (decl) | Owner | Starts | Ends | Waiters | Currency |
| --- | --- | --- | --- | --- | --- |
| Session and its resumption window (`Session.connection`, `disconnected_at`; `identity.rs:81-82`) | `Identity` | `admit` `254-339` (resume if `disconnected_at` is none or `< RECOVERY_MS` `290-292`) | `disconnect` stamps time `391-398`; `expired` `400-410` → `Channel::expire_sessions` `channel.rs:462-473` → `retire_session` `436-452`; `Leave` `392-396` | its pending room replies (§ below) | connection id (`session_for_connection`) |
| Pair attempt (`TransportBook.discovery`, `Pending{deadline}` `transport.rs:105-109`) | `TransportBook` | `start_discovery` `418-430` (`DISCOVERY_TIMEOUT_MS` `32`) | confirmed (not read in detail); expired `798-816` → pair removed, `rejected` with `retry_after` = now + `REQUIRED_RETRY_MS`; `prepare` renews the deadline and replaces the pair id `782-796`; `retire` on `link_state:failed` `818-835`, `channel.rs:369` | Browser transport (§10) | `DiscoveryEdge` includes both socket ids `transport.rs:81-102` |
| Failure memory (`rejected`) | `TransportBook` | expiry/retire | `retain_failures` `141-143`; consumed by `start_discovery` `426` | n/a | socket generations in the edge |
| Room binding (`Binding`, `remote.rs:12-25`) with `revision`, `projection_floor`, `scope_floor`, `read_floor`, `applied_revision`, `failed_pairs` | `RemoteRoom` | `register_host` `channel.rs:828-923` (new or continuing with `resume`) | `pause` `remote.rs:221-242` from `stop_host` `channel.rs:1387-1404`, host session retired `448-449`, failed delete `lib.rs:591-603`; replaced by another session's `register_host` when the old host has no connection `channel.rs:865-874`; `remove_room` `1180-1190` | pending replies | binding id + session + connection at `accept_host` `1415-1420` |
| Pending room reply (`Binding.replies`, `ReplyOwner`, `remote.rs:39-47`) | the binding | `RemoteRoom::input` `376-378`; cap 64 → `room_busy` `359-361` | host output for that revision `channel.rs:2036-2087`; `drain_replies` on pause/re-register/remove (`room_context_changed`) `remote.rs:200-219`, `channel.rs:879`. No time limit (Q3) | the domain requester | requester connection and member re-checked at release `channel.rs:2056-2058` |
| Route wake (`ReplyOwner::RouteWake`) | the binding | `wake_hosts` when `next_route_deadline <= now` `channel.rs:1336-1371` | host output for its revision; a room with an outstanding wake is skipped `1351-1357` | n/a | n/a |
| Creation reservation (`RemoteRoom.reservation`, `remote.rs:54`) | `RemoteRoom` | `reserve_creation` `channel.rs:963-972` | `register_host` `902`; `cancel_room_creation`; reserving session retired `438-439`. No time limit | Browser `createRoom` | session id |
| Room host operation (`RoomHost.pending`, `host.rs:892-897`, `913`) | `RoomHost` | `dispatch` `1821-2006` | `finish` `2008-2061` (takes `pending` at `2013` before the attachment check `2014-2025`); `abort` restores `before` `2063-2070`. `prepare_peer` refuses while pending `1570-1572` | runtime adapter | binding id `1825-1831` |
| Route operation per publication (`Publication.operation`, `publication.rs:21`, `RouteOperation{deadline}` `30-33`) | `Publication` | `reconcile_observed` and `prepare_reduction` set it with now + `SCREEN_PREPARE_MS` (`458-459`, `482-483`, `493-494`, `517-518`, `608-613`, `640-641`) | expiry `725-756` (marks failure); proof completes (`commit_ready_switch` `852-883`, `flow_state_observed` `926-938`); dropped without failure by `reset_routes` `113`, `retire_transport` `125`, `set_paused` `136`, `transfer_source` `163`, `bound_screen_preparation` `199`, `flow_state_observed` `948`, `961`, and three sites in `reconcile_observed` (`335`, `396`, `440`) | n/a | flow id and lease identity (`current_switch` `706-719`) |
| Quality evidence (`Shadow.presented_at`) | the operation leg | `record_proof` `70-73` | stale after `QUALITY_EVIDENCE_MS` `84` | n/a | `now` |
| Room repair (`RoomRuntime.repair_at`, `room.rs:73`) | `RoomRuntime` | `reconcile_with_pairs` when repair needed `1643-1645` (`REQUIRED_REPAIR_MS` `20`) | due `1428-1431`; not needed `1647`; `reset_routes` `143` | n/a | n/a |
| Source handoff (`Activity.handoffs`, `room.rs:23`) | `RoomRuntime` per viewer | `handoff` `909-927` | viewer joins/declines `1053`, `1324`; target gone `1461-1464`; viewer unreadable `1458-1459`. No time limit | Browser successor following (§9) | n/a |
| Deferred file pull (`FileDelivery.pending`) | `FileDelivery` | `file_delivery.rs:344-345` with now + `5000` (unnamed) | `expire` → `file_route_timeout` `253-270` | Browser via `next_deadline` | request id |
| Peer watch read (`WatchDelivery.pending`) | `WatchDelivery` | `pull` `watch_delivery.rs:390` | `finish`/`stop` `542-626`; `cancel`, `request_failed`, `peer_closed`, plan update. No time input in the API (`158-298`) | Browser `WatchBytes` | request id |
| In-flight capacity request (`ForwardingBudget.pending_capacity`, `forwarding.rs:23`) | `ForwardingBudget` (Browser-side WASM) | `capacity_updates` `37-75` | `capacity_reply` `31-35`; `reconnected` `27-29`; superseded on update | n/a | binding id key |

## Constants

| Name | Value | Where | Bounds | Notes |
| --- | --- | --- | --- | --- |
| `RECOVERY_MS` | 20000 ms | `identity.rs:10` | session resumption (core) | starts at the server's disconnect observation |
| (literal) | 20000 ms | `session.ts:1806` | Browser gives up its session | starts at the Browser's `onclose` or `reconnect()`; Q1 |
| (literal) | 1000 ms | `session.ts:538` | reconnect retry | fixed, no backoff, no cap |
| (literal) | 10000 / 30000 ms | `session.ts:941` | request reply (30 s for conversation and profiles) | conversation requests first await `reading.ready` (itself 10 s) |
| (literal) | 10000 ms | `session.ts:1897` | `waitForState` | |
| (literal) | 10000 ms | `session.ts:1937` | identity switch Welcome | |
| (literal) | 256 | `session.ts:908` | queued signals while disconnected | |
| `TRANSPORT_PREPARE_MS` | 20000 ms | `transport.ts:16` | pair connect + room data lane (Browser) | Q2 |
| `DISCOVERY_TIMEOUT_MS` | 20000 ms | `transport.rs:32` | pair attempt (core) | Q2 |
| `REQUIRED_RETRY_MS` | 5000 ms | `transport.rs:33` | retry after a failed attempt | |
| `SCREEN_PREPARE_MS` | 20000 ms | `publication.rs:9` | one route operation | |
| `QUALITY_EVIDENCE_MS` | 5000 ms | `publication.rs:11` | freshness of `switch_ready` | comment: "Same lifetime as the existing viewer-quality evidence contract" |
| `VIEWER_QUALITY_EVIDENCE_INTERVAL_MS` | 2000 ms | `src/shared/protocol.ts:5` | Browser renewal of quality evidence | interval, not a lifetime |
| `REQUIRED_REPAIR_MS` | 5000 ms | `room.rs:20` | room repair wake | |
| (literal) | 5000 ms | `file_delivery.rs:345` | deferred file pull | unnamed |
| (none) | — | `watch_delivery.rs` | peer watch read | no deadline; Q4 |
| `DECODED_FRAME_PROOF_INTERVAL_MS` | 100 ms | `decoded-frame-proof.ts:1` | proof polling | deadline left to the route owner (comment `66`) |
| `BUDGET_SAMPLE_MS` | 500 ms | `browser-encoding-pool.ts:41` | pool stats interval | |
| `LOCAL_CONNECTION_TIMEOUT_MS` | 8000 ms | `browser-encoding-producer.ts:17` | producer loopback connect | |
| `SOURCE_LIST_TIMEOUT_MS` | 8000 ms | `app-link.ts:26` | App capture-target list | only App request with a timer |
| `SHORTCUT_ACTION_MAX_AGE_MS` | 1000 ms | `app-link.ts:27` | stale voice shortcut | |
| `WATCH_MEDIA_RESPONSE_MS` | 5000 ms | `watch-media.ts:286` | probe fetch / iframe command | |
| `PEERTUBE_STARTUP_MS` | 20000 ms | `watch-peertube-media.ts:5` | PeerTube embed setup | |
| (literal) | 10000 ms | `watch-resource.ts:65` | service worker control | |
| (literal) | 1000 ms | `watch-playback.ts:89` | viewer align interval | |
| (literal) | 64 | `remote.rs:359` | pending replies per binding | count bound, no time bound |
| (literal) | 32 | `watch-bytes.ts:73` | pending peer watch reads | |
| (server, not mapped) | 5 s heartbeat, 20 s idle, 1 s expire tick | `channel-server/src/domain.rs:521`, `547`, `853` | server-side detection and clock | adds up to 20 s before `RECOVERY_MS` starts |

## What was measured, and what was not

- No recorded measurement of any lifetime in this area was found. I did not
  search `docs/verification-status.md` or the research measurement logs for
  lifetime timings.
- Tests exist and pin some behavior (read, not run): the Browser preparation
  deadline keeps a connected PC and reports `room_data_state:false` at 20 s
  (`tests/channel-session.test.ts:9878-9917`); a new-identity join that loses
  its socket retries with the saved credential (`957-992`). Core unit tests
  assert route deadlines (`room.rs:2970`, `4503-4568`) and discovery expiry
  (`transport.rs:1352-1466`). I did not check what fraction of the paths in
  the tables is tested.
- Nothing measures how often the two recovery clocks or the two pair clocks
  disagree in practice.

## Questions for the reviewer

**Q1. The session recovery window is two timers on two clocks with copied values.**
Code: the Browser drops its session 20 s after its own `onclose` or after a
manual `reconnect()` (`session.ts:3798-3806`, `3712`), then joins with no
session id (`499`, because `view.sessionId` is null after `3805`). The core
resumes only within `RECOVERY_MS` of the server's own disconnect stamp
(`identity.rs:290-292`, `391-398`), and the Server may need up to 20 s of
idleness before it stamps it (`domain.rs:547`, not mapped). Smallest
scenario: the Browser's network drops; its socket closes at t=0; the server
stamps at t≈20 s; the network returns at t=25 s. The Browser has already
released media, Browser-hosted rooms and voice and joins as a new session,
while the old session, its publications and its room bindings stay live for
others until t≈40 s. Conversely `reconnect()` starts the 20 s countdown even
on a healthy socket. Which side owns the resumption decision, and should the
Browser's deadline derive from the core's value rather than repeat it?

**Q2. One pair attempt is bounded by two 20-second timers.**
Code: the core starts `DISCOVERY_TIMEOUT_MS` at `start_discovery`
(`transport.rs:418-430`) and expires the attempt (`798-816`); the Browser
starts `TRANSPORT_PREPARE_MS` when the plan reaches it (`transport.ts:145`)
and on expiry reports `link_state:failed`, which the core turns into a retire
with a retry delay (`channel.rs:369`, `transport.rs:818-835`). Usually the
core fires first. For a recovering pair the core has no pending discovery
(`transport.rs:172-189`) and only the Browser timer bounds it. The Browser
timer also bounds the room data lane after connection (`357-363`), which the
core bounds separately with `REQUIRED_REPAIR_MS`. Is the Browser deadline a
second owner of the same wait, or a distinct wait that should be named as
such?

**Q3. The core's pending room replies have no deadline, and a code path never answers.**
Code: each request to a room host occupies a slot in `Binding.replies`
(`remote.rs:376-378`, cap 64 `359-361`), released only by the host's output
for that revision or by the binding ending (`channel.rs:2036-2087`,
`remote.rs:200-219`). The Browser requester gives up after 10 s
(`session.ts:941`) but the slot stays. A path that produces no output:
`RoomHost::finish` takes `pending` (`host.rs:2013`) before the attachment
result check that can return `invalid_file_operation` (`2014-2025`); the
adapter's `abort` then fails with `no_room_operation`, the dispatch promise
rejects (`room-host.ts:388-391`), `BrowserHosting.input` only reports locally
(`browser-hosting.ts:75-77`), and the room's state change is not rolled back
(`before` is dropped). Smallest scenario: a `FileOffer` or `FileReceive` whose
history result is not an `Attachment` variant; I did not establish whether the
Browser adapter (`attachment_result`, `room-host.ts:491-494`) can produce one,
so this path may be unreachable today, but nothing at the domain would bound
it. A Native host that never answers is the other case (companion pass).
Sixty-four such leaks make the room answer
`room_busy` until it re-binds. The same shape exists for route wakes: a room
with an unanswered `RouteWake` is never woken again (`channel.rs:1351-1357`).
Should a pending reply carry a deadline at the domain, or should the host
adapter always answer?

**Q4. Peer watch reads have no deadline anywhere; file reads do.**
Code: for peer watching the HLS loader is told the reader owns the deadline
(`session.ts:3046`, `watch-hls-loader.ts:46-47`, comment: "Their lifetime
follows the player and room path"). `WatchBytes.read` has no timer
(`watch-bytes.ts:70-90`) and the core `WatchDelivery` API takes no time at all
(`watch_delivery.rs:158-298`). File delivery, built on the same transit, has a
core-owned 5000 ms deadline for a deferred pull (`file_delivery.rs:345`,
unnamed) driven by one Browser timer (`attachments.ts:156-163`). Smallest
scenario: the relay keeps its pair and plan but its upstream source read
stalls; the viewer's fragment request waits until the player closes, holding
one of 4 loader slots and one of 32 read slots. Is "follows the player and
room path" the intended bound, given the canon's "every attempt ends in
success, bounded waiting or a clear failure"?

**Q5. The session's retirement paths stop App captures in different orders.**
Code: on `close()` (also page unload), `releaseHosts(true)` closes the App link
and clears `this.app` (`session.ts:3827`, `1158-1160`) before `releaseMedia`
calls `this.app?.stopCaptures()` (`3834`, `3740`), which is then a no-op. On a
Welcome for another session and on the recovery deadline, `releaseMedia` runs
first, so explicit `stop_capture` requests are sent before the link closes
(`547-548`, `3803-3804`). Doc: "A Browser's local App control connection
ends: End that connection's Native activities" (`docs/research/channel-network-design.md:857`),
so the App is a second ender. Which is the owner of a page's App captures, and
should the three paths share one ordered retirement?

**Q6. A host's brief signaling drop cancels local work the authority keeps.**
Code: the core keeps a binding through the host's recovery window and keeps
showing publications and watch activities to known sessions with
`available:false` (`channel.rs:2096-2103`, `remote.rs:407-417`,
`host.rs:529-534`). The Browser treats `!available` as retirement for: every
source selection in that room (`session.ts:659-661`), pending watch candidates
(`741-744`), binding-scoped requests (`775-780`) and readings (`1329-1331`).
Smallest scenario A: the user is in the OS screen picker (`startScreen`
awaiting `captureBrowserSource` `2497`) when the room host's socket drops for
2 s; the selection is aborted and the granted capture is discarded. Scenario
B: `joinWatchMedia`'s embedded path places one player in both
`pendingWatchPlayers` and `watchPlayers` (`3069`, `3081`, removed from pending
only at `3087`); the pending loop closes it (`2917`) while the watch-player
loop keeps it because the activity is still listed (`761`). `resumeWatches`
then skips it (`2653`), and the closed player stays visible until the activity
or subscription disappears. Should availability retire Browser lifetimes, or
only the binding change?

**Q7. A new-identity request becomes the old identity after one socket retry.**
Code: `joinAsNewIdentity` calls `close()` and `connect(undefined, true)`
(`3716-3719`); `close()` keeps `credential`; the retry timer calls
`connect(acceptWelcome)` without `newIdentity` (`538`), so the retry joins
with the saved credential (`490`). Test: `tests/channel-session.test.ts:957-992`
asserts exactly this. `joinAsNewIdentity` returns `void`, so nobody learns
the request was dropped. Is this the intended contract, and where should the
outcome be reported (ADR step 7)?

**Q8. The voice publication has three holders and is ended from both sides.**
Code: voice keeps `intent.publicationId`; the session keeps the capture in
`local` (shared with voice by reference, `session.ts:260`); `ChannelMedia`
keeps a mirror `local` with the stream (`media.ts:46`). Voice ends it through
`session.retire` (`voice-participation.ts:128`, `139`, `199`, `277`, `330`);
the session ends it itself when the authority drops the publication
(`session.ts:681-687`) or `publish` fails (`2392`) and then notifies voice
(`3757`); `releaseMedia` clears all three without `retireCapture`
(`3744-3748`). The microphone's own ended callback walks the session map
(`voice-participation.ts:395`, `401`). ADR-0015 says the session keeps local
publications; is a publication with these three writers one lifetime with one
owner?

**Q9. A Browser screen's paused state has four writers.**
Code: `share.paused` (`2585`, `3618`, `3337`, `3580`), `ChannelMedia.local.paused`
(`media.ts:92`, `101-106`), track `enabled` via `setMediaPaused`
(`session.ts:693-694`, `2587-2588`, `3619-3620`) and the authority's
`publication.paused`. `applyState` prefers `share.paused` over the authority
(`692`) and `reconcileLocalMedia` re-sends `set_paused` when they differ
(`859-860`). Which one is the fact, and which are projections?

**Q10. Three coalescing loops check the same share with different predicates.**
Code: `setSourceMicrophone` checks `share ∈ screenShares.values()` and local
identity or `app === app && app.screens.has(id)` (`3393-3394`);
`setScreenQuality` checks `screenShares.get(roomId) === share` and local
identity or `app === app && captureId` equality (`3451-3452`);
`setSourceAudio` checks only `share ∈ values` (`3513`) plus local identity
inside (`3525`) and App identity (`3531`). Smallest scenario: a Native capture
is replaced by another Native capture for the same publication (new
`captureId`) while a microphone change is pending; the microphone loop's
predicate still holds and applies the change to the new capture, the quality
loop's would abort. ADR step 4 moves these loops; should they share one
currency predicate?

**Q11. Reconciliation reads the view, a projection, as the previous authority state.**
Code: retirement edges and inputs read `this.view.state` after it has been
filtered by local intent (`projectActivity` `3765-3787`, `projectWatches`
`3789-3796`): subscription-removed edge (`747`), activity-removed edge
(`762`), byte-source edge (`754`), successor joins (`716`, `807`),
playback-error comparison (`732`); and the pending lock `view.pending`
(`730`, `763`, `596`, `1225`, `1240`, `2873`). `wantedReadings` reads
`view.ownedScreens` (`1311`); `ensureMessage` reads `view.messagesByRoom`
instead of `RoomHistory` (`1556`, `1560`). Interaction sessions, which are
resources, live in the view map and are closed from it (`1398-1407`), and
`patch()` mutates `watch.playbackError` while building the view (`399-402`).
Smallest scenario for `747`: the viewer's player switches mode
(`joinWatchAndSyncClock` sets `player.mode` before the request, `2636`), the
projected previous state drops the subscription, and an authority removal in
that window is not seen as an edge.

**Q12. Several waits have no bound and no abort.**
Code: App requests have no timer except the 8 s target list
(`app-link.ts:473-482`, `584`), and `waitReady` waits on `ready` with no timer
when the caller passes no signal (`521-535`); `connectApp` is called without a
signal by `startNativeScreen` (`3560`), `startExternalScreen` (`3294`),
`prepareWatchPage` (`2703`), `nativeSources` (`3268`). Smallest scenario: the
App accepts the socket and never answers `hello`; `screen:${roomId}` stays in
`view.pending` and the room cannot start another share. `commitExternalScreen`
waits on a view subscription with no timer or abort (`3310-3318`); each
`prepared` event starts another waiter and all but one end in a swallowed
`operation_pending`. Engineering: "abort the owner's waits instead of awaiting
them, and bound late work" (`docs/standards/engineering.md:309-312`).

**Q13. Failures with no waiting caller go to the global slot.**
Code: a failed room reading (`browse`) is shown as a global error and the
reading is dropped (`session.ts:1367-1372`); Browser hosting restore, binding
and dispatch failures (`583-585`, `browser-hosting.ts:56`, `76`); voice
processing failure (`voice-participation.ts:401`); App capture failure
(`session.ts:1186`); `deleteRoom` both throws and writes the slot (`2223-2225`,
`2230`); `ChannelShareControl` deliberately routes an unreachable result to
the banner (`ChannelShareControl.tsx:223-226`). ADR-0015 step 2 removes the
slot for actions; which owner receives these, which are not action results?

**Q14. Browser hosting has two close paths.**
Code: `retire()` chains closes into `cleanup`, which `restore()` awaits before
opening rooms (`browser-hosting.ts:97`, `203-206`); but `restore()` and
`replace()` also `await hosted.host.close()` directly (`108`, `119`, `121`,
`132`, `146`, `177`), outside the chain. Doc (class comment `27-31`): "the
closing of retired hosts, which it awaits before it opens rooms again".
`register()` leaves the host in `rooms` when `current()` throws after
`summary()` (`164-166`); a later `restore` picks it up. Low severity; is one
close path enough?

Lower-severity observations (no question needed unless the reviewer wants one):
an embed or page is closed twice on a failed commit (`2419-2420` and
`3026-3028`, `2796`), harmless because both closes are idempotent
(`app-link.ts:223-225`, `watch-youtube-media.ts:209-214`); a failed pair stays
in `ChannelMedia.peers` until the next snapshot and `resync` re-reports it
(`media.ts:215-221`, `284-285`); `activateWatchOwner` leaves `page.onSharePicker`
set after the player retires (`3194`), guarded by its own identity check;
`missingProfiles` never expires within a session (`203`).

## ADR-0015 remaining steps against this map

- **Step 1, `RoomReader` per binding** would own: `readings` and their
  `ready`/`history`/`followLatest`/interaction fields (§3), `readingRooms`,
  `histories` and their pages, the interaction sessions now held in
  `view.interactionsByRoom`, `historyChannel`, and the three request walks
  (`641-646`, `775-780`, `1383-1386`). It would leave: the request correlator
  itself (by decision), `outgoingMessages` (unless "optimistic updates keep
  their operation identity" moves it), `profileLoads`/`missingProfiles`,
  `readMarkers`, `publicationReactions`, and the `browse` failure report (Q13).
- **Step 4, `Stage` per room** would own: `sourceSelections`, `screenShares`,
  `watchPlayers`, `pendingWatchPlayers` and the three per-share loops (Q10).
  It would leave, unless widened: the `local` map and its `ChannelMedia`
  mirror (shared with voice, Q8), the paused-state writers (Q9),
  `waitingWatchPages` and `declinedSources` (successor following spans screen
  and watch and the room's handoffs), `captureLifetime`, the
  `commitExternalScreen` wait (Q12), and the App-side capture leases in
  `ChannelApp` (Q5).
- **Step 5, `ScreenWatches`** would own: `watching` with its `query`, `retry`,
  `operation`, `helperSessionId`, `syncAppWatching`, and the four
  `playbackError` writers (§8). It would leave: `declinedSources` for screens,
  `nextScreens` successor following in `applyState` (`707-708`, `832-837`),
  `localNativeEndpoints`, `ChannelInput` endpoints closed by `retireWatch`, and
  `ChannelMedia`'s per-input `failed` state that `screenPresentation` sets.
- **Step 7, identity replacement in `useChannel`** would own: `identityGeneration`,
  `connectBackupIdentity` with its 10 s timer, `admitBackupIdentity`'s
  rollback closure, `restoreDomainBackup`'s close/start, and
  `joinAsNewIdentity` (Q7). It would leave: `credential` and `ownerBootstrap`
  mutation inside the session, the retry timer's captured `acceptWelcome`, and
  the single `useState` session that dialogs hold (the ADR names this).
- Not in any remaining step: the domain socket and its two timers (Q1), the
  App link and its requests (Q5, Q12), `ChannelMedia`/`ChannelTransport` (Q2),
  attachments and watch bytes (Q4), `forwardingBudget`, the conversation
  signer, feedback audio, and the session retirement ordering itself (Q5).

## Not read

Read in full: `session.ts` (all 3,839 lines), `voice-participation.ts`,
`browser-hosting.ts`, `app-link.ts`, `media.ts`, `transport.ts` (Browser),
`microphone-input.ts`, `host-audio.ts`, `capture-stream.ts`,
`sender-video-track.ts`, `browser-encoding-pool.ts`, `viewer-audio.ts`,
`decoded-frame-proof.ts`, `watch-playback.ts`, `watch-bytes.ts`,
`conversation.ts`, `use-channel.ts`, `use-stage-picture.ts`,
`panel-window.ts`, `use-watch-page-slot.ts`, `watch-hls-loader.ts`,
`remote.rs`, ADR-0015, `canon.md`, the cited parts of `engineering.md`.

Read in part: `browser-encoding-producer.ts` (20-229), `attachments.ts`
(40-289, 490-786), `room-history.ts` (1-80), `watch-media.ts` (84-383),
`watch-page-media.ts` (86-160), `watch-resource.ts` (30-121),
`watch-youtube-media.ts` (200-215), `ChannelMedia.tsx` (150-724),
`ChannelShareControl.tsx` (165-244, 340-449), `room-host.ts` (305-530),
`publication.rs` (1-260, 700-991), core `transport.rs` (1-200, 400-460,
770-850), `channel.rs` (1-75, 200-480, 828-1002, 1085-1091, 1336-1525,
1940-2103), `identity.rs` (250-410), `host.rs` (440-590, 888-914, 1561-1590,
1821-1860, 1990-2080), `room.rs` (1-120, 900-1080, 1390-1480, 1620-1670),
`lib.rs` (560-650), `file_delivery.rs` (325-354), `tests/channel-session.test.ts`
(955-992, 9875-9920), `docs/research/channel-network-design.md` (490-505,
850-860).

Searched only (grep for timers, listeners, controllers, closes): `ChannelStage.tsx`,
`ChannelVoiceDock.tsx`, `ChannelConversation.tsx`, `ChannelAttachment.tsx`,
`ChannelRoomControls.tsx`, `ChannelRoomTool.tsx`, `ChannelCouch.tsx`,
`src/client/ui/*`, `feedback-audio.ts`, `input.ts`, `file-store.ts`, the
other `watch-*.ts` files, `camera-previews.ts`, `video-frame-proof.ts`,
`watch_delivery.rs`, `forwarding.rs`, `channel-browser/src/lib.rs`, the core
constant list.

Not read: `routes.rs`, `channel/discovery.rs`, `file_room.rs`, `history.rs`
beyond constants, `conversation.rs` beyond constants, `storage.rs`,
`connectivity.rs`, core `input.rs`, `backup-archive.ts`, `hosting-api.ts`,
`lib/room-interactions`, `viewer-presentation.ts`,
`browser-encoding-output.ts`, `candidate-quality-probe.ts`, `ChannelPage.tsx`
beyond three greps, the Native runtime and Server (companion pass), and
`docs/verification-status.md`.
