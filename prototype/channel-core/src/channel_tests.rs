use super::*;

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
