use super::*;

#[test]
fn decorative_icon_keys_are_bounded_but_not_a_preset_enum() {
    let key = "future-Preset_42";
    let icon: IdentityIcon = serde_json::from_value(serde_json::json!(key)).unwrap();
    assert_eq!(serde_json::to_value(icon).unwrap(), key);
    for invalid in [
        String::new(),
        "x".repeat(65),
        "https://example.com/icon".into(),
        "two words".into(),
    ] {
        assert!(serde_json::from_value::<IdentityIcon>(serde_json::json!(invalid)).is_err());
    }
}

#[test]
fn unknown_sender_fields_fail_with_the_request_id_intact() {
    let request = Request::parse(
        r#"{"type":"chat","requestId":"operation","roomId":"living","text":"spoof","nonce":"n","userId":"other"}"#,
    );
    assert!(
        matches!(request, Err((Some(request_id), "invalid_request")) if request_id == "operation")
    );
}

#[test]
fn text_limits_match_browser_utf16_and_room_history() {
    let mut channel = Channel::new("owner".into(), "invite".into(), vec![]);
    let owner = channel
        .join(
            Admission {
                name: "Owner",
                credential: None,
                key: Some("owner"),
                resume: None,
                signing_key: crate::conversation::SessionSigner::from_seed([1; 32]).signing_key(),
            },
            Uuid::new_v4(),
            0,
        )
        .unwrap();
    assert!(channel
        .handle(
            owner.session_id,
            Command::SetName {
                name: "\u{1f600}".repeat(21)
            },
            0
        )
        .is_err());
    assert!(channel
        .handle(
            owner.session_id,
            Command::UpdateDomain {
                name: "\u{1f600}".repeat(33),
                icon: Default::default(),
            },
            0
        )
        .is_err());
    assert!(channel
        .handle(
            owner.session_id,
            Command::UpdateDomain {
                name: "   ".into(),
                icon: Default::default(),
            },
            0
        )
        .is_err());
    channel
        .handle(
            owner.session_id,
            Command::UpdateDomain {
                name: format!(" {} ", "\u{1f600}".repeat(32)),
                icon: Default::default(),
            },
            0,
        )
        .unwrap();
    assert_eq!(
        channel.snapshot(owner.session_id).channel.name,
        "\u{1f600}".repeat(32)
    );
    let mut old = serde_json::to_value(channel.export_state()).unwrap();
    old["version"] = serde_json::json!(3);
    assert_eq!(
        channel.import_state(serde_json::from_value(old).unwrap()),
        Err("invalid_state")
    );
    assert!(crate::history::MessageDraft::new(
        owner.user_id,
        "limit".into(),
        "\u{1f600}".repeat(2000),
        vec![],
        0
    )
    .is_ok());
    assert!(crate::history::MessageDraft::new(
        owner.user_id,
        "excess".into(),
        "\u{1f600}".repeat(2001),
        vec![],
        0
    )
    .is_err());
}
