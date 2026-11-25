# Lifetimes in the Native runtime and the Server/App service

Mapping pass, read-only, branch `refactor/claude-review`. Every statement is
**code** (read in this checkout) unless marked **doc** (a document claims it) or
**measured** (a recorded measurement). Paths are relative to
`prototype/` unless they start with `docs/`. "Native" = `channel-native/src`,
"Server" = `channel-server/src`, "Core" = `channel-core/src`.

## Summary

**Shape.** Native lifetimes form one tree per hosting session:

```
process (Server main / App serve / Android piik-app thread / Windows Core thread)
 └─ run_host future (session.rs:732)                one per (site, channel, user) in the App; one in the Server
     ├─ WebSocket carrier (drive/connected)          reconnects forever, 1 s apart
     │    └─ reader future (read_messages)           dropped with the turn
     ├─ Live (session.rs:289)                         one per domain session id
     │    ├─ RoomTurns: HostedRoom × n               SQLite + .lock file each
     │    └─ NativePeers (peer.rs:217) ─ Driver task (peer.rs:830)
     │         ├─ transport::Runtime task (transport.rs:489)  one pump for all engines
     │         │    ├─ Engine per pair (str0m Rtc) + discovery/TURN/host-refresh tasks
     │         │    └─ UDP reader task per socket
     │         ├─ Pair × n  (dc/bulk/input tasks, Reader tasks, Outputs, Mapping)
     │         ├─ preparation::Pending × n (UDP preparation task, 5 s)
     │         ├─ local_producers: Producer (capture task + platform capture thread
     │         │      + encoder threads; Windows: encoder child process per encoding)
     │         ├─ capture_audio: AudioProducer (mixer task + audio capture threads)
     │         ├─ derived: decode/re-encode producers
     │         └─ Files, Watches, input::Inputs
     ├─ opening: OpeningRoom (pending registration/restore/create waiters)
     ├─ pending_captures: PendingCapture (page waiters keyed by request id)
     └─ snapshot_job: spawn_blocking backup snapshot
```

The page side of a capture is a set of *control handles* (`CaptureLease`,
`CaptureAudio`, `ExternalLease`, `input::Source`) held by the App's per-page
control-socket actor (`connection`, app.rs:1645). Dropping a handle only
*signals* stop; the Driver is the single joiner of every producer, encoder and
pair. Stop signals have many writers (page, room projection, replacement, the
producer itself, shutdown); joins have one owner (the Driver, or the Runtime
pump for engines). This "many stoppers, one joiner" pattern is used
consistently in Native.

**Currency.** Native checks currency by: room binding id
(`HostedRoom::binding`, `CaptureScope.binding_id`, `capture_binding`), the
domain session id (`live.session`, `host_session_id`), pair id membership in the
current snapshot (`current()`, session.rs:3030), engine instance id
(`(pair, instance)` in every transport command, transport.rs:574-605), data
channel tokens (`p.dc/bulk/input` token, peer.rs:2545), producer/output ids
(`output_failed`, peer.rs:1465-1475), watch-channel identity
(`same_channel`, peer.rs:1891), request ids for room replies, and `oneshot`
closure (`result.is_closed()`) for abandoned waiters. The Core issues a new pair
id per physical attempt (Core transport.rs:791), which is what makes pair-id-only
events safe.

**Ends.** Most acquisitions have Drop guards that signal and the owner joins
asynchronously. Bounded steps: WebSocket write 5 s, Leave 5 s, encoder child
1 s then kill, HTTP drain 5 s, tunnel startup 30 s, preparation 5 s. Unbounded
steps: the Driver's close (thread joins of capture/encoder workers), every
App/Server host stop, App `hello`, and Native capture readiness without the
Auto-H264 proof. **doc**: "An isolated shutdown stall remains unexplained"
(`docs/verification-status.md:114`).

**Main findings for the reviewer** (detail in Questions): two deadlines bound
the same connect wait (Native 5/20 s, Core 20 s); bounded event queues turn a
burst into connection retirement in three places; shutdown and several drop
paths perform unbounded or synchronous joins on async threads; the Launch task
stops and restarts App hosts on behalf of the App registry, holding the registry
lock while it does; cloudflared and several temp directories can outlive a
crashed App; failed key releases are abandoned at shutdown; Unpublish of a
local publication is decided by two rules; App, Server and domain restores use
three different scratch-admission policies; and the Windows App ends hosting
when its window closes while other platforms do not.

---

## 1. Native hosting session (`channel-native/src/session.rs`, 3138 lines)

### 1.1 Lifetime rows

