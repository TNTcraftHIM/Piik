#![cfg(feature = "sqlite")]

use piik_channel_core::{
    conversation::{
        ConversationAddress, ConversationCommand, ConversationRequest, ConversationResult,
        SessionSigner,
    },
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
        now: 0,
        binding_id: owner,
        host_session_id: owner,
        revision: 1,
        endpoints: [owner, actor]
            .into_iter()
            .map(|session| {
                (
                    session,
                    Endpoint {
                        signing_key: SessionSigner::from_seed([1; 32]).signing_key(),
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
    RoomState::new(
        id.into(),
        id.into(),
        Default::default(),
        owner,
        access,
        false,
        None,
    )
    .unwrap()
}

fn peer(
    host: &mut StoredRoomHost,
    owner: Uuid,
    actor: Uuid,
    command: ConversationCommand,
) -> Result<HistoryResult, &'static str> {
    host.dispatch(input(owner, actor, |_| HostAction::Sync))
        .unwrap();
    let request = ConversationRequest {
        address: ConversationAddress {
            room_id: host.policy().id.clone(),
            binding_id: owner,
            sender: actor,
            recipient: owner,
            request_id: Uuid::new_v4().to_string(),
        },
        command,
    };
    host.dispatch_peer(
        &SessionSigner::from_seed([1; 32])
            .sign(actor, &request)
            .unwrap(),
        1,
    )
    .unwrap()
    .result
    .map(|result| match result {
        ConversationResult::History(history) => history,
        _ => panic!("history result expected"),
    })
}

fn sent(
    result: Result<HistoryResult, &'static str>,
) -> piik_channel_core::history::MessageConfirmation {
    match result.unwrap() {
        HistoryResult::Sent(confirmation) => confirmation,
        _ => panic!("expected committed message"),
    }
}

#[test]
fn portable_snapshot_restores_complete_rows_and_retry_identity_without_live_state() {
    use piik_channel_core::{backup::Metadata, storage::Storage, RoomBackup};
    let folder = std::env::temp_dir().join(format!("piik-room-backup-{}", Uuid::new_v4()));
    std::fs::create_dir(&folder).unwrap();
    let owner = Uuid::new_v4();
    let domain = Uuid::new_v4();
    let mut room = policy("retained", owner, RoomAccess::Private);
    room.update(
        room.name.clone(),
        room.icon.clone(),
        RoomAccess::Private,
        true,
        Some(Some("private-room".into())),
    )
    .unwrap();
    let invitation = room.invite().unwrap();
    let original_policy = serde_json::to_value(&room).unwrap();
    let mut host = StoredRoomHost::create(&folder.join("live.sqlite"), room).unwrap();
    let attachment = piik_channel_core::AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "retained.bin".into(),
        size: 3,
        media_type: "application/octet-stream".into(),
        sha256: piik_channel_core::attachment::sha256_hex(b"abc"),
    };
    for seq in 1..=55 {
        sent(peer(
            &mut host,
            owner,
            owner,
            ConversationCommand::Chat {
                nonce: format!("send-{seq}"),
                text: format!("Message {seq}"),
                attachments: vec![attachment.clone()],
            },
        ));
    }
    peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::SetReaction {
            message_seq: 1,
            reaction: "wave".into(),
            active: true,
        },
    )
    .unwrap();
    // A failed new snapshot must not leave a broken .sqlite discovery target.
    let locked = rusqlite::Connection::open(folder.join("live.sqlite")).unwrap();
    locked.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let failed_snapshot = folder.join("failed-snapshot.sqlite");
    assert!(host.snapshot(&failed_snapshot, domain, None).is_err());
    assert!(!failed_snapshot.exists());
    locked.execute_batch("ROLLBACK").unwrap();
    drop(locked);
    let existing = folder.join("existing.sqlite");
    std::fs::write(&existing, b"existing owner data").unwrap();
    assert!(host.snapshot(&existing, domain, None).is_err());
    assert_eq!(std::fs::read(&existing).unwrap(), b"existing owner data");
    let backup = host
        .snapshot(&folder.join("snapshot.sqlite"), domain, None)
        .unwrap();
    let mut rows = Vec::new();
    backup
        .for_each_row(|row| {
            rows.push(row);
            Ok(())
        })
        .unwrap();
    assert_eq!(rows.len(), 55);
    assert_eq!(rows[0].nonce, "send-1");
    assert_eq!(rows[0].message.message.attachments, vec![attachment]);
    assert_eq!(rows[0].message.reactions.revision, 1);
    let manifest = serde_json::to_value(Metadata::Room(backup.metadata().clone())).unwrap();
    assert_eq!(manifest["kind"], "room");
    assert!(manifest.get("ownCredential").is_none());
    assert!(manifest.get("ownerKey").is_none());
    assert!(manifest.get("users").is_none());
    serde_json::from_value::<Metadata>(manifest)
        .unwrap()
        .validate()
        .unwrap();

    // The live owner can advance while the frozen rows keep their original head.
    sent(peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::Chat {
            nonce: "later".into(),
            text: "After the backup".into(),
            attachments: vec![],
        },
    ));
    let staged = RoomBackup::stage(
        &folder.join("import.sqlite"),
        backup.metadata().clone(),
        rows.iter().cloned().map(Ok),
    )
    .unwrap();
    host.replace(&staged).unwrap();
    assert!(host.current_readers().is_empty());
    assert_eq!(
        serde_json::to_value(host.policy()).unwrap(),
        original_policy
    );
    assert!(host.policy().accepts_invite(&invitation));
    let retry = sent(peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::Chat {
            nonce: "send-1".into(),
            text: "A changed retry must not replace retained content".into(),
            attachments: vec![],
        },
    ));
    assert!(!retry.inserted);
    assert_eq!(
        serde_json::to_value(&retry.message).unwrap(),
        serde_json::to_value(&rows[0].message).unwrap()
    );
    let HistoryResult::Page { messages, .. } = peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::History { before: None },
    )
    .unwrap() else {
        panic!("history expected");
    };
    assert_eq!(messages.last().unwrap().message.seq, 55);

    // A malformed stream rolls back its staging transaction, never the live room.
    let mut duplicate = rows[0].clone();
    duplicate.message.message.seq = 2;
    duplicate.message.message.id = Uuid::new_v4();
    let rejected_path = folder.join("rejected.sqlite");
    assert!(RoomBackup::stage(
        &rejected_path,
        backup.metadata().clone(),
        [Ok(rows[0].clone()), Ok(duplicate)],
    )
    .is_err());
    let rejected = Storage::open(&rejected_path).unwrap();
    assert!(rejected.load().unwrap().is_none());
    let empty = RoomBackup::stage(
        &folder.join("empty.sqlite"),
        backup.metadata().clone(),
        std::iter::empty(),
    )
    .unwrap();
    host.replace(&empty).unwrap();
    assert!(matches!(
        peer(&mut host, owner, owner, ConversationCommand::History { before: None }).unwrap(),
        HistoryResult::Page { messages, .. } if messages.is_empty()
    ));
    drop((host, backup, staged, rejected, empty));
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn message_reactions_commit_explicit_user_choices_and_recover_with_the_original_message() {
    let path =
        std::env::temp_dir().join(format!("piik-message-reactions-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("reactions", owner, RoomAccess::Private)).unwrap();
    let original = sent(peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::Chat {
            text: "Retained".into(),
            nonce: "original".into(),
            attachments: vec![],
        },
    ));
    let reaction = |reaction: &str, active| ConversationCommand::SetReaction {
        message_seq: original.message.message.seq,
        reaction: reaction.into(),
        active,
    };
    assert!(matches!(
        peer(&mut host, owner, viewer, reaction("wave", true)),
        Err("room_access_required")
    ));
    host.dispatch(input(owner, viewer, |context| HostAction::GrantInvited {
        context,
    }))
    .unwrap();
    let set = |host: &mut StoredRoomHost, actor, key, active| match peer(
        host,
        owner,
        actor,
        reaction(key, active),
    )
    .unwrap()
    {
        HistoryResult::Reacted(confirmation) => confirmation,
        _ => panic!("reaction confirmation expected"),
    };
    let first = set(&mut host, owner, "wave", true);
    assert!(first.changed);
    assert_eq!(first.snapshot.reactions.revision, 1);
    let repeated = set(&mut host, owner, "wave", true);
    assert!(!repeated.changed);
    assert_eq!(repeated.snapshot, first.snapshot);
    assert_eq!(
        set(&mut host, viewer, "wave", true)
            .snapshot
            .reactions
            .revision,
        2
    );
    assert_eq!(
        set(&mut host, owner, "laugh", true)
            .snapshot
            .reactions
            .revision,
        3
    );
    let removed = set(&mut host, viewer, "wave", false);
    assert_eq!(removed.snapshot.reactions.revision, 4);
    assert!(!removed.snapshot.reactions.choices.contains_key(&viewer));
    assert!(!set(&mut host, viewer, "wave", false).changed);
    assert!(matches!(
        peer(&mut host, owner, viewer, reaction("tomato", true)),
        Err("invalid_reaction")
    ));
    assert!(matches!(
        peer(
            &mut host,
            owner,
            viewer,
            ConversationCommand::SetReaction {
                message_seq: 99,
                reaction: "wave".into(),
                active: true,
            }
        ),
        Err("message_unavailable")
    ));
    assert!(serde_json::from_value::<ConversationCommand>(json!({
        "type":"set_reaction", "messageSeq":1, "reaction":"wave", "active":true, "userId":owner,
    }))
    .is_err());

    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch(
        "CREATE TABLE reaction_commit_failure (id TEXT REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED);
         CREATE TRIGGER reject_reaction AFTER UPDATE OF reactions ON message
         BEGIN INSERT INTO reaction_commit_failure VALUES('missing-message'); END;",
    ).unwrap();
    assert!(matches!(
        peer(&mut host, owner, owner, reaction("heart", true)),
        Err("storage_failed")
    ));
    database
        .execute_batch("DROP TRIGGER reject_reaction")
        .unwrap();
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    let HistoryResult::Page { messages, .. } = peer(
        &mut host,
        owner,
        viewer,
        ConversationCommand::History { before: None },
    )
    .unwrap() else {
        panic!("history expected")
    };
    assert_eq!(messages.len(), 1);
    assert_eq!(
        serde_json::to_value(&messages[0].message).unwrap(),
        serde_json::to_value(&original.message.message).unwrap()
    );
    assert_eq!(messages[0].reaction_snapshot(), removed.snapshot);
    let retry = sent(peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::Chat {
            text: "Changed retry".into(),
            nonce: "original".into(),
            attachments: vec![],
        },
    ));
    assert!(!retry.inserted);
    assert_eq!(retry.message.reaction_snapshot(), removed.snapshot);
    drop(host);
    drop(database);
    std::fs::remove_file(path).unwrap();
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
    let metadata = command(
        &mut host,
        owner,
        owner,
        json!({"type":"update_room","roomId":"private","name":"Changed","icon":"future_room","access":"private","hidden":false}),
    );
    assert!(
        matches!(metadata.reply.unwrap().result, RoomResult::Error { code } if code == "storage_failed")
    );
    assert_eq!(host.summary().name, "private");
    assert_eq!(serde_json::to_value(host.summary().icon).unwrap(), "couch");
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
    let message = ConversationCommand::Chat {
        text: "Original".into(),
        nonce: "same-send".into(),
        attachments: vec![],
    };
    let failed = peer(&mut host, owner, viewer, message.clone());
    assert!(matches!(failed, Err("storage_failed")));
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
    let original = sent(peer(&mut host, owner, viewer, message));
    assert!(original.inserted);
    assert_eq!(original.message.message.seq, 1);
    drop(host);

    let mut restored = StoredRoomHost::open(&path).unwrap();
    assert!(restored.policy().grants.contains(&viewer));
    let retry = sent(peer(
        &mut restored,
        owner,
        viewer,
        ConversationCommand::Chat {
            text: "Changed retry".into(),
            nonce: "same-send".into(),
            attachments: vec![],
        },
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
    let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
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
            json!({"type":"update_room","icon":image,"roomId":room,"name":format!("Saved {room}"),"access":"public","hidden":false}),
        );
        let result = sent(peer(
            host,
            owner,
            owner,
            ConversationCommand::Chat {
                text: room.into(),
                nonce: "same-send".into(),
                attachments: vec![],
            },
        ));
        assert_eq!(result.message.message.seq, 1);
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
        assert_eq!(
            serde_json::to_value(restored.policy().icon.clone()).unwrap(),
            image
        );
        assert_eq!(
            serde_json::to_value(restored.summary().icon).unwrap(),
            image
        );
        let output = restored
            .dispatch(input(owner, owner, |_| HostAction::Sync))
            .unwrap();
        assert!(!output.projection.views[&owner].room.reading);
        assert!(output.projection.views[&owner]
            .room
            .participant_session_ids
            .is_empty());
        assert!(output.projection.views[&owner].publications.is_empty());
        assert!(output.projection.base_links.is_empty());
        assert!(
            matches!(peer(&mut restored, owner, owner, ConversationCommand::History { before: None }).unwrap(),
                HistoryResult::Page { messages, .. } if messages.len() == 1 && messages[0].message.text == room)
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
        "mediaType": "application/octet-stream", "sha256": piik_channel_core::attachment::sha256_hex(b"abc") });
    let original;
    {
        let mut host =
            StoredRoomHost::create(&path, policy("private", owner, RoomAccess::Private)).unwrap();
        original = sent(peer(
            &mut host,
            owner,
            owner,
            ConversationCommand::Chat {
                text: "Caption".into(),
                nonce: "file-send".into(),
                attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
            },
        ))
        .message;
        assert_eq!(
            original.message.attachments[0].sha256,
            attachment["sha256"].as_str().unwrap()
        );
        let query = json!({"type":"file_offer", "roomId":"private", "messageSeq":original.message.seq, "attachmentId":attachment["id"], "available":true});
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
            json!({"type":"file_offer", "roomId":"private", "messageSeq":original.message.seq+1, "attachmentId":attachment["id"], "available":true}),
        );
        assert!(
            matches!(missing.reply.unwrap().result, RoomResult::Error { code } if code == "attachment_unavailable")
        );
    }
    {
        let mut host = StoredRoomHost::open(&path).unwrap();
        let mut changed = attachment.clone();
        changed["sha256"] = json!(piik_channel_core::attachment::sha256_hex(b"changed"));
        let retry = sent(peer(
            &mut host,
            owner,
            owner,
            ConversationCommand::Chat {
                text: "Changed".into(),
                nonce: "file-send".into(),
                attachments: vec![serde_json::from_value(changed).unwrap()],
            },
        ));
        assert!(!retry.inserted);
        assert_eq!(
            serde_json::to_value(retry.message).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }
    std::fs::remove_file(path).unwrap();
}
