use piik_channel_core::{
    conversation::{ConversationAddress, ConversationCommand, ConversationRequest, SessionSigner},
    host::RoomSummary,
    input::InputRegistration,
    wire::{Event, ReplyResult, Request, RoomAccess, Signal, UdpObservation, UdpSignal},
    wire_images::{StateImageDecoder, StateImageEncoder},
    Authority, Effects, RoomState, PRODUCT_VERSION,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn emitted(effects: &Effects, is_fixture: impl Fn(&Event) -> bool) -> &Event {
    effects
        .events
        .iter()
        .map(|(_, event)| event)
        .find(|event| is_fixture(event))
        .expect("Domain emitted the fixture")
}

#[test]
#[deny(unreachable_patterns)]
fn native_reader_accepts_every_known_domain_event() {
    // These rows supply both the decoder checks and the exhaustive match over Event.
    macro_rules! fixtures {
        ($($variant:ident => $event:expr,)*) => {{
            let variant = |event: Event| match event {
                $(Event::$variant { .. } => stringify!($variant),)*
                Event::Deferred { .. } => "internal completion",
                Event::ConversationWelcome { .. } | Event::ConversationState { .. } => {
                    "serialize-only conversation snapshot"
                }
                Event::Unknown => "unknown event",
            };
            let mut encoder = StateImageEncoder::default();
            let mut decoder = StateImageDecoder::default();
            $(
                let expected = stringify!($variant);
                let frame = encoder
                    .encode($event)
                    .unwrap_or_else(|error| panic!("encode {expected}: {error}"));
                let decoded = decoder
                    .decode(&frame)
                    .unwrap_or_else(|error| panic!("decode {expected}: {error}"));
                assert_eq!(variant(decoded), expected);
            )*
        }};
    }

    let mut authority = Authority::new("owner".into(), vec![]).unwrap();
    let connection = Uuid::from_u128(1);
    let signer = SessionSigner::from_seed([1; 32]);
    let mut command =
        |input: Value| authority.handle(connection, Request::parse(&input.to_string()).unwrap(), 0);
    let admitted = command(json!({
        "type": "join", "major": PRODUCT_VERSION.major, "minor": PRODUCT_VERSION.minor,
        "canUsePeerTransport": false, "name": "Owner", "ownerKey": "owner",
        "signingKey": signer.signing_key(),
    }));
    let greeting = emitted(&admitted, |event| matches!(event, Event::Welcome { .. }));
    let Event::Welcome {
        self_profile,
        session_id,
        ..
    } = greeting
    else {
        unreachable!()
    };
    let room = RoomState::new(
        "room".into(),
        "Friends".into(),
        Default::default(),
        self_profile.id,
        RoomAccess::Public,
        false,
        None,
    )
    .unwrap();
    let created = command(
        json!({"type": "create_room", "room": RoomSummary::from_policy(&room), "requestId": "create"}),
    );
    let reply = emitted(&created, |event| matches!(event, Event::Reply { .. }));
    let Event::Reply {
        result: ReplyResult::RoomCreated { room },
        ..
    } = reply
    else {
        panic!("Domain created the room")
    };
    let registered = command(json!({"type": "host_register", "room": room}));
    let bound = emitted(&registered, |event| {
        matches!(event, Event::HostBound { .. })
    });
    let Event::HostBound { binding_id, .. } = bound else {
        unreachable!()
    };
    let peer_session = Uuid::from_u128(2);
    let conversation = ConversationRequest {
        address: ConversationAddress {
            room_id: room.id.clone(),
            binding_id: *binding_id,
            sender: *session_id,
            recipient: peer_session,
            request_id: "history".into(),
        },
        command: ConversationCommand::History {
            before: None,
            parts: vec!["inlineImages".into()],
        },
    };
    let refused = Request::parse_first(
        &json!({"type": "join", "major": PRODUCT_VERSION.major ^ 1, "minor": PRODUCT_VERSION.minor})
            .to_string(),
    )
    .err()
    .expect("Domain refused the incompatible major");

    fixtures! {
        Welcome => greeting,
        State => emitted(&created, |event| matches!(event, Event::State { .. })),
        Reply => reply,
        HostBound => bound,
        HostInput => emitted(&registered, |event| matches!(event, Event::HostInput { .. })),
        IncompatibleVersion => refused.as_ref(),
        InputState => &Event::InputState {
            registrations: vec![InputRegistration {
                publication_id: Uuid::from_u128(3),
                controller_session_id: peer_session,
                flow_id: Uuid::from_u128(4),
                secret: [9; 32],
            }],
        },
        Conversation => &Event::Conversation {
            packet: signer.sign(*session_id, &conversation).unwrap(),
        },
        Signal => &Event::Signal {
            pair_id: Uuid::from_u128(5),
            from_session_id: peer_session,
            payload: Signal {
                udp: Some(UdpSignal::Offer {
                    secret: [7; 32],
                    observation: UdpObservation::Observed {
                        address: "203.0.113.5".parse().unwrap(),
                        port: 42000,
                    },
                }),
                resync: None,
                exchange_id: None,
                description: None,
                candidate: None,
                tracks: None,
            },
        },
        Error => &Event::completion(
            None,
            Some(room.id.clone()),
            ReplyResult::Error { code: "room_access_required".into() },
        ),
    }
}

#[test]
fn native_reader_distinguishes_future_and_malformed_events() {
    let mut decoder = StateImageDecoder::default();
    assert!(matches!(
        decoder.decode(r#"{"type":"later_notice","requestId":"a"}"#),
        Ok(Event::Unknown)
    ));
    assert_eq!(
        decoder
            .decode(r#"{"type":"reply","requestId":"a","result":{"type":"invite"}}"#)
            .err(),
        Some("invalid_channel_event")
    );
}
