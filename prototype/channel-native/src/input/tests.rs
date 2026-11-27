use super::*;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

#[derive(Default)]
struct Recording {
    events: Vec<Action>,
    suspended: bool,
    lost: bool,
    fail_release: bool,
    fail_press: bool,
    deny_permission: bool,
    permission_requests: usize,
}
struct Recorder(Arc<Mutex<Recording>>);
impl Sink for Recorder {
    fn authorize(&mut self) -> Result<()> {
        let mut r = self.0.lock().unwrap();
        r.permission_requests += 1;
        ensure!(!r.deny_permission, "OS input permission denied");
        Ok(())
    }
    fn observe(&mut self, _: &Target) -> TargetState {
        let r = self.0.lock().unwrap();
        if r.lost {
            TargetState::Lost
        } else if r.suspended {
            TargetState::Suspended
        } else {
            TargetState::Ready(Bounds {
                left: -1920,
                top: 0,
                width: 1920,
                height: 1080,
            })
        }
    }
    fn apply(&mut self, _: Bounds, action: &Action) -> Result<()> {
        let mut r = self.0.lock().unwrap();
        r.events.push(action.clone());
        ensure!(
            !(r.fail_release && matches!(action, Action::Held(_, false)))
                && !(r.fail_press && matches!(action, Action::Held(_, true))),
            "injected_failure"
        );
        Ok(())
    }
}
fn desktop() -> (Desktop, Arc<Mutex<Recording>>) {
    let r = Arc::new(Mutex::new(Recording::default()));
    (Desktop::with_sink(Box::new(Recorder(r.clone()))), r)
}

pub(crate) fn held_input_fixture(
    publication: Uuid,
    controller: Uuid,
    flow: Uuid,
) -> (Source, String, impl FnMut(bool)) {
    let (d, recorded) = desktop();
    let (s, mut replies, view) = d
        .source(
            publication,
            Uuid::new_v4(),
            Target {
                kind: crate::capture::TargetKind::Display,
                source_id: "fixture".into(),
                title: "fixture".into(),
                pid: 0,
                creation_time: None,
            },
        )
        .unwrap();
    let mut client = Client {
        id: controller,
        flow,
        sequence: 0,
        key: [7; 32],
    };
    s.register(Registration {
        controller,
        flow,
        secret: client.key,
    })
    .unwrap();
    s.set_mode(Mode::Ask).unwrap();
    let grant = client.approve(&s, &mut replies);
    let key = client.packet(json!({"type":"key","code":"KeyA","down":true,"grant":grant}));
    s.receive(controller, flow, &key).unwrap();
    client.send(
        &s,
        json!({"type":"button","button":0,"down":true,"grant":grant}),
    );
    assert_eq!(recorded.lock().unwrap().events.len(), 2);
    let sync = client.packet(json!({"type":"sync"}));
    let source = s.clone();
    (s, sync, move |released| {
        assert!(!replies.is_closed());
        if !released {
            assert_eq!(view.borrow().requests.len(), 1);
            assert_eq!(recorded.lock().unwrap().events.len(), 2);
            return;
        }
        assert!(view.borrow().requests.is_empty());
        let expected = vec![
            Action::Held(Held::Key(keyboard::scan("KeyA").unwrap()), true),
            Action::Held(Held::Button(0), true),
            Action::Held(Held::Key(keyboard::scan("KeyA").unwrap()), false),
            Action::Held(Held::Button(0), false),
        ];
        assert_eq!(recorded.lock().unwrap().events, expected);
        source.receive(controller, flow, &key).unwrap();
        client.send(
            &source,
            json!({"type":"button","button":0,"down":true,"grant":grant}),
        );
        assert_eq!(recorded.lock().unwrap().events, expected);
    })
}

#[cfg(feature = "capture")]
pub(crate) fn lifecycle_fixture_desktop() -> Desktop {
    desktop().0
}

#[cfg(target_os = "windows")]
#[test]
fn partial_unicode_cleanup_survives_source_retirement() {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT_KEYBOARD, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    };

    struct Scripted(Arc<Mutex<Vec<Vec<(u16, u32)>>>>);
    impl Sink for Scripted {
        fn observe(&mut self, _: &Target) -> TargetState {
            TargetState::Ready(Bounds::default())
        }
        fn apply(&mut self, bounds: Bounds, action: &Action) -> Result<()> {
            windows::System::apply_with(bounds, action, |inputs| {
                let mut calls = self.0.lock().unwrap();
                calls.push(
                    inputs
                        .iter()
                        .map(|input| {
                            assert_eq!(input.r#type, INPUT_KEYBOARD);
                            let key = unsafe { input.Anonymous.ki };
                            (key.wScan, key.dwFlags.0)
                        })
                        .collect(),
                );
                // Accept 'A' and the high surrogate press. Refuse its release
                // immediately and on the first tick, then accept it at close.
                [3, 0, 0, 1][calls.len() - 1]
            })
        }
    }
    let calls = Arc::new(Mutex::new(Vec::new()));
    let d = Desktop::with_sink(Box::new(Scripted(calls.clone())));
    let (s, mut replies, _) = source(&d);
    s.set_mode(Mode::Ask).unwrap();
    let mut client = Client::new(&s);
    let grant = client.approve(&s, &mut replies);
    let text = "A\u{1f600}Z";
    client.send(&s, json!({"type":"text","text":text,"grant":grant}));
    let state = client.state(&mut replies);
    assert_eq!(state["grant"], grant);
    assert_eq!(state["inputFailed"], true);
    s.retire_capture();
    d.tick();
    d.close();
    d.tick();

    let down = KEYEVENTF_UNICODE.0;
    let up = (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP).0;
    let batch = text
        .encode_utf16()
        .flat_map(|u| [(u, down), (u, up)])
        .collect();
    let release = vec![(0xd83d, up)];
    assert_eq!(
        *calls.lock().unwrap(),
        vec![batch, release.clone(), release.clone(), release]
    );
}