| Lifetime (declared) | Owner today | Started | Ended (all paths) | Waiters answered? | Currency check |
| --- | --- | --- | --- | --- | --- |
| Hosting session future `run_host` (732) | Caller: App `Host.task` (app.rs:339), Server `NativeService.task` (lib.rs:95) | `tokio::spawn(run_host(..))` | `stop` future resolves (854, 913, 938, 1081); `drive` error (857 `hosting_control_closed`, 1069 admission failed, 1250 `owner_mismatch`, `native_peer_stopped` 1055/3056); recovery expiry does **not** end it. Panic → JoinError seen by `host_task` (app.rs:399-407) or `serve_server` (lib.rs:180). | On exit: `fail_pending_requests("hosting_stopped")` (755), `release()`, `ready = Err` (762-764), every `opening` failed (765-767). | — |
| Signaling WebSocket (`Socket`, 48) | `drive` loop local | `connect_async_tls_with_config` with 5 s timeout (847-850) | Connection error → 1 s delay, retry forever (909-921); `connected` returns `Ok(false)` on carrier loss (Step::Work Ok(false), SocketError 1100-1102); on stop or error: `release()` then `leave()` (901-903: Leave + wait Ack/Close, 5 s, 3122-3138). | Requests during reconnect get `unavailable` (858, 917, 1006). | — |
| Reader future `reading` (953-970) | `connected` select | per connection | Ends when `connected_messages` returns (select drops it). After its stream ends it publishes `carrier_end` and parks (`pending`, 969) so queued frames are still processed. | — | `carrier_end` time feeds recovery (1086-1091). |
| Raw backlog budget (`Semaphore` 4 MiB + header, 69-71; `Incoming._budget`, 57-60) | reader → event processing | per text frame | Permit dropped after `event()` processes the frame (999-1001). Exhaustion → reader error `native_signaling_backpressure` (80, 86) = carrier end. | — | — |
| `Live` (289) | `Session.live` | Welcome with a new session id (1272-1397) | `release()` (784-817) from: recovery expiry (855, 914, 940, 1095), non-resumed Welcome (1273), stop/error exit (901, 756). Idempotent (`live = None`). | `room.disconnected()` clears the snapshot (199-201) so `InputAuthority::is_current` turns false. | Resume iff `live.session == session_id` (1267-1270). |
| Recovery deadline `Session.recovery` (306) | `Session` | Set to `now + RECOVERY_MS` when the carrier ends with Live present (906-908) or from `carrier_end` (1086-1091, 3072-3091) | Cleared by Welcome (1066, 1417) or `release()` (811). Expiry → `release()`. | — | Carrier end can only *shorten* it (`min`, 1089, 3079). |
| `NativePeers` (peer.rs:217) | `Live.peers` | `NativePeers::with_input` (1374-1383) | `release()` → `peers.close()` (806). No Drop impl: if dropped unclosed, Driver sees `cancel` sender dropped (`changed()` errors) and runs `close()` detached. | — | Driver commands filtered by `current(pairs, ..)` (212, 3030). |
| `HostedRoom` × n (hosted_room.rs:18) | `RoomTurns.rooms` | Welcome (1303, 1349), `open_room` (2408-2417), `RoomCreated` (1580), restore (2660-2667) | Removed on: bind failure + `HostStop` (1544-1558), registration error (1790, 1748), deletion (1654, 2344), ambiguity (1404), `state()` retain when bound and absent from directory (2785-2790), Live drop. Lock file released by Drop of `_file_owner`. | — | `binding() == Some(binding_id)` on every dispatch (156, 1647-1648, hosted_room.rs:149-151). |
| `OpeningRoom` waiters (323-360) | `Session.opening` keyed by room id | `register_room` (2706-2743), `restore_room` (2586), Welcome for creates (1340) | Ack (1605-1631), Error (1737-1797), HostBound marks copy published (1534-1543), non-resumed Welcome fails Register entries whose room vanished (1409-1414), `release()` fails **non-Register** entries only (790-802), run_host exit fails all (765-767). `OpeningWork::Create` failure is only logged (357). | Register replies survive disconnect and recovery expiry; they are answered on Ack after resume, on the next Welcome, or at exit. | Ack/Error matched by `request_id`; stale `HostBound` for `previous_binding` ignored (1523-1529). |
| `PendingCapture` waiters (481-547) | `Session.pending_captures` keyed by request id | `prepare_capture`/`authorize_input`/`prepare_external`/`commit_capture`/`send_capture_command` (1831, 1857, 1888, 2038, 2232, 2276) | `RoomReply` (1679-1736), `Error` with request id (1770-1776), `state()` when `result.is_closed()` or binding changed (2793-2809), disconnect `"disconnected"` (886), `release()` `"hosting_unavailable"` (789), exit `"hosting_stopped"` (755). | Yes on every path above; a reply never received while connected waits until the page closes its receiver and the next `state()` (no timer). | `RoomReply.room_id == pending.room_id()` (1685-1689); binding re-read at `prepare_source` (1941-1951). |
| `SnapshotJob` (369-384) | `Session.snapshot_job` | `snapshot_room` → `spawn_blocking` (2527-2551) | Completes; cancelled flag set by `release()` (786-788) and by Drop (380-384); joined by `release()` (812-814) or before the next snapshot (2497). Second request while running → `room_busy` (2493-2495). | Result sent only if not cancelled and receiver open (2547-2549); otherwise the sender is dropped (waiter sees closed). Temp dir `piik-backup-*` (2534) dropped with `RoomSnapshot`. | Cancel flag + `result.is_closed()` polled by Core snapshot (2542). |
| Scratch permit `RestoreRoom.scratch` (393-394) | rides in the request | Server `domain.room_restore.try_acquire_owned` (domain_backup.rs:109, 123) | Dropped when `install_room_backup` returns (2596-2704), or when the request is failed/unavailable. | — | — |
| Scratch permit in `HostCommand::CreateCopy` (611-615) | session match arm | domain_backup.rs:161-165 | Bound as `_scratch` (1038) → dropped at the end of that match arm, i.e. after `open_room` installs and **writes** `HostRegister`, before the registration Ack. | — | — |
| Service admission ack (`ServiceAdmission`, 318-321) | Server `NativeService` task | Welcome (1419-1434) | Ack sent if `register_service` succeeds (lib.rs:112); dropped ack → `service_registration_closed` error → run_host ends → Server ends (lib.rs:180-181). | — | — |
| `Hosting.ready` watch (702) | Session writes, App `hello` reads | `None` at each connect (824) | `Some(Ok)` when every hosted room is bound (2312-2325); `None` on disconnect/release (772-776, 885); `Some(Err)` at exit (762-764). | App `hello` waits on it with no bound (app.rs:268-277). | — |

### 1.2 Ordering inside `run_host` exit (code, 754-768)

1. `drive` returns (stop or error); on the in-connection path `release()` and
   `leave()` already ran (901-903).
2. `fail_pending_requests("hosting_stopped")`.
3. `release()` again (idempotent): ready=None, cancel snapshot, fail pending
   (`hosting_unavailable`, already empty), fail restore/create openings,
   `room.disconnected()`, `peers.close().await`, `live=None`, join snapshot.
4. `ready = Some(Err(..))`; fail every remaining opening with the error.

`release()` closes peers (pairs, producers) **before** `leave()` sends Leave on
the still-open socket (901-902), so the domain is told last.

---

## 2. Native peer driver (`peer.rs` 3771, `peer/*`)

### 2.1 Lifetime rows

