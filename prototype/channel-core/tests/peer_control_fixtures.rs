use piik_channel_core::{
    conversation::{decode_control, encode_control, ControlFrame},
    file_delivery::FileControl,
    file_room::FileKey,
    watch_delivery::{WatchControl, WatchKey},
};
use serde_json::{json, Value};
use uuid::Uuid;

#[test]
fn peer_control_reader_accepts_each_known_form_and_validates_its_role() {
    use ControlFrame::{File, Watch};
    let file = FileKey {
        room_id: "room".into(),
        message_seq: 7,
        attachment_id: Uuid::from_u128(1),
    };
    let watch = WatchKey {
        room_id: "room".into(),
        activity_id: Uuid::from_u128(2),
        resource_id: Uuid::from_u128(3),
    };
    let request_id = Uuid::from_u128(4);

    // Each constructor also supplies the matching arm for the real receiver enum.
    macro_rules! specimens {
        ($frames:ident; $($family:ident($ty:ident::$op:ident { $($fields:tt)* }) => $meta:expr),+ $(,)?) => {
            #[deny(unreachable_patterns)]
            fn known(frame: &ControlFrame) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
                match frame {
                    $($family($ty::$op { .. }) => Some($meta),)+
                    File(FileControl::Unknown(_)) | Watch(WatchControl::Unknown(_)) => None,
                }
            }
            let $frames = [$( $family($ty::$op { $($fields)* }) ),+];
        };
    }
    specimens! { frames;
        File(FileControl::Pull { key: file.clone(), request_id, offset: 64 }) => ("file", "pull", "request", "offset"),
        File(FileControl::Cancel { key: file.clone(), request_id, offset: 64 }) => ("file", "cancel", "notice", "offset"),
        File(FileControl::Error { key: file, request_id, code: "file_transfer_busy".into() }) => ("file", "error", "reply", "code"),
        Watch(WatchControl::Pull { key: watch.clone(), request_id, offset: 7, length: 1 }) => ("watch", "pull", "request", "length"),
        Watch(WatchControl::Cancel { key: watch.clone(), request_id }) => ("watch", "cancel", "notice", "requestId"),
        Watch(WatchControl::Error { key: watch, request_id, code: "watch_read_busy".into() }) => ("watch", "error", "reply", "code"),
    }
    for frame in frames {
        let (kind, operation, role, required) = known(&frame).unwrap();
        let encoded = encode_control(&frame).unwrap();
        let mut wire: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(wire["kind"], kind);
        assert_eq!(wire["body"]["type"], operation);
        assert_eq!(wire["body"]["role"], role);
        for object in ["", "/body", "/body/key"] {
            wire.pointer_mut(object).unwrap()["extra"] = json!(true);
        }
        let decode = |wire: &Value| decode_control(&serde_json::to_vec(wire).unwrap());
        let decoded = decode(&wire).unwrap();
        assert_eq!(known(&decoded), known(&frame));
        assert_eq!(encode_control(&decoded).unwrap(), encoded);

        for bad_role in [
            if role == "reply" { "request" } else { "reply" },
            "future_role",
        ] {
            wire["body"]["role"] = json!(bad_role);
            assert!(
                decode(&wire).is_err(),
                "{kind}/{operation} accepted {bad_role}"
            );
        }
        let mut future = wire.clone();
        future["body"]["type"] = json!("future");
        future["body"]["role"] = json!("future_role");
        assert!(
            decode(&future).is_err(),
            "{kind} accepted a future operation with an unknown role"
        );
        wire["body"]["role"] = json!(role);
        wire["body"]
            .as_object_mut()
            .unwrap()
            .remove(required)
            .unwrap();
        assert!(
            decode(&wire).is_err(),
            "{kind}/{operation} accepted missing {required}"
        );
    }
}
