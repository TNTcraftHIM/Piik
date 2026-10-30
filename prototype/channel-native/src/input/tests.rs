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
            last = Some(serde_json::from_slice(&plain).unwrap());
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
    s.close();
    d.tick();
    assert_eq!(r.lock().unwrap().events.len(), 4);
    r.lock().unwrap().fail_release = false;
    d.tick();
    d.tick();
    assert_eq!(r.lock().unwrap().events.len(), 5);
    assert!(r.lock().unwrap().events[2..]
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
    let packet = cb.packet(json!({"type":"request","intent":Uuid::new_v4(),"password":"private"}));
    assert!(b.receive(cb.id, cb.flow, &packet).is_err());
    assert_eq!(cb.state(&mut rb)["reason"], "busy");
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
    #[cfg(not(target_os = "macos"))]
    assert_eq!(keyboard::scan("ControlRight"), Some(0xe01d));
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
    c.send(&s, json!({"type":"request","intent":Uuid::new_v4()}));
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
    assert_eq!(c.state(&mut replies)["state"], "ready");
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