| Lifetime (declared) | Owner | Started | Ended | Waiters | Currency |
| --- | --- | --- | --- | --- | --- |
| Driver task (`NativePeers.task`, 220; body 830-1082) | `NativePeers` | `with_input` | `cancel` changed (880, 1075), inputs closed (883), transport pump stopped → Err (882), `retirement_failed` received → Err (1074). Every exit runs `d.close()` (1080). | Each `Input` carries a oneshot; a cancelled turn drops it (caller sees `RecvError`, mapped to error by the caller). | — |
| Driver turn (`work`, 892-1071) | Driver loop | each select arm | `biased` select with `cancelled.changed()` (1072-1077) can drop a turn at any await. | as above | — |
| `transport::Runtime` pump task (transport.rs:163-172, 489-645) | `Driver.transport` | `Runtime::new` (831) | `close()` sends Stop then joins (1051-1054); Drop aborts (1062-1066, cleanup of engines then does **not** run); returns immediately if the fixed Server UDP lease is unavailable (491-494). Teardown: gateway mapping close, every `Engine::close`, abort+join every reader (634-644). | `Transport::call` replies via oneshot; pump end → `"transport retired"` (1193). | Every command keyed by `(pair, instance)` (574, 584-586, 604-605). |
| Engine (str0m `Rtc`) per pair (428-474) | Runtime pump (`engines` map) | `Command::Add` (528-562) | `Command::Remove` from `Transport::close` (585-599, 1685-1693) or pump end. `Engine::close` (1870-1900): stop host refresh and join, abort+join discovery and TURN setup tasks, close TURN, `rtc.disconnect()`, drain, resolve local-input `ended`. | `EventTarget::Local.ended` resolved Ok if unset (1894-1899). | instance id |
| UDP reader task per socket (136-146, 1067-1132) | Runtime `sockets` | `add_reader` on Add/TurnReady/fixed sockets | aborted+joined on owner removal or retired TURN (514-520, 594-598) or pump end; Drop aborts. | — | `Datagram.owner == (pair, instance)` (604-616). |
| Discovery / TURN setup / host-refresh tasks (444, 452, 411-427) | Engine | Add (558-559), `add_engine` (1031-1040) | `Engine::close`; host refresh also stops on first Connected/Failed/Closed (2053-2063). | — | `call` uses instance. |
| Gateway `Mapping` (mapping.rs:17-99) — two owners | per-pair `Pair.mapping` (peer.rs:2964-2969) and Runtime shared `gateway` (transport.rs:536-553) | first host candidate | `close()` aborts watcher, joins, `client.deactivate()` (85-92): from `close_pair` (3727-3739), Runtime Remove when no shared engine remains (589-593), finished-replacement (537-540), pump end. Drop only aborts (95-99), no deactivate. | — | — |
| Pair (679-709) | `Driver.pairs` | `create_pair` (2079-2159) from `update` or `prepared` | One path: `retire_pair` (2708-2732) → `close_pair` spawned into the single `retiring_pair` slot, then joined in the same turn; callers: projection removed (2020-2022), `fail` (deadline 2766, peer state Failed/Closed 3008-3017, setup 2071/2281, signaling 1018, event error 1048, terminal DC 3042), Driver close (1288-1290). `close_pair` (3721-3755): mark Closed, cancel mapping, abort dc/bulk/input/reader tasks, `pc.close()`, join tasks, `data.close()`, close outputs. | Join failure → `retirement_failed` → Driver exits with error, closing siblings (2727-2731, 1074). | Pair id ∈ current plans (`admitted`, 2012-2031); Core issues new ids per attempt. |
| Pair deadline `Deadline::{Connecting, Control}` (711-721) | `Pair.deadline` | Connecting at `create_pair`: 5 s if `UdpPreparation::Available`, else 20 s (2139-2148); Control 20 s when established without an open room DC (2667-2669) | Cleared when room data ready (2645), no rooms or room data failed (2665-2666), on expiry (2762). Checked on each 1 s tick and bandwidth wake (865, 1060-1062, 2742-2769). Expiry: established → `fail_room_data`; else `fail(ConnectionDeadline)` → `LinkState::Failed`. Overflow flag counts as expiry (2756). | — | — |
| UDP preparation `Pending` (preparation.rs:57-135) | `Driver.preparings` | `update` when `UdpPreparation::Required` (2035-2056) | Task timeout 5 s (76-91); peer refusal aborts (107-115); `close()` aborts+joins (131-134) from `update` (2059-2061), `retire_pair` (2709-2711), Driver close (1268-1270); completion consumed by `preparation::next` (137-146) → `prepared()` creates the pair or falls back to ordinary ICE (2224-2283). Process-wide `RANDOM_PREPARATIONS` semaphore 2 (44). | Failure sends `UdpSignal::Unavailable` with `try_send` (92-95). | pair id; refusal flag |
| Data channel tasks dc/bulk/input (701-703; spawned 2553-2626) | `Pair` | `install_dc` | Close event, `fail_room_data` (2686-2690), `Event::Dc(false)` (3036-3040), `Event::Bulk` (3057-3061), `close_input` (1426-1430), room removal (2194-2199), `close_pair`. Always abort → await → `dc.close()`. | — | per-channel `token` checked on every event (3030, 3054, 1420). |
| Reader tasks per received track (722-727; `spawn_reader` 3707-3719) | `Pair.tasks` | `track()` | `source_ended` (2822-2825), `apply_pair` retired readers (2183-2193), successor replaces old reader (3483-3490), `close_pair`. Reader catches panics and reports `SourceEnded` (3716-3717). | — | `latest[key] == reader`, `remote[stream] == flow` (2805-2817). |
| Output per (flow, kind) (media/output.rs:145-146, close 456-471) | `Pair.outputs` | `refresh_outputs` (3650-3673) | `refresh_outputs` source mismatch (3588-3607), `output_failed` (1465-1487), `fail_flow` on deselected flows (1496-1506), `source_ended` (2830-2840), `close_pair`. close: abort+join task and feedback, `retire_output`. | — | `current.source == source && current.id == output` (1469-1474). |
| Derived (decode → re-encode) producer (media/derived.rs:20-63) | `Driver.derived` | `source_ready` for incoming/external H264 (3517-3545) | `reconcile_producers` when its source is gone (bandwidth.rs:322-331), Driver close (1274-1276). `stop`: drop demand sender, join. | — | key = source id |
| Watch reader registration | Driver `Watches` | `Input::RegisterWatchReader` (907-909) | `RevokeWatchReader` (910-912), `watches.close()` at Driver close (1292). Registration's `retired` = the NativePeers cancel watch (1112-1114), so it retires with the whole Driver, not per resource. | — | — |

### 2.2 Driver close order (code, 1266-1295)

`inputs.close()` → close all preparations → stop derived producers → signal every
local producer, then close (join) each → close every capture-audio mixer → join
`retiring_pair` → `close_pair` every pair → `files.close()` → `watches.close()` →
`transport.close()`. Dependants first, transport last. No step is time-bounded.

---

## 3. Capture, encoding and media producers

### 3.1 Lifetime rows

