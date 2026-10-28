#![cfg(feature = "server")]

use piik_channel_prototype::{
    history::HistoryResult,
    host::{HostAction, HostInput, HostOutput, RequestContext, RoomResult},
    wire::{Request, RoomAccess},
    Endpoint, Member, RoomState, StoredRoomHost,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

fn input(owner: Uuid, actor: Uuid, action: impl FnOnce(RequestContext) -> HostAction) -> HostInput {
    HostInput {
        binding_id: owner,
        host_session_id: owner,
        revision: 1,
        endpoints: [owner, actor]
            .into_iter()
            .map(|session| {
                (
                    session,
                    Endpoint {
                        member: Member {
                            user_id: session,
                            participates: true,
                            domain_owner: false,
                        },
                        connected: true,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>(),
        action: action(RequestContext {
            connection: actor,
            session_id: actor,
            request_id: Some("turn".into()),
            now: 1,
        }),
    }
}

fn command(host: &mut StoredRoomHost, owner: Uuid, actor: Uuid, value: Value) -> HostOutput {
    let command = Request::parse(&value.to_string()).unwrap().command;
    host.dispatch(input(owner, actor, |context| HostAction::Command {
        context,
        command,
    }))
    .unwrap()
}

fn policy(id: &str, owner: Uuid, access: RoomAccess) -> RoomState {
    RoomState::new(id.into(), id.into(), owner, access, false, None).unwrap()
}

fn sent(output: HostOutput) -> piik_channel_prototype::history::MessageConfirmation {
    match output.reply.unwrap().result {
        RoomResult::History {
            result: HistoryResult::Sent(confirmation),
        } => confirmation,
        _ => panic!("expected committed message"),
    }
}

#[test]
fn failed_storage_withholds_grant_and_confirmation_then_retry_survives_reopen() {
    let path = std::env::temp_dir().join(format!("piik-stored-room-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("private", owner, RoomAccess::Private)).unwrap();
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_policy BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    let failed = host
        .dispatch(input(owner, viewer, |context| HostAction::GrantInvited {
            context,
        }))
        .unwrap();
    assert!(
        matches!(failed.reply.unwrap().result, RoomResult::Error { code } if code == "storage_failed")
    );
    assert!(!failed.projection.views[&viewer].room.authorized);
    assert!(host.policy().grants.is_empty());
    assert!(StoredRoomHost::open(&path)
        .unwrap()
        .policy()
        .grants
        .is_empty());

    database
        .execute_batch("DROP TRIGGER reject_policy;")
        .unwrap();
    let granted = host
        .dispatch(input(owner, viewer, |context| HostAction::GrantInvited {
            context,
        }))
        .unwrap();
    assert!(matches!(granted.reply.unwrap().result, RoomResult::Invited));
    assert!(granted.projection.views[&viewer].room.authorized);
    // Fail COMMIT after the message INSERT succeeded, using the production SQLite transaction.
    database.execute_batch("CREATE TABLE commit_failure (id TEXT REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_message AFTER INSERT ON message BEGIN INSERT INTO commit_failure VALUES('missing'); END;").unwrap();
    let message = json!({"type":"chat","roomId":"private","nonce":"same-send","text":"Original"});
    let failed = command(&mut host, owner, viewer, message.clone());
    assert!(
        matches!(failed.reply.unwrap().result, RoomResult::Error { code } if code == "storage_failed")
    );
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM message", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    database
        .execute_batch("DROP TRIGGER reject_message;")
        .unwrap();
    let original = sent(command(&mut host, owner, viewer, message));
    assert!(original.inserted);
    assert_eq!(original.message.seq, 1);
    drop(host);

    let mut restored = StoredRoomHost::open(&path).unwrap();
    assert!(restored.policy().grants.contains(&viewer));
    let retry = sent(command(
        &mut restored,
        owner,
        viewer,
        json!({"type":"chat","roomId":"private","nonce":"same-send","text":"Changed retry"}),
    ));
    assert!(!retry.inserted);
    assert_eq!(
        serde_json::to_value(retry.message).unwrap(),
        serde_json::to_value(original.message).unwrap()
    );
    drop(restored);
    drop(database);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn separate_room_databases_reopen_without_overwriting_policy_or_restoring_activity() {
    let owner = Uuid::new_v4();
    let first = std::env::temp_dir().join(format!("piik-stored-first-{}.sqlite", Uuid::new_v4()));
    let second = std::env::temp_dir().join(format!("piik-stored-second-{}.sqlite", Uuid::new_v4()));
    assert!(StoredRoomHost::open(&first).is_err());
    assert!(!first.exists(), "open must not create a missing room");
    let mut a = StoredRoomHost::create(&first, policy("first", owner, RoomAccess::Public)).unwrap();
    let mut b =
        StoredRoomHost::create(&second, policy("second", owner, RoomAccess::Public)).unwrap();
    assert!(
        StoredRoomHost::create(&first, policy("replacement", owner, RoomAccess::Public)).is_err()
    );
    for (host, room) in [(&mut a, "first"), (&mut b, "second")] {
        command(
            host,
            owner,
            owner,
            json!({"type":"update_room","roomId":room,"name":format!("Saved {room}"),"access":"public","hidden":false}),
        );
        let result = sent(command(
            host,
            owner,
            owner,
            json!({"type":"chat","roomId":room,"nonce":"same-send","text":room}),
        ));
        assert_eq!(result.message.seq, 1);
        command(
            host,
            owner,
            owner,
            json!({"type":"browse","roomId":room,"active":true}),
        );
        command(
            host,
            owner,
            owner,
            json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","muted":false}}),
        );
    }
    drop((a, b));
    for (path, room) in [(&first, "first"), (&second, "second")] {
        let mut restored = StoredRoomHost::open(path).unwrap();
        assert_eq!(restored.policy().id, room);
        assert_eq!(restored.summary().name, format!("Saved {room}"));
        let output = command(
            &mut restored,
            owner,
            owner,
            json!({"type":"history","roomId":room}),
        );
        assert!(!output.projection.views[&owner].room.reading);
        assert!(output.projection.views[&owner].publications.is_empty());
        assert!(output.projection.base_links.is_empty());
        assert!(
            matches!(output.reply.unwrap().result, RoomResult::History { result: HistoryResult::Page { messages, .. } } if messages.len() == 1 && messages[0].text == room)
        );
        drop(restored);
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn embedded_descriptions_commit_with_chat_and_lookup_requires_room_read() {
    let path = std::env::temp_dir().join(format!("piik-files-room-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let attachment = json!({ "id": Uuid::new_v4(), "name": "caption.bin", "size": 3,
        "mediaType": "application/octet-stream", "sha256": piik_channel_prototype::attachment::sha256_hex(b"abc") });
    let original;
    {
        let mut host =
            StoredRoomHost::create(&path, policy("private", owner, RoomAccess::Private)).unwrap();
        original = sent(command(
            &mut host,
            owner,
            owner,
            json!({"type":"chat", "roomId":"private",
            "text":"Caption", "nonce":"file-send", "attachments":[attachment]}),
        ))
        .message;
        assert_eq!(
            original.attachments[0].sha256,
            attachment["sha256"].as_str().unwrap()
        );
        let query = json!({"type":"file_offer", "roomId":"private", "messageSeq":original.seq, "attachmentId":attachment["id"], "available":true});
        let denied = command(&mut host, owner, viewer, query.clone());
        assert!(matches!(
            denied.reply.unwrap().result,
            RoomResult::Error { .. }
        ));
        let readable = command(&mut host, owner, owner, query);
        assert!(matches!(readable.reply.unwrap().result, RoomResult::Done));
        let missing = command(
            &mut host,
            owner,
            owner,
            json!({"type":"file_offer", "roomId":"private", "messageSeq":original.seq+1, "attachmentId":attachment["id"], "available":true}),
        );
        assert!(
            matches!(missing.reply.unwrap().result, RoomResult::Error { code } if code == "attachment_unavailable")
        );
    }
    {
        let mut host = StoredRoomHost::open(&path).unwrap();
        let mut changed = attachment.clone();
        changed["sha256"] = json!(piik_channel_prototype::attachment::sha256_hex(b"changed"));
        let retry = sent(command(
            &mut host,
            owner,
            owner,
            json!({"type":"chat", "roomId":"private", "text":"Changed", "nonce":"file-send", "attachments":[changed]}),
        ));
        assert!(!retry.inserted);
        assert_eq!(
            serde_json::to_value(retry.message).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }
    std::fs::remove_file(path).unwrap();
}