fn source(d: &Desktop) -> (Source, mpsc::Receiver<Reply>, watch::Receiver<SourceView>) {
    d.source(
        Uuid::new_v4(),
        Uuid::new_v4(),
        Target {
            kind: crate::capture::TargetKind::Display,
            source_id: "1".into(),
            title: "fixture".into(),
            pid: 0,
            creation_time: None,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn pending_os_permission_obeys_current_source_consent() {
    let (desktop, _) = desktop();
    let (source, _, state) = source(&desktop);
    let (permit, granted) = tokio::sync::oneshot::channel();
    let pending = source
        .configure(Mode::Room, None, Some(true), |_| async move {
            granted.await?;
            Ok(())
        })
        .unwrap();
    tokio::pin!(pending);
    assert!(futures_util::poll!(&mut pending).is_pending());
    desktop.revoke();
    permit.send(()).unwrap();
    assert!(pending.await.is_err());
    assert_eq!(state.borrow().mode, Mode::Off);
    assert!(!state.borrow().simultaneous);

    // A newer request takes ownership even before the old future is polled.
    let older = source
        .configure(Mode::Room, None, None, |_| async { Ok(()) })
        .unwrap();
    source
        .configure(Mode::Off, None, None, |_| async { Ok(()) })
        .unwrap()
        .await
        .unwrap();
    assert!(older.await.is_err());
    assert_eq!(state.borrow().mode, Mode::Off);

    source
        .configure(
            Mode::Password,
            Some("friends".into()),
            Some(true),
            |_| async { Ok(()) },
        )
        .unwrap()
        .await
        .unwrap();
    source
        .configure(Mode::Password, None, Some(false), |_| async { Ok(()) })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(state.borrow().mode, Mode::Password);
    assert!(!state.borrow().simultaneous);
    let pending = source
        .configure(Mode::Room, None, None, |_| async { Ok(()) })
        .unwrap();
    source.retire_capture();
    assert!(pending.await.is_err());
}

struct Client {
    id: Uuid,
    flow: Uuid,
    sequence: u64,
    key: [u8; 32],
}
impl Client {
    fn new(s: &Source) -> Self {
        let c = Self {
            id: Uuid::new_v4(),
            flow: Uuid::new_v4(),
            sequence: 0,
            key: [7; 32],
        };
        s.register(Registration {
            controller: c.id,
            flow: c.flow,
            secret: c.key,
        })
        .unwrap();
        c
    }
    fn packet(&mut self, value: Value) -> String {
        self.sequence += 1;
        let mut bytes = vec![0; 20];
        bytes[..8].copy_from_slice(&self.sequence.to_be_bytes());
        bytes[8..16].copy_from_slice(&self.sequence.to_le_bytes());
        let encrypted = Aes256Gcm::new((&self.key).into())
            .encrypt(
                Nonce::from_slice(&bytes[8..]),
                Payload {
                    msg: &serde_json::to_vec(&value).unwrap(),
                    aad: &auth(0, &bytes[..8], self.flow),
                },
            )
            .unwrap();
        bytes.extend(encrypted);
        STANDARD.encode(bytes)
    }
    fn send(&mut self, s: &Source, value: Value) {
        let packet = self.packet(value);
        s.receive(self.id, self.flow, &packet).unwrap();
    }
    fn state(&self, replies: &mut mpsc::Receiver<Reply>) -> Value {
        self.state_packet(replies).1
    }
    fn state_packet(&self, replies: &mut mpsc::Receiver<Reply>) -> (u64, Value) {
        let mut last = None;
        while let Ok(reply) = replies.try_recv() {
            if reply.controller != self.id {
                continue;
            }
            assert_eq!(reply.flow, self.flow);
            let bytes = STANDARD.decode(reply.data).unwrap();
            let plain = Aes256Gcm::new((&self.key).into())
                .decrypt(
                    Nonce::from_slice(&bytes[8..20]),
                    Payload {
                        msg: &bytes[20..],
                        aad: &auth(1, &bytes[..8], self.flow),
                    },
                )
                .unwrap();
            last = Some((
                u64::from_be_bytes(bytes[..8].try_into().unwrap()),
                serde_json::from_slice(&plain).unwrap(),
            ));
        }
        last.expect("encrypted state reply")
    }
    fn approve(&mut self, s: &Source, replies: &mut mpsc::Receiver<Reply>) -> String {
        let intent = Uuid::new_v4();
        self.send(
            s,
            json!({"type":"request","intent":intent.simple().to_string()}),
        );
        s.decide(self.id, intent, true).unwrap();
        self.state(replies)["grant"].as_str().unwrap().to_string()
    }
}
fn auth(direction: u8, sequence: &[u8], flow: Uuid) -> Vec<u8> {
    [
        vec![direction],
        sequence.to_vec(),
        flow.simple().to_string().into_bytes(),
    ]
    .concat()
}

#[test]
fn only_page_policy_requests_os_permission_and_denial_keeps_input_off() {
    let (d, recording) = desktop();
    recording.lock().unwrap().deny_permission = true;
    let (s, mut replies, view) = source(&d);
    let mut c = Client::new(&s);
    c.send(&s, json!({"type":"sync"}));
    c.send(
        &s,
        json!({"type":"request","intent":Uuid::new_v4().simple().to_string()}),
    );
    assert_eq!(recording.lock().unwrap().permission_requests, 0);
    assert!(s.set_mode(Mode::Ask).is_err());
    assert_eq!(view.borrow().mode, Mode::Off);
    assert!(view.borrow().requests.is_empty());
    s.set_mode(Mode::Off).unwrap();
    assert_eq!(recording.lock().unwrap().permission_requests, 1);
    recording.lock().unwrap().deny_permission = false;
    s.set_mode(Mode::Ask).unwrap();
    c.approve(&s, &mut replies);
    assert_eq!(recording.lock().unwrap().permission_requests, 2);
    assert_eq!(view.borrow().requests[0].state, "active");
    assert!(recording.lock().unwrap().events.is_empty());
}

#[test]
fn ask_requires_matching_intent_and_keeps_holds_until_reset_release_or_route_retirement() {
    let (d, recording) = desktop();
    let (s, mut replies, view) = source(&d);
    let mut c = Client::new(&s);
    c.send(&s, json!({"type":"request","intent":Uuid::new_v4()}));
    assert_eq!(c.state(&mut replies)["state"], "unavailable");
    s.set_mode(Mode::Ask).unwrap();
    let intent = Uuid::new_v4();
    c.send(
        &s,
        json!({"type":"request","intent":intent.simple().to_string()}),
    );
    assert_eq!(view.borrow().requests[0].id, intent.simple().to_string());
    assert!(s.decide(c.id, Uuid::new_v4(), true).is_err());
    s.decide(c.id, intent, true).unwrap();
    let state = c.state(&mut replies);
    let grant = &state["grant"];
    for value in [
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
        json!({"type":"move","x":0.5,"y":0.2,"grant":grant}),
        json!({"type":"button","button":0,"down":true,"grant":grant}),
        json!({"type":"wheel","delta":120,"grant":grant}),
    ] {
        c.send(&s, value);
    }
    assert_eq!(recording.lock().unwrap().events.len(), 4);
    c.send(&s, json!({"type":"reset","grant":grant}));
    assert_eq!(
        &recording.lock().unwrap().events[4..],
        &[
            Action::Held(Held::Key(keyboard::scan("KeyA").unwrap()), false),
            Action::Held(Held::Button(0), false)
        ]
    );
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    s.retire(c.id, Uuid::new_v4()).unwrap();
    assert_eq!(view.borrow().requests.len(), 1);
    s.retire(c.id, c.flow).unwrap();
    assert!(view.borrow().requests.is_empty());
    assert_eq!(
        recording.lock().unwrap().events.last(),
        Some(&Action::Held(
            Held::Key(keyboard::scan("KeyA").unwrap()),
            false
        ))
    );
    c.send(
        &s,
        json!({"type":"key","code":"KeyB","down":true,"grant":grant}),
    );
    assert_eq!(recording.lock().unwrap().events.len(), 8);
}

#[test]
fn terminal_replies_keep_request_identity_after_consent_ends() {
    let (desktop, recording) = desktop();
    let (source, mut replies, view) = source(&desktop);
    source.set_mode(Mode::Ask).unwrap();
    let mut client = Client::new(&source);
    let ready = client.state(&mut replies);
    let first = Uuid::from_u128(101);
    client.send(&source, json!({"type":"request", "intent":first}));
    let pending_first = client.state(&mut replies);
    source.decide(client.id, first, true).unwrap();
    let active_first = client.state(&mut replies);
    let grant = active_first["grant"].as_str().unwrap();
    client.send(
        &source,
        json!({"type":"key", "code":"ShiftLeft", "down":true, "grant":grant}),
    );
    source
        .receive(client.id, client.flow, "invalid ciphertext")
        .unwrap();
    source.decide(client.id, first, false).unwrap();
    let stopped_first = client.state(&mut replies);
    assert_eq!(stopped_first["state"], "ready");
    assert_eq!(stopped_first["intent"], first.simple().to_string());
    assert!(stopped_first.get("grant").is_none());
    assert!(view.borrow().requests.is_empty());
    assert_eq!(
        recording.lock().unwrap().events.len(),
        2,
        "held Shift released"
    );
    client.send(
        &source,
        json!({"type":"key", "code":"KeyB", "down":true, "grant":grant}),
    );
    assert_eq!(
        recording.lock().unwrap().events.len(),
        2,
        "retired grant cannot execute"
    );
    desktop.tick();
    assert!(
        replies.try_recv().is_err(),
        "ordinary ticks do not force a reply"
    );
    client.send(&source, json!({"type":"sync"}));
    let synced_first = client.state(&mut replies);
    assert_eq!(synced_first, stopped_first);

    let second = Uuid::from_u128(102);
    client.send(&source, json!({"type":"request", "intent":second}));
    let pending_second = client.state(&mut replies);
    assert_eq!(pending_second["state"], "pending");
    assert_eq!(pending_second["intent"], second.simple().to_string());
    client.send(&source, json!({"type":"release", "intent":first}));
    assert!(
        replies.try_recv().is_err(),
        "old release cannot end the new request"
    );
    assert_eq!(view.borrow().requests[0].id, second.simple().to_string());
    source.decide(client.id, second, false).unwrap();
    let declined_second = client.state(&mut replies);
    assert_eq!(declined_second["state"], "ready");
    assert_eq!(declined_second["intent"], second.simple().to_string());
    assert!(declined_second.get("grant").is_none());

    source.set_policy(Mode::Password, "private").unwrap();
    let mut newcomer = Client::new(&source);
    let password_ready = newcomer.state(&mut replies);
    let third = Uuid::from_u128(103);
    newcomer.send(
        &source,
        json!({"type":"request", "intent":third, "password":"wrong"}),
    );
    let password_denied = newcomer.state(&mut replies);
    assert_eq!(password_denied["state"], "ready");
    assert_eq!(password_denied["intent"], third.simple().to_string());
    assert_eq!(password_denied["reason"], "password");
    assert!(view.borrow().requests.is_empty());
    println!(
        "PIIK_INPUT_REPLY_FIXTURE:{}",
        json!({
            "first":first, "second":second, "third":third,
            "ready":ready, "pendingFirst":pending_first, "activeFirst":active_first,
            "stoppedFirst":stopped_first, "syncedFirst":synced_first,
            "pendingSecond":pending_second, "declinedSecond":declined_second,
            "passwordReady":password_ready, "passwordDenied":password_denied,
        })
    );
}

#[test]
fn focus_suspend_releases_and_resume_retains_grant_but_target_loss_retires() {
    let (d, r) = desktop();
    let (s, mut replies, _) = source(&d);
    s.set_mode(Mode::Ask).unwrap();
    let mut c = Client::new(&s);
    let grant = c.approve(&s, &mut replies);
    c.send(
        &s,
        json!({"type":"key","code":"ShiftLeft","down":true,"grant":grant}),
    );
    r.lock().unwrap().suspended = true;
    d.tick();
    let state = c.state(&mut replies);
    assert_eq!(state["state"], "suspended");
    assert_eq!(state["grant"], grant);
    assert_eq!(r.lock().unwrap().events.len(), 2);
    r.lock().unwrap().suspended = false;
    d.tick();
    assert_eq!(c.state(&mut replies)["state"], "active");
    r.lock().unwrap().lost = true;
    d.tick();
    let state = c.state(&mut replies);
    assert_eq!(state["state"], "unavailable");
    assert!(state.get("grant").is_none());
}

#[tokio::test]
async fn share_pause_releases_input_and_only_fresh_consent_resumes() {
    let (desktop, recording) = desktop();
    let (sibling, _sibling_replies, sibling_view) = source(&desktop);
    let (source, mut replies, view) = source(&desktop);
    let mut pause = crate::peer::share_pause_projection(&source, &sibling);
    sibling.set_mode(Mode::Ask).unwrap();
    let mut other = Client::new(&sibling);
    other.send(&sibling, json!({"type":"request","intent":Uuid::new_v4()}));
    source.set_mode(Mode::Ask).unwrap();
    let mut active = Client::new(&source);
    let old = active.approve(&source, &mut replies);
    active.send(&source, json!({"type":"button","button":0,"down":true,"grant":old}));
    active.send(&source, json!({"type":"key","code":"ShiftLeft","down":true,"grant":old}));
    let mut waiting = Client::new(&source);
    let intent = Uuid::new_v4();
    waiting.send(&source, json!({"type":"request","intent":intent}));
    let permission = source.configure(Mode::Room, None, None, |_| async { Ok(()) }).unwrap();

    let pending_moves = [0.25, 0.75].map(|x| active.packet(json!({
        "type":"move", "x":x, "y":0.5, "grant":old
    })));
    pause(true);
    let released = recording.lock().unwrap().events.clone();
    assert_eq!(released.len(), 4);
    source.receive(active.id, active.flow, &pending_moves[0]).unwrap();
    assert_eq!(recording.lock().unwrap().events, released);
    assert!(permission.await.is_err());
    assert_eq!(view.borrow().mode, Mode::Ask);
    assert!(view.borrow().requests.is_empty());
    assert!(source.decide(waiting.id, intent, true).is_err());
    assert_eq!(active.state(&mut replies)["state"], "unavailable");
    pause(true);
    waiting.send(&source, json!({"type":"request","intent":Uuid::new_v4()}));
    assert!(view.borrow().requests.is_empty());
    pause(false);
    assert_eq!(active.state(&mut replies)["state"], "ready");
    source.receive(active.id, active.flow, &pending_moves[1]).unwrap();
    assert_eq!(recording.lock().unwrap().events, released);
    assert!(view.borrow().requests.is_empty());
    assert_eq!(sibling_view.borrow().requests.len(), 1);
    for held in [Held::Button(0), Held::Key(keyboard::scan("ShiftLeft").unwrap())] {
        assert!(released.contains(&Action::Held(held, true)));
        assert!(released.contains(&Action::Held(held, false)));
    }
    let fresh = active.approve(&source, &mut replies);
    assert_ne!(fresh, old);
    source.retire_capture();
    pause(false);
    assert!(source.set_mode(Mode::Room).is_err());
}

#[tokio::test(start_paused = true)]
async fn desktop_ticks_follow_sources_and_pending_releases() {
    use std::{
        future::{poll_fn, Future},
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio::{task::yield_now, time::sleep};

    let (desktop, recording) = desktop();
    let driver_polls = Arc::new(AtomicUsize::new(0));
    let driver = tokio::spawn({
        let desktop = desktop.clone();
        let driver_polls = driver_polls.clone();
        async move {
            let mut timer = None;
            loop {
                let tick = desktop.tick_when_needed(&mut timer);
                tokio::pin!(tick);
                poll_fn(|cx| {
                    driver_polls.fetch_add(1, Ordering::Relaxed);
                    tick.as_mut().poll(cx)
                })
                .await;
            }
        }
    });
    yield_now().await;
    let idle_polls = driver_polls.load(Ordering::Relaxed);
    assert!(idle_polls > 0);
    sleep(Duration::from_secs(1)).await;
    assert_eq!(driver_polls.load(Ordering::Relaxed), idle_polls);

    let (source, mut replies, _) = source(&desktop);
    source.set_mode(Mode::Ask).unwrap();
    let mut client = Client::new(&source);
    let grant = client.approve(&source, &mut replies);
    recording.lock().unwrap().suspended = true;
    sleep(Duration::from_millis(110)).await;
    let state = client.state(&mut replies);
    assert_eq!(state["state"], "suspended");
    assert_eq!(state["grant"], grant);

    recording.lock().unwrap().suspended = false;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(client.state(&mut replies)["state"], "active");
    client.send(
        &source,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );

    recording.lock().unwrap().fail_release = true;
    source.close();
    assert!(desktop.0.lock().unwrap().sources.is_empty());
    assert_eq!(recording.lock().unwrap().events.len(), 2);
    sleep(Duration::from_millis(100)).await;
    assert_eq!(recording.lock().unwrap().events.len(), 3);

    recording.lock().unwrap().fail_release = false;
    sleep(Duration::from_millis(100)).await;
    assert!(desktop.0.lock().unwrap().releases.is_empty());
    let idle_polls = driver_polls.load(Ordering::Relaxed);
    sleep(Duration::from_secs(1)).await;
    assert_eq!(driver_polls.load(Ordering::Relaxed), idle_polls);
    let release = Action::Held(Held::Key(keyboard::scan("KeyA").unwrap()), false);
    assert_eq!(
        recording.lock().unwrap().events[1..],
        [release.clone(), release.clone(), release]
    );

    driver.abort();
    assert!(driver.await.unwrap_err().is_cancelled());
}

#[test]
fn os_failure_keeps_permission_and_only_failed_releases_are_retried() {
    let (d, r) = desktop();
    let (s, mut replies, _) = source(&d);
    s.set_mode(Mode::Ask).unwrap();
    let mut c = Client::new(&s);
    let grant = c.approve(&s, &mut replies);
    c.send(&s, json!({"type":"gamepad","gamepad":{"buttons":1,"leftTrigger":0,"rightTrigger":0,"leftX":0,"leftY":0,"rightX":0,"rightY":0},"grant":grant}));
    let state = c.state(&mut replies);
    assert_eq!(state["grant"], grant);
    assert_eq!(state["reason"], "gamepad");
    assert!(!state["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("gamepad")));
    r.lock().unwrap().fail_press = true;
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    let state = c.state(&mut replies);
    assert_eq!(state["grant"], grant);
    assert_eq!(state["inputFailed"], true);
    d.tick();
    assert_eq!(r.lock().unwrap().events.len(), 1);
    r.lock().unwrap().fail_press = false;
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    r.lock().unwrap().fail_release = true;
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":false,"grant":grant}),
    );
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":false,"grant":grant}),
    );
    let state = c.state(&mut replies);
    assert_eq!(state["grant"], grant);
    assert_eq!(
        state["inputFailed"], true,
        "a no-op release cannot hide pending OS releases"
    );
    c.send(&s, json!({"type":"reset","grant":grant}));
    c.send(&s, json!({"type":"sync"}));
    assert_eq!(c.state(&mut replies)["inputFailed"], true);
    r.lock().unwrap().fail_release = false;
    d.tick();
    c.send(&s, json!({"type":"move","x":0.5,"y":0.5,"grant":grant}));
    let state = c.state(&mut replies);
    assert_eq!(state["grant"], grant);
    assert_ne!(state["inputFailed"], true);
    assert_eq!(
        r.lock().unwrap().events.last(),
        Some(&Action::Move(0.5, 0.5))
    );
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    let before_close = r.lock().unwrap().events.len();
    r.lock().unwrap().fail_release = true;
    s.close();
    d.tick();
    assert_eq!(r.lock().unwrap().events.len(), before_close + 2);
    r.lock().unwrap().fail_release = false;
    d.tick();
    d.tick();
    assert_eq!(r.lock().unwrap().events.len(), before_close + 3);
    assert!(r.lock().unwrap().events[before_close..]
        .iter()
        .all(|e| *e == Action::Held(Held::Key(keyboard::scan("KeyA").unwrap()), false)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gamepads_follow_grants_without_blocking_or_revoking_keyboard_input() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum PadEvent {
        Report(usize, u32),
        Reset(usize),
        Closed(usize),
    }
    struct Device {
        id: usize,
        events: Arc<Mutex<Vec<PadEvent>>>,
        fail_first: Arc<AtomicBool>,
    }
    impl gamepad::Device for Device {
        fn update(&mut self, report: gamepad::Report) -> Result<()> {
            ensure!(
                !(self.id == 1 && self.fail_first.load(Ordering::SeqCst)),
                "fixture_device_failed"
            );
            self.events
                .lock()
                .unwrap()
                .push(PadEvent::Report(self.id, report.buttons));
            Ok(())
        }
        fn reset(&mut self) -> Result<()> {
            self.events.lock().unwrap().push(PadEvent::Reset(self.id));
            Ok(())
        }
    }
    impl Drop for Device {
        fn drop(&mut self) {
            self.events.lock().unwrap().push(PadEvent::Closed(self.id));
        }
    }
    let events = Arc::new(Mutex::new(vec![]));
    let created = Arc::new(AtomicUsize::new(0));
    let fail_first = Arc::new(AtomicBool::new(false));
    let backend = gamepad::Backend::with_open(Arc::new({
        let (events, created, fail_first) = (events.clone(), created.clone(), fail_first.clone());
        move || {
            Ok(Box::new(Device {
                id: created.fetch_add(1, Ordering::SeqCst) + 1,
                events: events.clone(),
                fail_first: fail_first.clone(),
            }))
        }
    }));
    let recording = Arc::new(Mutex::new(Recording::default()));
    let d = Desktop::with_backend(Box::new(Recorder(recording.clone())), Some(backend));
    let (s, mut replies, view) = source(&d);
    assert_eq!(
        view.borrow().gamepad,
        cfg!(target_os = "windows").then_some(true)
    );
    s.set_mode(Mode::Ask).unwrap();
    s.set_simultaneous(true).unwrap();
    let mut a = Client::new(&s);
    let ga = a.approve(&s, &mut replies);
    let mut b = Client::new(&s);
    let gb = b.approve(&s, &mut replies);
    let report = |grant: &str, buttons: u32| json!({"type":"gamepad","grant":grant,"gamepad":{"buttons":buttons,"leftTrigger":0,"rightTrigger":0,"leftX":0,"leftY":0,"rightX":0,"rightY":0}});
    a.send(&s, report(&ga, 1 << 17));
    assert_eq!(
        created.load(Ordering::SeqCst),
        0,
        "invalid reports cannot allocate or fail a Pad"
    );
    s.run(|_, state| {
        assert!(!state.controllers[&a.id].pad_failed);
        Ok(())
    })
    .unwrap();
    async fn until(mut check: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !check() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    until(|| {
        a.send(&s, report(&ga, 1));
        events.lock().unwrap().contains(&PadEvent::Report(1, 1))
    })
    .await;
    until(|| {
        b.send(&s, report(&gb, 2));
        events.lock().unwrap().contains(&PadEvent::Report(2, 2))
    })
    .await;
    a.send(&s, json!({"type":"gamepad-reset","grant":ga}));
    until(|| events.lock().unwrap().contains(&PadEvent::Reset(1))).await;
    assert!(!events.lock().unwrap().contains(&PadEvent::Closed(1)));
    recording.lock().unwrap().suspended = true;
    d.tick();
    until(|| {
        let events = events.lock().unwrap();
        events
            .iter()
            .filter(|event| **event == PadEvent::Reset(1))
            .count()
            >= 2
            && events.contains(&PadEvent::Reset(2))
    })
    .await;
    assert!(!events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, PadEvent::Closed(_))));
    recording.lock().unwrap().suspended = false;
    d.tick();
    assert_eq!(created.load(Ordering::SeqCst), 2);
    a.send(&s, json!({"type":"sync"}));
    assert_eq!(a.state(&mut replies)["grant"], ga);
    fail_first.store(true, Ordering::SeqCst);
    a.send(&s, report(&ga, 4));
    until(|| {
        d.tick();
        let executor = d.0.lock().unwrap();
        executor.sources[&s.video()].controllers[&a.id].pad_failed
    })
    .await;
    a.send(&s, json!({"type":"sync"}));
    let state = a.state(&mut replies);
    assert_eq!(state["grant"], ga);
    assert_eq!(state["reason"], "gamepad");
    assert!(!state["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("gamepad")));
    a.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":ga}),
    );
    assert_eq!(
        recording.lock().unwrap().events.last(),
        Some(&Action::Held(
            Held::Key(keyboard::scan("KeyA").unwrap()),
            true
        ))
    );
    until(|| {
        b.send(&s, report(&gb, 8));
        events.lock().unwrap().contains(&PadEvent::Report(2, 8))
    })
    .await;
    b.send(&s, json!({"type":"sync"}));
    assert!(b.state(&mut replies)["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("gamepad")));
    b.send(&s, json!({"type":"gamepad-stop","grant":gb}));
    until(|| events.lock().unwrap().contains(&PadEvent::Closed(2))).await;
    until(|| {
        b.send(&s, report(&gb, 16));
        events.lock().unwrap().contains(&PadEvent::Report(3, 16))
    })
    .await;
    s.retire(b.id, b.flow).unwrap();
    until(|| events.lock().unwrap().contains(&PadEvent::Closed(3))).await;
    let mut last = Client::new(&s);
    let grant = last.approve(&s, &mut replies);
    until(|| {
        last.send(&s, report(&grant, 32));
        events.lock().unwrap().contains(&PadEvent::Report(4, 32))
    })
    .await;
    d.close();
    assert!(events.lock().unwrap().contains(&PadEvent::Closed(4)));
    assert!(recording.lock().unwrap().events.contains(&Action::Held(
        Held::Key(keyboard::scan("KeyA").unwrap()),
        false
    )));
}

#[test]
fn simultaneous_holds_are_per_grant_text_is_single_controller_and_drop_cleans_up() {
    let (d, r) = desktop();
    let (s, mut replies, _) = source(&d);
    s.set_mode(Mode::Ask).unwrap();
    s.set_simultaneous(true).unwrap();
    let mut a = Client::new(&s);
    let ga = a.approve(&s, &mut replies);
    let mut b = Client::new(&s);
    let gb = b.approve(&s, &mut replies);
    a.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":ga}),
    );
    b.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":gb}),
    );
    b.send(&s, json!({"type":"text","text":"不能插入","grant":gb}));
    assert_eq!(r.lock().unwrap().events.len(), 1);
    s.retire(a.id, a.flow).unwrap();
    assert_eq!(r.lock().unwrap().events.len(), 1);
    b.send(&s, json!({"type":"text","text":"Piik 😀","grant":gb}));
    assert_eq!(
        &r.lock().unwrap().events[1..],
        &[
            Action::Held(Held::Key(keyboard::scan("KeyA").unwrap()), false),
            Action::Text("Piik 😀".into())
        ]
    );
    b.send(
        &s,
        json!({"type":"button","button":2,"down":true,"grant":gb}),
    );
    let clone = s.clone();
    drop(s);
    assert_eq!(r.lock().unwrap().events.len(), 4);
    drop(clone);
    assert_eq!(
        r.lock().unwrap().events.last(),
        Some(&Action::Held(Held::Button(2), false))
    );
}

#[test]
fn room_password_and_exclusive_source_ownership_share_the_same_grant_path() {
    let (d, _) = desktop();
    let (a, mut ra, _) = source(&d);
    let (b, mut rb, _) = source(&d);
    a.set_mode(Mode::Room).unwrap();
    b.set_policy(Mode::Password, "private").unwrap();
    let mut ca = Client::new(&a);
    let mut cb = Client::new(&b);
    cb.send(
        &b,
        json!({"type":"request","intent":Uuid::new_v4(),"password":"bad"}),
    );
    assert_eq!(cb.state(&mut rb)["reason"], "password");
    cb.send(
        &b,
        json!({"type":"request","intent":Uuid::new_v4(),"password":"private"}),
    );
    assert_eq!(cb.state(&mut rb)["reason"], "retry");
    ca.send(&a, json!({"type":"request","intent":Uuid::new_v4()}));
    assert_eq!(ca.state(&mut ra)["state"], "active");
    // Advance the existing policy deadline rather than sleeping in a test.
    b.run(|_, source| {
        source.password_retry = None;
        Ok(())
    })
    .unwrap();
    let rejected = Uuid::new_v4();
    let packet = cb.packet(json!({"type":"request","intent":rejected,"password":"private"}));
    assert!(b.receive(cb.id, cb.flow, &packet).is_err());
    let response = cb.state(&mut rb);
    assert_eq!(response["reason"], "busy");
    assert_eq!(response["intent"], rejected.simple().to_string());
    a.close();
    b.run(|_, source| {
        source.password_retry = None;
        Ok(())
    })
    .unwrap();
    cb.send(
        &b,
        json!({"type":"request","intent":Uuid::new_v4(),"password":"private"}),
    );
    assert_eq!(cb.state(&mut rb)["state"], "active");
    b.set_mode(Mode::Off).unwrap();
    assert!(cb.state(&mut rb).get("grant").is_none());
}

#[test]
fn registered_route_replacement_and_cipher_replay_cannot_reuse_a_grant() {
    let (d, r) = desktop();
    let (s, mut replies, _) = source(&d);
    s.set_mode(Mode::Ask).unwrap();
    let mut c = Client::new(&s);
    let grant = c.approve(&s, &mut replies);
    let packet = c.packet(json!({"type":"key","code":"KeyA","down":true,"grant":grant}));
    s.receive(c.id, c.flow, &packet).unwrap();
    s.receive(c.id, c.flow, &packet).unwrap();
    assert_eq!(r.lock().unwrap().events.len(), 1);
    let old = c.flow;
    c.flow = Uuid::new_v4();
    s.register(Registration {
        controller: c.id,
        flow: c.flow,
        secret: c.key,
    })
    .unwrap();
    s.receive(c.id, old, &packet).unwrap();
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    assert_eq!(r.lock().unwrap().events.len(), 2);
    assert_eq!(c.state(&mut replies)["state"], "ready");
}

#[test]
fn source_replacement_retires_consent_without_rewinding_registered_cipher() {
    for ended_before_replacement in [false, true] {
        let (desktop, recording) = desktop();
        let (old, mut replies, old_view) = source(&desktop);
        old.set_mode(Mode::Room).unwrap();
        let mut client = Client::new(&old);
        let request = client.packet(json!({"type":"request","intent":Uuid::new_v4()}));
        old.receive(client.id, client.flow, &request).unwrap();
        let grant = client.state(&mut replies)["grant"]
            .as_str()
            .unwrap()
            .to_string();
        client.send(
            &old,
            json!({"type":"key","code":"ShiftLeft","down":true,"grant":grant}),
        );
        client.send(
            &old,
            json!({"type":"button","button":0,"down":true,"grant":grant}),
        );
        for _ in 0..4 {
            client.send(&old, json!({"type":"sync"}));
        }
        let (previous_sequence, _) = client.state_packet(&mut replies);
        let target = Target {
            kind: crate::capture::TargetKind::Display,
            source_id: "2".into(),
            title: "replacement".into(),
            pid: 0,
            creation_time: None,
        };
        if ended_before_replacement {
            old.retire_capture();
            desktop.tick();
            assert!(old.set_mode(Mode::Room).is_err());
            client.send(
                &old,
                json!({"type":"key","code":"KeyB","down":true,"grant":grant}),
            );
            client.send(&old, json!({"type":"request","intent":Uuid::new_v4()}));
            let state = client.state(&mut replies);
            assert_eq!(state["state"], "unavailable");
            assert!(state.get("grant").is_none());
            assert!(old_view.borrow().requests.is_empty());
            assert_eq!(recording.lock().unwrap().events.len(), 4);
            old.retire_capture(); // A later completion/lease stop is idempotent.
            desktop.tick();
        }
        let (current, mut replies, view) = old.replace(Uuid::new_v4(), target).unwrap();
        current
            .register(Registration {
                controller: client.id,
                flow: client.flow,
                secret: client.key,
            })
            .unwrap();
        let (next_sequence, state) = client.state_packet(&mut replies);
        assert_eq!(state["state"], "unavailable");
        assert!(state.get("grant").is_none());
        assert_eq!(view.borrow().mode, Mode::Off);
        assert_eq!(
            recording.lock().unwrap().events.len(),
            4,
            "both holds were released"
        );
        current.set_mode(Mode::Room).unwrap();
        client.state(&mut replies);
        current.receive(client.id, client.flow, &request).unwrap();
        assert!(next_sequence > previous_sequence && view.borrow().requests.is_empty(),
        "replacement reset cipher: previous={previous_sequence}, next={next_sequence}, replayed requests={}", view.borrow().requests.len());
        old.retire_capture();
        old.close();
        drop(old);
        let next_grant = client.approve(&current, &mut replies);
        assert_ne!(grant, next_grant);
        assert_eq!(view.borrow().mode, Mode::Room);
        client.send(
            &current,
            json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
        );
        assert_eq!(
            recording.lock().unwrap().events.len(),
            4,
            "old grant cannot execute input"
        );
        client.send(
            &current,
            json!({"type":"key","code":"KeyA","down":true,"grant":next_grant}),
        );
        current.close();
        assert_eq!(recording.lock().unwrap().events.len(), 6);
    }
}

#[test]
fn input_event_parse_and_bounds_reject_unrecognized_or_unbounded_input() {
    for value in [
        json!({"type":"key","grant":"token","code":"KeyA","down":true}),
        json!({"type":"reset","grant":"token"}),
    ] {
        assert!(matches!(
            serde_json::from_value::<Command>(value).unwrap(),
            Command::Input { .. }
        ));
    }
    assert!(InputEvent::Move { x: 1.1, y: 0.0 }.action().is_none());
    assert!(InputEvent::Text {
        text: "x".repeat(2049)
    }
    .action()
    .is_none());
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    assert_eq!(keyboard::scan("ControlRight"), Some(0xe01d));
    #[cfg(target_os = "linux")]
    {
        assert_eq!(keyboard::scan("ControlRight"), Some(97));
        assert_eq!(
            InputEvent::Key {
                code: "Pause".into(),
                down: true,
            }
            .action(),
            Some(Action::Held(Held::Key(119), true))
        );
    }
    #[cfg(target_os = "macos")]
    assert_eq!(keyboard::scan("ControlRight"), Some(62));
    assert_eq!(keyboard::scan("invented"), None);
}

#[test]
fn browser_webcrypto_vector_authenticates_direction_epoch_and_sequence() {
    // Generated by Node WebCrypto AES-GCM, matching EncryptedInput's browser API:
    // key=00..1f, nonce=20..2b, seq=1, direction=0, ASCII simple UUID epoch.
    let secret = std::array::from_fn(|i| i as u8);
    let flow = Uuid::parse_str("0123456789abcdef0123456789abcdef").unwrap();
    let packet = "AAAAAAAAAAEgISIjJCUmJygpKiupGNIJHP04NDgPO6CiOol+MAJ012RUZOuDGCEWCIGW";
    let mut cipher = Cipher::new(&secret);
    assert!(cipher.open(packet, Uuid::new_v4()).is_err());
    assert_eq!(cipher.open(packet, flow).unwrap(), br#"{"type":"sync"}"#);
    assert!(cipher.open(packet, flow).is_err());
    let state = cipher.seal(br#"{"state":"ready"}"#, flow).unwrap();
    let bytes = STANDARD.decode(&state).unwrap();
    let plain = Aes256Gcm::new((&secret).into())
        .decrypt(
            Nonce::from_slice(&bytes[8..20]),
            Payload {
                msg: &bytes[20..],
                aad: &auth(1, &bytes[..8], flow),
            },
        )
        .unwrap();
    assert_eq!(plain, br#"{"state":"ready"}"#);
    assert!(
        Cipher::new(&secret).open(&state, flow).is_err(),
        "reflected reply is not controller input"
    );
}

#[test]
fn local_stop_requires_fresh_consent_and_reply_backpressure_cleans_up_holds() {
    let (d, r) = desktop();
    let (s, mut replies, view) = source(&d);
    s.set_mode(Mode::Room).unwrap();
    let mut c = Client::new(&s);
    let intent = Uuid::new_v4();
    c.send(&s, json!({"type":"request","intent":intent}));
    let grant = c.state(&mut replies)["grant"].as_str().unwrap().to_string();
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    for _ in 0..65 {
        c.send(&s, json!({"type":"sync"}));
    }
    assert!(view.borrow().requests.is_empty());
    assert_eq!(
        r.lock().unwrap().events.last(),
        Some(&Action::Held(
            Held::Key(keyboard::scan("KeyA").unwrap()),
            false
        ))
    );
    while replies.try_recv().is_ok() {}
    c.send(&s, json!({"type":"sync"}));
    let state = c.state(&mut replies);
    assert_eq!(state["state"], "ready");
    assert_eq!(state["intent"], intent.simple().to_string());
    assert!(state.get("grant").is_none());
    d.revoke();
    assert_eq!(view.borrow().mode, Mode::Ask);
    c.send(&s, json!({"type":"request","intent":Uuid::new_v4()}));
    assert_eq!(c.state(&mut replies)["state"], "pending");
}

#[test]
fn carrier_release_preserves_replay_counter_and_allows_fresh_consent() {
    let (d, r) = desktop();
    let (s, mut replies, view) = source(&d);
    s.set_mode(Mode::Room).unwrap();
    let mut c = Client::new(&s);
    let request = c.packet(json!({"type":"request","intent":Uuid::new_v4()}));
    s.receive(c.id, c.flow, &request).unwrap();
    let grant = c.state(&mut replies)["grant"].as_str().unwrap().to_string();
    c.send(
        &s,
        json!({"type":"key","code":"KeyA","down":true,"grant":grant}),
    );
    s.release(c.id, c.flow).unwrap();
    assert!(view.borrow().requests.is_empty());
    assert_eq!(r.lock().unwrap().events.len(), 2);
    s.receive(c.id, c.flow, &request).unwrap();
    assert!(
        view.borrow().requests.is_empty(),
        "reopening a carrier cannot replay its old request"
    );
    c.send(&s, json!({"type":"request","intent":Uuid::new_v4()}));
    let state = c.state(&mut replies);
    assert_eq!(state["state"], "active");
    assert_ne!(state["grant"], grant);
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn windows_stop_pending_respects_consent_and_releases_held_input() {
    use crate::windows_hotkeys::Activation;
    let (d, recording) = desktop();
    let (s, mut replies, view) = source(&d);
    s.set_mode(Mode::Room).unwrap();
    let pending = d.0.lock().unwrap().stop_pending.clone();
    pending.signal(Activation::StopChord);
    assert!(!pending.take());
    let mut c = Client::new(&s);
    c.send(&s, json!({"type":"request","intent":Uuid::new_v4()}));
    let grant = c.state(&mut replies)["grant"].clone();
    c.send(&s, json!({"type":"key","grant":grant,"code":"ShiftLeft","down":true}));
    pending.signal(Activation::StopChord);
    d.tick_when_needed(&mut None).await;
    assert_eq!(view.borrow().mode, Mode::Ask);
    assert_eq!(recording.lock().unwrap().events.len(), 2);
    pending.signal(Activation::Registered(0));
    pending.signal(Activation::StopChord);
    assert!(pending.take());
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn windows_stop_ordering_active_chord_survives_release() {
    use crate::windows_hotkeys::Activation;
    let (desktop, _) = desktop();
    let (source, mut replies, view) = source(&desktop);
    source.set_mode(Mode::Room).unwrap();
    let mut client = Client::new(&source);
    client.send(&source, json!({"type":"request","intent":Uuid::new_v4()}));
    assert_eq!(client.state(&mut replies)["state"], "active");
    desktop.0.lock().unwrap().stop_pending.signal(Activation::StopChord);
    source.release(client.id, client.flow).unwrap();
    desktop.tick_when_needed(&mut None).await;
    assert_eq!(view.borrow().mode, Mode::Ask);
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn windows_stop_ordering_idle_chord_preserves_later_grant() {
    use crate::windows_hotkeys::Activation;
    let (desktop, _) = desktop();
    let (source, mut replies, view) = source(&desktop);
    source.set_mode(Mode::Room).unwrap();
    desktop.0.lock().unwrap().stop_pending.signal(Activation::StopChord);
    let mut client = Client::new(&source);
    client.send(&source, json!({"type":"request","intent":Uuid::new_v4()}));
    assert_eq!(client.state(&mut replies)["state"], "active");
    desktop.tick_when_needed(&mut None).await;
    assert_eq!(view.borrow().mode, Mode::Room);
    assert!(desktop.0.lock().unwrap().owner.is_some());
}

#[cfg(target_os = "windows")]
#[tokio::test]
#[ignore = "scoped Windows hotkey registration; posts only to its own queue, never types desktop input"]
async fn windows_hotkey_revokes_and_unregisters_on_process_close() {
    let (d, _) = desktop();
    let (s, mut replies, mut view) = source(&d);
    s.set_mode(Mode::Room).unwrap();
    let mut c = Client::new(&s);
    c.send(&s, json!({"type":"request","intent":Uuid::new_v4()}));
    assert_eq!(c.state(&mut replies)["state"], "active");
    assert!(view.borrow().stop_shortcut.is_none());
    let key = (1..=11)
        .find(|key| d.set_shortcut(*key).is_ok())
        .expect("one free Ctrl+Alt+Fn key for scoped fixture");
    assert_eq!(view.borrow().stop_shortcut, Some(key));
    d.set_shortcut(key).unwrap();
    d.1.lock().unwrap().as_ref().unwrap().notify_test().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut timer = None;
        while d.0.lock().unwrap().owner.is_some() {
            d.tick_when_needed(&mut timer).await;
        }
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if view.borrow().mode == Mode::Ask && view.borrow().requests.is_empty() {
                break;
            }
            view.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    d.close();
    assert!(d.1.lock().unwrap().is_none());
    // The exact same chord can be acquired by another process owner afterward.
    let (other, _) = desktop();
    other.set_shortcut(key).unwrap();
    other.close();
}

#[cfg(all(feature = "capture", target_os = "linux"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires isolated desktop Portal consent, cancellation marker and actual shortcut activation"]
async fn linux_global_shortcut_cancels_revokes_and_closes() -> Result<()> {
    let stage = std::env::var("PIIK_LINUX_SHORTCUT_STAGE")?;
    let cancel = std::env::var("PIIK_LINUX_SHORTCUT_CANCEL")?;
    let (desktop, recording) = desktop();
    let (source, mut replies, mut view) = source(&desktop);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !view.borrow().can_set_stop_shortcut {
            view.changed().await?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    assert_eq!(view.borrow().stop_shortcut_label, Some(None));
    assert!(view.borrow().stop_shortcut.is_none());
    let pending = source.set_shortcut(10)?;
    std::fs::write(&stage, "cancel-pending")?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while !std::path::Path::new(&cancel).exists() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
    source.set_mode(Mode::Off)?;
    assert!(tokio::time::timeout(Duration::from_secs(5), pending)
        .await?
        .is_err());
    assert_eq!(view.borrow().stop_shortcut_label, Some(None));

    std::fs::write(&stage, "approve")?;
    tokio::time::timeout(Duration::from_secs(90), source.set_shortcut(10)?).await??;
    let label = view
        .borrow()
        .stop_shortcut_label
        .clone()
        .flatten()
        .ok_or_else(|| anyhow!("missing actual shortcut"))?;
    source.set_shortcut(10)?.await?;
    source.set_mode(Mode::Room)?;
    let mut client = Client::new(&source);
    client.send(&source, json!({"type":"request","intent":Uuid::new_v4()}));
    let state = client.state(&mut replies);
    assert_eq!(state["state"], "active");
    client.send(
        &source,
        json!({"type":"key","code":"KeyA","down":true,"grant":state["grant"]}),
    );
    std::fs::write(&stage, format!("activate:{label}"))?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while view.borrow().mode != Mode::Ask || !view.borrow().requests.is_empty() {
            view.changed().await?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    assert_eq!(
        recording.lock().unwrap().events.len(),
        2,
        "held key must be released by local stop"
    );
    assert_eq!(view.borrow().stop_shortcut, Some(10));
    assert_eq!(view.borrow().stop_shortcut_label, Some(Some(label)));
    assert!(
        source.run(|_, _| Ok(())).is_ok(),
        "stop preserves the source"
    );
    desktop.close();
    assert!(!desktop.1.view().available);
    assert!(desktop.1.view().key.is_none());
    std::fs::write(&stage, "complete")?;
    Ok(())
}

#[cfg(all(feature = "capture", target_os = "linux"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the isolated desktop's owned input window and attended Portal consent"]
async fn linux_portal_grant_delivers_encrypted_input_to_owned_window() -> Result<()> {
    let events = std::env::var("PIIK_LINUX_INPUT_EVENTS")?;
    let before = std::fs::read_to_string(&events)?;
    ensure!(
        before.contains("piik-linux-input"),
        "owned input fixture is not ready"
    );
    let target = tokio::task::spawn_blocking(crate::capture::targets)
        .await??
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no system picker"))?;
    let capture = crate::capture::Capture::start(target.clone(), 30, false)?;
    let desktop = Desktop::new()?;
    let (source, mut replies, _) = desktop.source(Uuid::new_v4(), Uuid::new_v4(), target)?;
    let control = capture.control();
    let authorized = source.clone();
    eprintln!("Input check: approve the owned screen, then its Remote Desktop permission");
    let result: Result<()> = async {
        tokio::time::timeout(Duration::from_secs(90), source.configure(Mode::Room, None, None,
            move |request| async move { control.authorize(authorized, request).await })?).await??;
        ensure!(source.has_endpoint(), "Portal input endpoint was not installed");
        let mut client = Client::new(&source);
        client.send(&source, json!({"type":"request","intent":Uuid::new_v4()}));
        let state = client.state(&mut replies);
        ensure!(state["state"] == "active", "controller is not active: {state}");
        let grant = state["grant"].as_str().ok_or_else(|| anyhow!("missing grant"))?;
        client.send(&source, json!({"type":"move","x":0.5,"y":0.5,"grant":grant}));
        for down in [true, false] {
            client.send(&source, json!({"type":"button","button":0,"down":down,"grant":grant}));
        }
        for code in ["KeyP", "KeyI", "KeyI", "KeyK", "Enter"] {
            for down in [true, false] {
                client.send(&source, json!({"type":"key","code":code,"down":down,"grant":grant}));
            }
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let actual = std::fs::read_to_string(&events)?;
                let actual = &actual[before.len()..];
                if actual.contains("\"text\": \"piik\"") && actual.contains("\"key\": \"Return\"")
                    && actual.contains("\"event\": \"button-press\"") && actual.contains("\"event\": \"motion\"") {
                    eprintln!("Input check: the owned GTK window received piik, Enter, mouse motion and click");
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await??;
        Ok(())
    }.await;
    source.close();
    desktop.close();
    let stopped = tokio::task::spawn_blocking(move || capture.stop()).await?;
    result.and(stopped)
}