| Lifetime | Owner | Started | Ended | Waiters | Currency |
| --- | --- | --- | --- | --- | --- |
| `CaptureLease` (peer.rs:230-249) — page control handle | App page `Capture.active`/`pending.phase` (app.rs:1357-1437) | `Driver::prepare_capture` (1651-1701) or retained-audio variant (1597-1646) | Drop → `stop()` (561-565): retire input source, `control.stop()`, system-audio lease stop. `adopt_previous` moves the producer's handles to a successor lease (539-549). | `ready()` = first encoded AU then required audio (501-511); `ended` oneshot carries the producer's final error. | `capture_current(id, selected)` re-checked by Session before commit/edit/pause/transfer (1704-1722; session.rs 2003-2015 etc.). |
| `Producer` (capture) (media/local.rs:141-326) | `Driver.local_producers` (`PreparedSource`, peer.rs:331-337) | `Producer::start` — **synchronously** starts the platform capture inside the Driver turn (local.rs:188-208) and spawns `encodings::run` (245-260) | Stop signal writers: lease drop, `update` (scope not current or publication withdrawn → `retire()`, peer.rs:1994-2009), replacement commit (1797-1805), Driver close (1277-1279), the run task itself. Join: `capture_ended` (1834-1863) when the run task reports `CaptureEnded`, or Driver close. | `ended.send(Ok/Err)` to the lease (1843); `NativeEvent::CaptureEnded` to Session only if no other live producer for the publication (1850-1862). | Producer id (`producer.video`), `selected` flag. |
| `encodings::run` task (media/local/encodings.rs:137-320) | Producer `task` | Producer::start | Control stopped / Driver cancel / settings channel closed / all pumps ended / error. Cleanup: `control.stop()`, finish pending settings request with `capture_unavailable`, stop encodings, stop baseline, `spawn_blocking(capture.stop())` (301-307), fail `ready` if unsent, send `CaptureEnded` unless cancelled (313-318). | `ready` answered on every path (310-312). | — |
| Startup proof deadline (encodings.rs:162-164, 44-54) | `initial()` | Only when `mode == Auto && VP8.supported()` | 4 s timeout on first encoded frame → fallback to VP8 (166-171). Android waits for input first (46-47). Otherwise **no deadline** on the first frame. | — | — |
| Platform capture: Windows WGC thread (capture/windows.rs:48-123) | `Capture` (moved into run task) | `Capture::start` spawns `piik-capture` | `stop()` (joins) via spawn_blocking (encodings.rs:301); Drop finishes and **joins synchronously**. | — | — |
| Linux Portal capture thread + Portal session (linux/source.rs:48-176, 178-209, 354-630) | `Capture` | thread `piik-linux-capture` running `runtime.block_on(run)` on the shared runtime (122-129) | Control stop → `active.close()` closes the PipeWire pipeline and the Portal session (628). Remote-control authorization creates a candidate session and replaces the active one, closing the previous (589-593). Every cancelled `prepare` unwinds through `session.close()` (497-512). Drop joins synchronously (163-176). | Authorization reply answered on every path (549-594). | AbortHandle on authorization (562-565). |
| Android capture thread (android/source.rs:37-121) | `Capture` | `piik-android-source`, MediaProjection via JNI | `frames.stop` + `platform.stop`, then `dispose` (60-61); Drop joins synchronously. | — | capture id passed to Java (44, 51). |
| Windows encoding supervisor thread + child process (capture/process.rs:163-582) | `Encoding` | `Encoding::start` spawns thread `piik-encoding-process` with its own current-thread runtime (190-209); `child()` spawns `current_exe --piik-encoder-worker` in a new Job with `KILL_ON_JOB_CLOSE` (369-386, job.rs) | Stop → writer sends Stop, child exits; else wait 1 s then kill (559-568). Restart: device loss once, or hardware-H264 failure → software once (306-334); waits for a new raw frame before replacement (345-356). Drop: stop + **synchronous join** (258-269). Parent death → Job closes → child killed. | `recv()` returns the terminal error once (231-239). | First AU of a replacement must be a keyframe newer than the old child (117-123). |
| Linux/macOS/Android encoders (linux/encoding.rs:91-203, macos/encoding.rs:95-160, android/encoding.rs:101-460) | `Encoding` | in-process thread per encoding | stop + join; Drop joins. No replacement after a runtime failure (no restart code in these files). | — | — |
| `AudioProducer` mixer (media/local.rs:98-139; actor local/audio.rs:226-478) | `Driver.capture_audio` per publication | first `prepare_capture` for the publication (peer.rs:1578-1594) | Stop writers: page `CaptureAudio` drop (peer.rs:276-281), `update` (withdrawn/scope, 1983-1993), external commit (1812-1814). Actor end → `CaptureAudioStopped` → `capture_audio_stopped` → `retire_capture_audio` (join) → `CaptureEnded` if no live producer (1883-1907). Driver close joins (1283-1285). | Every queued request drained on exit (436-441); pending preparation replies `capture_cancelled` (92-97). | `control.same(&owner)` watch identity (1888-1894). |
| Audio inputs (system loopback, microphone) | mixer actor | `prepare_system`, `open_microphone` (333-336, synchronous device open inside the actor) | `close()` = `spawn_blocking(capture.stop())` (489-491) on replace/cancel/stop/end. | Reply per request. | Cancel watch per system lease (`AudioLeaseControl`, 33-47). |
| External (WHIP) producer (peer/external.rs:6-189) | `Driver.local_producers` (`LocalProducer::External`) | `prepare_external` creates a local-input engine in the same Runtime (68, transport.rs:687-751) and spawns `run` | Stop/cancel/peer-closed/video reader end → close transport → `CaptureEnded`. Room retirement sets `room_unavailable` (peer.rs:99-101). No first-frame or connect deadline in Native. | `ready` answered on every exit (176-180). | `ExternalControl` watch (60-102). |
| Preview capture (capture/preview.rs) | App page `previews` | `spawn_blocking` | 2 s first-frame deadline, picker cancel, connection close (**doc** native README:168-173; code not read beyond the spawn). | — | — |

---

## 4. Remote input (`input/*`, `peer/input.rs`)

| Lifetime | Owner | Started | Ended | Waiters | Currency |
| --- | --- | --- | --- | --- | --- |
| `Desktop` executor (input/mod.rs:91-96, 820-828) | App (`App.desktop`, app.rs:180) — one per process, cloned into every Hosting | `Desktop::new` in `serve` (app.rs:479) | `Desktop::close` at App shutdown (app.rs:384): close every source, `retry_releases()` once, shut down gamepad, drop shortcut. | — | — |
| Input `Source` (100-110) | `Inputs.sources` in the Driver + clones in `CaptureLease.remote` | `inputs.source` at commit (peer.rs:1779-1785) | Last clone Drop → `executor.close(video)` (106-110); `retire_capture` on capture stop (432-438, peer.rs:526-528); `Inputs::close`/Drop (peer/input.rs:226-233, 337-343). | — | keyed by producer `video` id; `previous` publication check on replacement (226-234). |
| Grant per controller (`Controller.grant`, 865-879) | `SourceState.controllers` | `grant` (1074-1105) | `release` (1024-1033) via `revoke_all` on policy change, capture retirement, target lost, local stop (`revoke`, 939-953), disconnect of the pair (peer.rs:2990-2992, 2746-2748). | — | grant token string |
| Held keys (`Controller.held`, `Executor.releases`) | executor | key press | `release_holds` sends key-up; a failed key-up is kept in `releases` and retried by `retry_releases` on each 100 ms tick (996-1003, 289-309). The tick is driven by the App serve loop (app.rs:580). | — | — |
| Pending OS permission (`SourceState.permission`, AbortHandle) | executor | Linux RemoteDesktop/shortcut request | `cancel_permission` on replacement, revoke, retirement (851-855). | `input_authorization_cancelled` (397). | AbortHandle |
| Global stop shortcut | `Desktop.1`: Windows hotkey thread (windows_hotkeys.rs:26-109, joins on Drop), macOS polled chord (needs_tick keeps a 100 ms timer while a key is set, 311-316), Linux GlobalShortcuts Portal worker thread (linux_shortcut.rs:39-118) | `set_shortcut` | `Desktop::close`. | — | — |
| Gamepad backend and pads (gamepad.rs:52-180) | executor | `Backend::connect` | `shutdown` at close; pad Drop. | — | — |

---

## 5. Room storage, backup and temporary files (Native)

| Lifetime | Owner | Started | Ended | Notes |
| --- | --- | --- | --- | --- |
| Room `.lock` file (hosted_room.rs:242-256) | `HostedRoom._file_owner` | `lock()` before open/create/install | Released when HostedRoom drops; the file itself is never deleted, including after `discard_unpublished` (166-171) and `delete_data` (173-175). | flock on Unix incl. Android, `File::try_lock` on Windows (222-229). |
| Install staging `<room>.sqlite.piik-room-install` (87-129) | `install` | tempdir in the room directory | Renamed into place (`persist_noclobber`) or dropped; a crashed install is reclaimed by `reclaim_room_install` during discovery when its lock is free (190-212, session.rs:2950-2954). | The only crash-reclaimed temp artefact found. |
| Snapshot temp dir `piik-backup-*` (session.rs:2534) | `RoomSnapshot.directory` | snapshot job | Dropped after export streaming (Server backup.rs:62-69). Not reclaimed after a crash. |
| `forwarding-limit.json` (session.rs:1139-1141) | Session | `NamedTempFile` + persist | atomic replace | — |

---

## 6. Server domain (`channel-server/src/domain.rs` 1076, `domain_backup.rs`, `backup.rs`)

