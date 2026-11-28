use piik_channel_core::{backup::HistoryRow, conversation::ConversationRecord};
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn live_messages_and_archived_history_share_fields_with_different_extension_rules() {
    let user = Uuid::new_v4();
    let image = Uuid::new_v4().to_string();
    let message = json!({
        "seq": 2, "id": Uuid::new_v4(), "userId": user, "text": "@Sam", "time": 1,
        "mentions": [{"userId": user, "start": 0, "end": 4}],
        "reply": {"seq": 1, "userId": user, "text": "Hello", "notify": false},
        "attachments": [{"id": image, "name": "pic.gif", "size": 10,
            "sha256": "a".repeat(64), "mediaType": "image/gif"}],
        "inlineImages": {(image.clone()): {"data": "R0lGODlhZGVm", "width": 1,
            "height": 1, "mediaType": "image/gif", "original": false}}
    });
    let archive = |mut message: Value| {
        message["nonce"] = json!("example");
        message["reactions"] = json!({"revision": 0, "counts": {}});
        serde_json::from_value::<HistoryRow>(message)
    };
    archive(message.clone()).unwrap().validate().unwrap();
    let rendition = format!("/inlineImages/{image}");
    for path in ["", "/reply", "/mentions/0", "/attachments/0", &rendition] {
        let mut extended = message.clone();
        extended.pointer_mut(path).unwrap()["captionLanguage"] = json!("en");
        let event = json!({"type": "live_message", "message": extended});
        assert!(matches!(
            serde_json::from_value::<ConversationRecord>(event).unwrap(),
            ConversationRecord::LiveMessage { .. }
        ));
        assert!(archive(extended).is_err(), "{path}");
    }
}