| Lifetime | Owner | Started | Ended | Waiters | Currency |
| --- | --- | --- | --- | --- | --- |
| `Hub` (40-49) incl. `channel.lock` and SQLite | `Arc<Mutex<Hub>>` shared by every `Domain` clone | `Domain::open_with_options` (613-690) | Last clone dropped; comment: "A background room operation can retain the Hub after the listener closes" (45-46). In the App, `Ready` (inside `Launch.progress`) holds a clone until the launch is replaced or closed. | — | — |
| Client WebSocket session (`session`, 472-583) | spawned by axum `on_upgrade` (237-240); not tracked by HTTP drain | upgrade + first message within 10 s (478-485) | Writer ends on close signal (drains queue ≤5 s, 524-531), write failure/timeout (5 s, 275-283), or queue closed; reader ends on 20 s idle (547) or socket end. Then `clients.remove`, `authority.disconnect` (577-582). If the writer ends first, the reader future — possibly mid-`dispatch_request` — is dropped (569-575). | — | `client.close` flag checked before each request (70-76). |
| Socket permit (`sockets` Semaphore `2 * MAX_SESSIONS`, 682; 230-232) | session task | upgrade | session end | 503 when exhausted. |
| Client event queue (64, 502) | Hub `Client` | per session | `Hub::send` `try_send`; **full queue closes the client** (185-187). Conversation replies to a sole recipient wait ≤5 s then close (463-469). | — | — |
| Close signals (`Client.close`) — many writers | Hub | — | queue overflow (186), `effects.close` (195-199), restore (757-759), `close_clients` (877-883), reader end (572). | — | — |
| Room creation waiter (`create_room`, 285-350) | **inline in the client's reader loop** | `CreateRoom` in hosted mode | Native `Open` reply or channel closed (`room_creation_unconfirmed`, 335). Reservation cancelled on error codes other than `room_creation_unconfirmed`/`room_created_connection_failed` (342-346). No timer. | — | — |
| Room deletion waiter (`delete_room`, 352-414) | inline in reader loop | offline hosted deletion | Native `DeleteRetired` reply; storage save. | — | retried deletion verified against the directory (session.rs:2346-2357) |
| Copy creation (`create_copy`, domain_backup.rs:144-256) | **spawned task** after handoff (227-255) | HTTP | Native `CreateCopy` reply; reservation cancelled on error. | HTTP caller may leave; the spawned task still settles the reservation. | — |
| Restore scratch permit (`room_restore` Semaphore 1, 683) | HTTP request → `RestoreRoom.scratch` | `restore`, `restore_existing`, `create_copy` (109-113, 123-126, 161-165) | see §1 | `room_busy` when held. | — |
| Upload staging dir `piik-restore-*` (backup.rs:228-240) | `TempDir` in the upload/stage future | upload | Dropped with the staged snapshot after install; `receive_copy_upload`/`stage_upload` keep the permit until staging returns (161-166, 198-205; test 257-283). Not reclaimed after a crash. Bounded by `available_space / 8` only when a scratch permit is present (231-235). | — | — |
| Domain restore (`RestoreDomain`, 23-27; 272-321) | service loop via `restores` mpsc(1) | HTTP | Service stops Native hosting, `Domain::restore`, restarts hosting (lib.rs:186-213; App app_domain.rs:402-442). | Reply on every branch. | owner credential re-checked under the Hub lock (751). |
| Launch tickets (42, 782-792) | Hub map | `launch_ticket` (60 s) | Redeemed once at Join (52-58), pruned when a new ticket is issued (787), cleared by restore (756). Max `MAX_SESSIONS`. | — | — |
| Expiry clock (852-858) | `serve_with_https` | 1 s interval → `hub.expire()` (Core `Authority::expire`, lib.rs:606-624) | stop | — | — |
| HTTP/HTTPS servers (838-875) | `serve_with_https` | — | stop or one listener ends → `close_clients`, stop HTTP, HTTPS graceful 5 s, await both. WebSocket sessions are not awaited. | — | — |

---

## 7. Server composition (`lib.rs`, `main.rs`)

| Lifetime | Owner | Started | Ended |
| --- | --- | --- | --- |
| `NativeService` (lib.rs:29-124) | `serve_server` | `NativeService::start` (164-171, 200) | `close()` = stop + await (120-123): on stop (179), on HTTP service end (182-184), before domain restore (192). Its unexpected end ends the Server (180-181). |
| Domain service task (173-175) | `serve_server` | spawn | after hosting closed: `stop_domain` then await (216-222). Comment: "Native departure is acknowledged while the domain service is live." |
| Fixed UDP sockets `ServerUdp` | `Arc` shared; Runtime holds a lease for its pump's life (transport.rs:491-498) | `ServerUdp::bind` (main.rs:143) | process |
| Owner-link listener (owner_link.rs) | `main` select arm | bind (main.rs:153) | `main` returns; Unix socket file removed on bind and Drop. `main` races `owner_link::serve` against `serve_server` (158-169): an accept error drops `serve_server` mid-flight. |

Shutdown order (Server, code): signal → `hosting.close()` (Native: release peers,
Leave acknowledged by the in-process domain) → `stop_domain` → close clients,
HTTP drain 5 s → `main` returns, runtime drops remaining spawned tasks.

---

## 8. App service (`app.rs` 5170 and `app_*`)

| Lifetime | Owner | Started | Ended | Waiters | Currency |
| --- | --- | --- | --- | --- | --- |
| App data-directory lock `app.lock` (425-440) | `serve` local `owner` | `serve` start | `drop(owner)` after HTTP stopped (667). | — | — |
| Site `Permission` (113-124) | `Registry.approvals` / `LocalSite` | approval / launch | `revoked=true` on unapproval, App shutdown (375-380), launch teardown (app_domain.rs:449). Page connections end on `revoked.changed()` (2879). | — | `Arc::ptr_eq` against the registry entry (298). |
| `Host` (125-138) = Native `run_host` per (site, channel, user) | `Registry.hosts` | `ensure_host` (280-361) | `stop_hosts` (391-398) from App shutdown (371-389) and from the **Launch task** (app_domain.rs:426, 446-460); `join_host` removes a finished/stopped host before re-creating (301-307, 362-369). | `hello` waits for `ready` without a bound (256-278). | key + credential (308-311) |
| Page control connection (`connection`, 1645-2896) | axum upgrade task | `/rooms` upgrade with token sub-protocol (1175-1206) | `closing` / `revoked` change (no socket close), reader end, processing error/return incl. `host_queue_closed` (1930), Hello 5 s first-message timeout (1680-1684). Dropping `processing` drops every `Capture`, `CaptureLease`, `CaptureAudio`, WHIP `Page`, pending futures (comment 2886-2887). | In-flight `operations` futures are dropped with it. | lease ids, producer ids, `same_channel` (1934, 1952, 1961) |
| `PendingCapture` (page side, 1410-1414) | `Capture.pending` | `prepare` (1495-1512) | Drop aborts its request (1627-1631); replaced by commit or cancel. | Abortable startup futures answer `capture_cancelled`. | candidate id (1446-1450) |
| WHIP `Permit`, `Resource`, `Page` (app_whip.rs:38-131) | page `external_page`; global `Inputs` keeps `Weak` | permit at authorization (app.rs:1781) | Drop revokes / stops (44-48, 71-78, 105-109); authority retirement (`InputAuthority::retired`) revokes (app.rs:1783-1791). | HTTP DELETE waits for `ended` (1835-1841). | `Arc::ptr_eq`, permit id, generation id |
| Watch page player connection (`page::Connection`, app_page.rs:302-736) | page connection | `for_site` (app.rs:1673) | Drop clears media slots and dispatches `Retire` (729-736); per-read `ResourceRead` Drop releases its slot and permit (`MAX_MEDIA_READS` = 4, 317-330); a detached revocation task per registration ends on retirement/cancel/provider end (493-508). | Requests to the UI bounded 5 s (710-717). | generation id, resource id |
| Capture catalogue read (188-213) | detached task; result shared via `Weak` | first reader | completes; not cancellable | readers wait on the watch | — |
| Local site `Launch` (app_domain.rs:78-90) | `App.launch` | `begin` (187-228) | `close()` stop + join (84-89), from App shutdown (app.rs:385-387) and from `begin` when finished/failed (201-205). `run` teardown: remove and stop this origin's hosts, stop domain, await service, close tunnel (445-474). | `progress` watch; `launch` HTTP waits on it (175-184). | — |
| cloudflared child (app_tunnel.rs:42-185) | `Tunnel` → supervising task | `start` (spawn with `kill_on_drop(true)`, 120) | `close()` stop → supervise returns → kill if alive (149-158); startup 30 s timeout; startup cancel closes it (164-184). Not in a Job; no parent-death signal. | — | — |
| Tunnel temp config `piik-quick-tunnel-*.yml` (294-308) | supervising task | `start` | dropped after the child is killed (150-157). Not reclaimed after a crash. | — | — |
| Updater thread + runtime (app_update.rs:210-303) | `update::Owner` | `Owner::new` (Windows only, 241-243) | worker exits on `closing` (429-436), then `shutdown_background`; `shutdown()` awaits `finished` (414-418). Successful install handoff sets App `closing` itself (494). | Cancel waits for the download to settle (374-376). | operation id (357, 380, 460) |
| Update download dir `.piik-update-<op>-*` beside the install (download.rs:154-161) | `State::Ready{package}` | download | install, cancel (`Idle`), worker exit; not reclaimed after a crash. | — | — |
| Windows WebView shell `Core` thread (app_windows.rs:198-303) | `run` event loop | `Core::start` (825) | `core.stop()` on main window close (1176-1180), service `Finished` → loop exit (1194-1197); `finish()` joins (1247). | — | — |
| macOS shell (app_macos.rs:120-172) | AppKit main thread | worker thread runs `core` | Quit → `terminate:` sends stop (38-43); worker drop of `Completed` stops the AppKit loop (98-118); main joins. | — | — |
| Android runtime (channel-android/src/lib.rs:26-182) | Java `NativeRuntime` handle | `nativeStart`: thread `piik-app`, multi-thread runtime with 2 workers (89-111) | `nativeStop` sends stop and **joins on the calling Java thread** (169-182); runtime exit notifies Java `runtimeStopped` (117-130). | — | — |

### 8.1 App shutdown order (code, app.rs:561-670)

1. Trigger: `stop` future (signal, Windows window close via `Core.stop`, macOS
   Quit, Android stop), terminal Quit (588, 615), or update install (`closing`
   set by updater, app_update.rs:494).
2. Serve loop breaks; terminal dropped; `shutdown` future runs:
   `desktop.revoke()` (563) → `App::shutdown()`:
   `closing=true` → every permission revoked (page connections end on their own
   tasks) → all hosts taken from the registry → `stop_hosts` (signal all, then
   await each: Native release + Leave ≤5 s) → `desktop.close()` (one release
   retry) → `launch.close()` (domain teardown, tunnel kill) →
   `update.shutdown()`.
3. Only then does `serve_http` start graceful HTTP shutdown (5 s drain;
   web.rs:38-44); upgraded page sockets are separate tasks.
4. App lock file dropped.

---

## Constants

| Name | Value | Where | Bounds |
| --- | --- | --- | --- |
| `SIGNALING_QUEUE_BYTES` | 4 MiB (+ header) | session.rs:55 | Native signaling raw backlog; overflow = carrier end |
| `SIGNALING_IDLE_TIMEOUT` | 20 s | session.rs:96 | Native reader idle |
| connect timeout (inline) | 5 s | session.rs:848 | Native WebSocket connect |
| reconnect delay (inline) | 1 s | session.rs:909 | between attempts, forever |
| `RECOVERY_MS` (Core) | 20 000 ms | channel-core identity.rs:10 | retained Live after carrier end |
| write timeout (inline) | 5 s | session.rs:3112 | each Native frame write |
| Leave timeout (inline) | 5 s | session.rs:3123 | Leave + Ack + close |
| Driver input queue / events / ready sources | 64 / 1024 / 256 | peer.rs:825-827 | events use `try_send` from the engine; overflow flag |
| Driver tick | 1 s | peer.rs:865 | deadlines, keyframes |
| Connecting deadline | 5 s (`UdpPreparation::Available`) / 20 s | peer.rs:2139-2148 | Native connect |
| Control (room DC) deadline | 20 s | peer.rs:2668 | room data channel open |
| `MAX_ICE_CANDIDATES` | 128 | peer.rs:125 | queued candidates, host refresh |
| UDP preparation deadline | 5 s | preparation.rs:76 | preparation task |
| `RANDOM_PREPARATIONS` | 2 permits, process-wide | preparation.rs:44 | random-port pool |
| `DISCOVERY_TIMEOUT_MS` (Core) | 20 000 ms | channel-core transport.rs:32 | domain pending discovery |
| `REQUIRED_RETRY_MS` (Core) | 5 000 ms | channel-core transport.rs:33 | retry after rejection |
| local input SDP limit | 150 000 bytes | transport.rs:689 | WHIP offer |
| Auto H264 startup proof | 4 s | media/local/encodings.rs:164 | first AU before VP8 fallback |
| encoder child exit wait | 1 s then kill | capture/process.rs:561-566 | Windows encoder child |
| input tick | 100 ms | input/mod.rs:291 | observe + release retry |
| domain first message | 10 s | domain.rs:480 | per socket |
| domain heartbeat / idle | 5 s ping / 20 s idle | domain.rs:521, 547 | per socket |
| domain queue / drain | 64 events / 5 s | domain.rs:502, 525 | overflow closes the client |
| domain sockets | `2 * MAX_SESSIONS` | domain.rs:682 | concurrent sessions |
| room restore permits | 1 | domain.rs:683 | Server restore/copy |
| scratch headroom | free space / 8 | backup.rs:232-233 | only when a permit exists |
| launch ticket | 60 s, ≤ `MAX_SESSIONS` | domain.rs:784, 788 | owner launch |
| `HTTP_DRAIN_TIMEOUT` | 5 s | web.rs:25 | HTTP graceful shutdown |
| App `IO_TIMEOUT` | 5 s | app.rs:69 | control writes, Hello first message |
| App host command queue | 64 | app.rs:313; lib.rs:83 | `HostCommand` |
| tunnel `STARTUP_TIMEOUT` | 30 s | app_tunnel.rs:19 | cloudflared registration |
| `MAX_MEDIA_READS` | 4 | app_page.rs:24 | page media reads |
| update metadata / connect / read | 8 s / 10 s / 15 s | app_update/download.rs:17, 34-35 | downloads |
| Android App runtime workers | 2 | channel-android lib.rs:95 | all App async work |

---

## What was measured, and what was not

- **measured / doc**: `docs/verification-status.md:102-114` records Windows
  package checks including "orderly shutdown" and "Native download cancellation
  left no saved file", and states "An isolated shutdown stall remains
  unexplained." Linux VM evidence covers "picker cancellation/retry, and
  sound-service loss with chat and picture continuing"; GNOME "can retain
  cancelled shortcut prompts and Mutter can leak an unstarted session after Piik
  releases its resources" (125-133).
- Tests encode intended lifetimes (not mapped): e.g. upload permit held until
  staging exits (backup.rs:257-283), host readiness is not an I/O timeout
  (app.rs:3163), cancelled external close retains its join (external.rs:480),
  preparation cancellation releases its socket (preparation.rs:1039).
- **Not measured** (nothing found): time to complete `NativePeers::close` or
  App/Server shutdown under load; behaviour when a platform capture thread does
  not return; orphaned cloudflared or temp directories after a crash; held keys
  after a failed release at exit; how often the engine event queue overflows.

---

## Questions for the reviewer

**Q1. Two deadlines bound the same connect wait (the known case).**
Native: `Deadline::Connecting` = 5 s when the plan says
`UdpPreparation::Available`, else 20 s, started at Native transport creation
(peer.rs:2139-2148), checked on the 1 s tick (2742-2769). Expiry ends in
`fail(id, ConnectionDeadline)`: retire the pair, refresh outputs, send
`LinkState::Failed` (2733-2741). The Core turns that into `prepare()` (new pair
id, Prepared attempt, discovery deadline reset to now + 20 s) when both ends can
prepare UDP, otherwise `retire` with a 5 s retry (Core channel.rs:333-380,
transport.rs:782-796). Core: `DISCOVERY_TIMEOUT_MS` = 20 s from
`start_discovery` (transport.rs:417-430) ends in removing the pair and a 5 s
rejection (798-816); Native then retires the pair as `ProjectionRemoved`. A
prepared attempt adds Native's own 5 s preparation deadline (preparation.rs:76)
before a fresh 20 s connect deadline. Smallest scenario: an ordinary pair that
cannot prepare — Core starts at t=0, Native creates its transport at ≈t+0.1 s;
the Core expires at 20 s and Native's identical 20 s never fires unless the
domain is unreachable. With `Available`, the Native 5 s deadline is in effect
the policy that moves a pair from ordinary to prepared; the 20 s duplicates the
Core's. Which owner should hold the connect deadline, and is the 5 s a
deadline or a policy step?

**Q2. Bounded queues turn a burst into retirement in three places.** Engine
events use `try_send` into a 1024 queue; a full queue sets `overflow`, which the
next tick treats as an expired deadline: an established pair loses its room
data (`fail_room_data`), an unestablished one is failed (transport.rs:194-199;
peer.rs:2752-2768). The Native signaling reader fails with
`native_signaling_backpressure` when 4 MiB is pending (session.rs:77-86) —
carrier end. The domain closes a client whose 64-event queue is full
(domain.rs:185-187). `docs/standards/engineering.md:334-335`: "Bounded queues
apply backpressure rather than turning a valid burst into session failure."
Scenario: a TURN/host-refresh candidate burst on one healthy pair during a
busy Driver turn.

**Q3. Shutdown is not bounded.** App shutdown awaits each host (app.rs:391-398);
each host awaits `NativePeers::close` → `Driver::close` (peer.rs:1266-1295),
which joins capture threads (`spawn_blocking(capture.stop())`,
encodings.rs:301), encoders, audio inputs and pairs with no timeout. Only Leave
(5 s), the encoder child (1 s + kill) and HTTP drain (5 s) are bounded. Android
`nativeStop` joins on the Java calling thread (channel-android lib.rs:169-182);
Windows `ctrl_close` grants the process a short grace (shutdown.rs:28-31).
**doc**: "An isolated shutdown stall remains unexplained" (verification-status
114). Rule: "Retirement is ordered and bounded" (engineering.md:305-312).
Scenario: a Linux Portal `session.close()` or a WGC thread that does not return.

**Q4. Synchronous joins on async threads.** Platform `Capture` Drop joins its
OS thread (windows.rs:112-123, linux/source.rs:163-176, android/source.rs:114-121);
`Encoding` Drop stops and joins a supervisor that may wait 1 s and kill
(process.rs:258-269). These run on a Tokio worker when their future is dropped:
`Producer::start` returning `Err` from `prepare_system` after `Capture::start`
succeeded (media/local.rs:206-224), or the Driver cancelling a turn mid-await
(peer.rs:1072-1077). The Linux capture thread itself `block_on`s the same
runtime (linux/source.rs:122-126); the Android runtime has two workers. Normal
paths use `spawn_blocking`. Is the drop path acceptable, or should these
owners always retire asynchronously?

**Q5. One owner stops another's hosts, under the other's lock.** The local-site
Launch task removes and stops App registry hosts for its origin at teardown and
on domain restore (app_domain.rs:414-428, 446-460), and restarts them through
`ensure_host` after a failed restore (432-439). During restore it calls
`stop_hosts(hosts).await` while holding `app.registry` (414-428), so every
Hello, upgrade, launcher and approval request waits for each host's full release
and Leave. The comment says this is deliberate ("Keep the existing creation gate
through shutdown and replacement"). Rule: "Blocking retirement runs outside the
owner's state lock" (engineering.md:309-310). Should the registry own host
retirement, with restore taking a gate rather than the lock?

**Q6. The App `closing` watch has three writers.** App shutdown (app.rs:372),
terminal Quit (588, 615), and the updater after a successful handoff
(app_update.rs:494). The updater thus ends the App on the App's behalf; the App
learns only through the watch. Is the updater an owner of App lifetime?

**Q7. Failed key releases are abandoned at exit.** A failed key-up is kept in
`Executor.releases` and retried on each 100 ms tick (input/mod.rs:996-1003,
289-309). The tick runs in the App serve loop (app.rs:580), which has already
exited when `Desktop::close` runs (app.rs:384); close retries once (357).
Scenario: `revoke()` at shutdown fails `SendInput` (UIPI or secure desktop),
the single retry fails too, and the key stays down after the App exits.

**Q8. A child process and files outlive a crashed App, unevenly by platform.**
The Windows encoder child is in a `KILL_ON_JOB_CLOSE` Job (process.rs:369-386).
cloudflared uses only `kill_on_drop(true)` (app_tunnel.rs:120), which needs an
orderly drop; no Job on Windows, no parent-death signal on Linux/macOS/Android.
Left after a crash: cloudflared, `piik-quick-tunnel-*.yml` (296-307),
`piik-restore-*` (backup.rs:229), `piik-backup-*` (session.rs:2534) and
`.piik-update-<op>-*` beside the installation, up to 2 GiB
(download.rs:154-161). Only room-install staging is reclaimed
(hosted_room.rs:190-212). Room `.lock` files are never deleted, even after
deletion (hosted_room.rs:166-175).

**Q9. Unpublish of a local screen is decided by two rules.** `state()` skips a
publication that has a current startup request in `pending_captures`
(session.rs:2842-2861; comment: "Only a real producer or its current startup
request owns that activity"). `process_peer` on `CaptureEnded` checks only live
Driver producers (230-267); Driver `capture_ended` checks only
`local_producers` (peer.rs:1850-1856). Scenario: the incumbent's worker fails
while the page's replacement is still a `PendingCapture::Prepare` awaiting its
`EnterRoom` reply. `process_peer` unpublishes; the replacement then fails
`capture_not_owned` (peer.rs:1528-1535). The outcome may be right; the rule
lives in two places.

**Q10. Domain request waiters run inside the client's read loop.**
`create_room`, `delete_room` and sole-recipient `Conversation` are awaited in
`reading` (domain.rs:553). A slow room writer therefore stops all reads for that
client; the 20 s idle check compares against `last_seen` from before the
dispatch (547). If `writing` ends first, `reading` is dropped mid-`create_room`
after the reservation was made and before `cancel_reservation` (338-349,
569-575). Whether `authority.disconnect` (581) clears that reservation is Core
behaviour (not mapped). `create_copy` instead spawns its settlement ("the room
writer's outcome owns the reservation even if the HTTP client leaves",
domain_backup.rs:227-255): two mechanisms for one lifetime.

**Q11. Scratch admission differs across three paths, and one permit is
released early.** Server room restore and copy: `Semaphore(1)` plus a
free-space/8 bound (domain_backup.rs:109-113, 161-165; backup.rs:231-235). App
room restore: no permit and an unbounded copy (app_backup.rs:142 →
backup.rs:236). Domain restore: no permit, unbounded (domain_backup.rs:284 →
backup.rs:150). In the Native session, `CreateCopy` drops its permit when
`open_room` returns (session.rs:1038-1041), before registration completes.
`RestoreRoom` holds its permit "through staging and installation" (393-394).
Is the permit meant to cover only disk staging (then the copy path is
consistent), and why do App and domain restores have no bound?

**Q12. Waits without a bound or a clear failure.** App `hello` waits on host
readiness indefinitely (app.rs:268-277; test name: "host readiness is not an
io timeout", 3163). `run_host` retries forever: 5 s connect, then a 1 s delay
(session.rs:847-921). Native capture readiness has no deadline outside the
Auto-H264 4 s proof (encodings.rs:44-54), and external (WHIP) readiness has
none at all (external.rs:136-166; app.rs:1865-1876). Register openings survive
`release()` (session.rs:790-802). Canon: "Every attempt ends in success,
bounded waiting or a clear failure." Scenario: an approved remote site is
offline; the page's Hello never gets a reply.

**Q13. Failures logged where an owner is waiting.** `RoomCreated` local
installation failure is printed and dropped after the domain has created the
room (session.rs:1581-1586); `OpeningWork::Create` failure is print-only (357).
A failed input-source creation at commit is printed, and the page receives
`remote: None` with no reason (peer.rs:1779-1785). The Server treats any end of
Native hosting as fatal (lib.rs:180-181). `main` races `owner_link::serve`
against `serve_server` (main.rs:158-169), so an owner-link accept error drops
`serve_server` without `hosting.close()` or domain stop: the spawned Native and
domain tasks are cancelled at runtime drop, with no Leave sent.

**Q14. Platform differences that are policy, not capability.**
- Windows ends App hosting when its main window closes (app_windows.rs:1176-1180).
  macOS ends on Quit or a signal (app_macos.rs:38-43); Linux on a signal
  (bin/app.rs:66-87); Android on Service stop. **doc**: "App shutdown ends its
  hosts; page loss stops its own captures without ending independent App
  hosting" (engineering.md:168).
- Only Windows replaces an encoder after a runtime failure (device loss once,
  hardware to software once; process.rs:306-334). Linux, macOS and Android end
  the encoding: no restart code in their encoding files.
- Only Windows isolates encoders in a child process.
- The first-frame proof deadline exists only for Auto codec when VP8 is
  supported (encodings.rs:162-164).
- macOS keeps the 100 ms desktop tick alive for the whole process once a stop
  key is set (input/mod.rs:311-316). Windows uses a hotkey thread; Linux a
  Portal session.
- The updater exists only on Windows (app_update.rs:241-243).
- Capability, not policy: Android lacks the host-candidate refresh task because
  its netwatch backend has no change notifications (transport.rs:410-427, 762);
  file locking uses flock on Unix and `try_lock` on Windows (hosted_room.rs:222-229).

---

## Not read

Read in full or at their start/stop paths: `session.rs`; `peer.rs` (types, the
Driver loop, close, prepare/commit/end of captures, update/create/retire pairs,
deadlines, events, outputs); `peer/transport.rs` (Runtime pump, add/close,
Engine close/fail, readers); `peer/preparation.rs` (Pending); `peer/mapping.rs`;
`peer/external.rs` (Producer, run); `capture/process.rs`, `capture/windows.rs`
(Capture); `capture/linux/source.rs` (Capture, prepare, authorize, run);
`capture/android/source.rs`; `media/local.rs`; `media/local/encodings.rs`
(initial, run); `media/local/audio.rs` (actor); `input/mod.rs` (Desktop,
Executor release paths); `hosted_room.rs`; `windows_hotkeys.rs`; `shutdown.rs`.
Server: `domain.rs`, `domain_backup.rs`, `backup.rs`, `lib.rs`, `main.rs`,
`bin/app.rs`, `app_domain.rs`, `app_tunnel.rs`, `app_macos.rs`; `app.rs` lines
1-700 and 1175-2180 and 2780-3160; `app_whip.rs` 1-140; `app_page.rs` 250-737;
`app_update.rs` 195-519; `app_windows.rs` Core and `run` (196-305, 770-850,
1150-1249); `channel-android/src/lib.rs`.

Searched only (spawns, Drop impls, close paths), not read: `peer/bandwidth.rs`
(except `reconcile_encodings`), `peer/input.rs` (except close/Drop),
`peer/discovery.rs`, `peer/turn.rs`, `peer/turn_stream.rs`, `peer/nat64.rs`,
`peer/server_udp.rs`, `peer/linear.rs`, `data.rs`, `file.rs`, `watch.rs`,
`media.rs`, `media/incoming.rs`, `media/video.rs`, `media/encodings.rs`,
`media/derived.rs` (except Producer/Decoding start-stop), `media/output.rs`
(except close), `capture/{frames,output,worker,mf*,sdr,software,vp8*,decoder*,
gpu,audio,preview}.rs`, `capture/linux/{encoding,audio,decoder,frames}.rs`,
`capture/macos/*`, `capture/android/{encoding,audio,graphics,platform}.rs`,
`input/{windows,linux,macos,linux_shortcut,gamepad,keyboard}.rs`, `backup.rs`
(Native), `diagnostics.rs`, `portal.rs`; Server `app_sites.rs`,
`app_page/*` (reader, indexed, mpd), `app_windows/*` submodules,
`app_voice_shortcuts.rs` (outline only), `app_update/{package,windows}.rs`,
`app_backup.rs` (outline), `app_stun.rs`, `app_terminal.rs`, `app_console.rs`,
`owner_link.rs` (serve and socket cleanup only), `release.rs`, `web.rs` (except
`serve_http`). Tests were used only as evidence of intent.

`docs/research/native-client-lifecycle.md` does not exist in this checkout.
`docs/research/nat-traversal.md:531` links it on the `main` branch, so it was
not read. Core behaviour cited (`RECOVERY_MS`, discovery, LinkState handling,
`Authority::expire`) was read only at the cited lines. Browser lifetimes are
left to the companion pass.

Dependencies on the companion pass's area: Native pair leases, discovery
deadlines and route plans come from the Core (`Authority`, `transports`);
Native capture and input leases are held by Browser pages through the App
control socket (`connection`); watch readers depend on the Browser/WebView page
player through `page::Dispatcher`.
