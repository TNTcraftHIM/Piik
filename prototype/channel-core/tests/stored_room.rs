#![cfg(feature = "sqlite")]

use piik_channel_core::{
    conversation::{
        ConversationAddress, ConversationCommand, ConversationRequest, ConversationResult,
        ReactionTarget, SessionSigner,
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
        hosting_mode: Default::default(),
        channel_owner_id: Uuid::nil(),
        service_endpoint: None,
        now: 0,
        binding_id: owner,
        host_session_id: owner,
        revision: 1,
        confirmed_pairs: Default::default(),
        disconnected_pairs: Default::default(),
        failed_pairs: Vec::new(),
        endpoints: [owner, actor]
            .into_iter()
            .map(|session| {
                (
                    session,
                    Endpoint {
                        signing_key: SessionSigner::from_seed([1; 32]).signing_key(),
                        member: Member { user_id: session },
                        can_use_peer_transport: true,
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

fn invitation(host: &mut StoredRoomHost, owner: Uuid) -> String {
    let room = host.policy().id.clone();
    let reply = command(
        host,
        owner,
        owner,
        json!({"type":"room_invite","roomId":room}),
    )
    .reply
    .unwrap();
    let RoomResult::Invite { key } = reply.result else {
        panic!("room invitation expected")
    };
    key
}

fn enter(host: &mut StoredRoomHost, owner: Uuid, actor: Uuid, key: &str) -> HostOutput {
    let room = host.policy().id.clone();
    command(
        host,
        owner,
        actor,
        json!({"type":"enter_room","roomId":room,"inviteKey":key}),
    )
}

const ROOM_PICTURE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

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
    peer_with_owner(host, owner, actor, Uuid::nil(), command)
}

fn peer_with_owner(
    host: &mut StoredRoomHost,
    owner: Uuid,
    actor: Uuid,
    channel_owner: Uuid,
    command: ConversationCommand,
) -> Result<HistoryResult, &'static str> {
    let mut sync = input(owner, actor, |_| HostAction::Sync);
    sync.channel_owner_id = channel_owner;
    host.dispatch(sync).unwrap();
    let now = match &command {
        ConversationCommand::React { nonce, .. } => nonce * 800,
        _ => 1,
    };
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
        now,
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
fn backup_password_round_trip_and_cost_validation() {
    use piik_channel_core::backup::RoomMetadata;

    let policy = RoomState::new(
        "private".into(),
        "Private".into(),
        Default::default(),
        Uuid::new_v4(),
        RoomAccess::Private,
        false,
        Some("room password".into()),
    )
    .unwrap();
    let mut saved = serde_json::to_value(RoomMetadata {
        version: RoomMetadata::VERSION,
        policy,
        domain_id: Uuid::new_v4(),
        own_credential: None,
        retained_files: vec![],
    })
    .unwrap();
    let mut restored: RoomMetadata = serde_json::from_value(saved.clone()).unwrap();
    restored.validate().unwrap();
    restored
        .policy
        .enter(Uuid::new_v4(), Some("room password"), None)
        .unwrap();

    let generated = saved["policy"]["passwordHash"].as_str().unwrap().to_owned();
    for (from, to) in [
        ("m=19456", "m=19457"),
        ("t=2", "t=3"),
        ("p=1", "p=2"),
        ("argon2id", "argon2i"),
        ("v=19", "v=16"),
    ] {
        saved["policy"]["passwordHash"] = json!(generated.replace(from, to));
        let imported: RoomMetadata = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(imported.validate(), Err("invalid_room_policy"), "{to}");
    }
}

#[test]
fn creating_invalid_room_policy_leaves_no_database() {
    let saved =
        serde_json::to_value(policy("invalid", Uuid::new_v4(), RoomAccess::Private)).unwrap();
    for (field, value) in [
        ("voiceBitrate", json!(0)),
        ("relayCapacity", json!(0)),
        ("passwordHash", json!("invalid")),
    ] {
        let path =
            std::env::temp_dir().join(format!("piik-invalid-policy-{}.sqlite", Uuid::new_v4()));
        let mut input = saved.clone();
        input[field] = value;
        let result = StoredRoomHost::create(&path, serde_json::from_value(input).unwrap());
        let created = path.exists();
        let error = result.err().map(|error| error.to_string());
        if created {
            std::fs::remove_file(&path).unwrap();
        }
        assert!(!created, "{field} must be rejected before opening SQLite");
        assert_eq!(error.as_deref(), Some("invalid_room_policy"), "{field}");
    }
}

#[test]
fn private_room_moderation_removes_quotes_and_blocks_stale_retries_after_restart() {
    let path = std::env::temp_dir().join(format!("piik-moderation-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let author = Uuid::new_v4();
    let moderator = Uuid::new_v4();
    let mut room = policy("private", owner, RoomAccess::Private);
    room.grants.insert(author);
    let mut host = StoredRoomHost::create(&path, room).unwrap();
    let chat = |nonce: &str, text: &str, reply| ConversationCommand::Chat {
        nonce: nonce.into(),
        text: text.into(),
        mentions: vec![],
        attachments: vec![],
        inline_images: Default::default(),
        reply,
    };
    let target = || chat("target", "deleted quotation", None);
    let delete = |message_seq, message_id| ConversationCommand::DeleteMessage {
        message_seq,
        message_id,
    };
    let clear = || ConversationCommand::ClearHistory { through_seq: 2 };
    let original_id = sent(peer(&mut host, owner, author, target()))
        .message
        .message
        .id;
    let reply = |nonce: &str, message_id| {
        chat(
            nonce,
            "kept reply",
            Some(piik_channel_core::history::ReplyTarget {
                seq: 1,
                message_id,
                notify: true,
            }),
        )
    };
    assert_eq!(
        peer(&mut host, owner, owner, reply("wrong", Uuid::new_v4())).err(),
        Some("message_unavailable")
    );
    let accepted = sent(peer(&mut host, owner, owner, reply("reply", original_id)));
    let retry = sent(peer(
        &mut host,
        owner,
        owner,
        reply("reply", Uuid::new_v4()),
    ));
    assert!(!retry.inserted);
    assert_eq!(
        serde_json::to_value(retry.message).unwrap(),
        serde_json::to_value(&accepted.message).unwrap()
    );
    for actor in [author, owner] {
        assert_eq!(
            peer(&mut host, owner, actor, delete(1, Uuid::new_v4())).err(),
            Some("message_unavailable")
        );
    }
    for command in [
        ConversationCommand::History { before: None },
        delete(1, original_id),
        clear(),
    ] {
        assert_eq!(
            peer_with_owner(&mut host, owner, moderator, moderator, command).err(),
            Some("room_access_required")
        );
    }
    assert_eq!(
        peer(
            &mut host,
            owner,
            author,
            delete(2, accepted.message.message.id)
        )
        .err(),
        Some("forbidden")
    );
    assert_eq!(
        peer(&mut host, owner, author, clear()).err(),
        Some("forbidden")
    );
    assert!(matches!(
        peer(&mut host, owner, author, delete(1, original_id)),
        Ok(HistoryResult::MessageDeleted { message_seq: 1 })
    ));
    assert_eq!(
        peer(&mut host, owner, owner, reply("deleted", original_id)).err(),
        Some("message_unavailable")
    );
    let HistoryResult::Page { messages, .. } = peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::History { before: None },
    )
    .unwrap() else {
        panic!("history expected")
    };
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].message.text, "kept reply");
    assert!(messages[0].message.reply.is_none());
    assert_eq!(
        peer(&mut host, owner, author, target()).err(),
        Some("message_unavailable")
    );

    let key = invitation(&mut host, owner);
    enter(&mut host, owner, moderator, &key);
    assert!(matches!(
        peer_with_owner(&mut host, owner, moderator, moderator, clear()),
        Ok(HistoryResult::HistoryCleared { through_seq: 2 })
    ));
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    assert!(host.policy().reads(moderator) && host.policy().reads(author));
    assert_eq!(
        peer(&mut host, owner, author, target()).err(),
        Some("message_unavailable")
    );
    let fresh = sent(peer(
        &mut host,
        owner,
        author,
        chat("fresh", "after clear", None),
    ));
    assert_eq!(fresh.message.message.seq, 3);
    peer_with_owner(&mut host, owner, moderator, moderator, clear()).unwrap();
    assert!(
        matches!(peer(&mut host, owner, author, ConversationCommand::History { before: None }),
        Ok(HistoryResult::Page { messages, .. }) if messages.len() == 1 && messages[0].message.seq == 3)
    );
    peer_with_owner(
        &mut host,
        owner,
        moderator,
        moderator,
        delete(3, fresh.message.message.id),
    )
    .unwrap();
    drop(host);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn deleting_room_policy_and_history_is_one_commit_and_keeps_other_stores() {
    use piik_channel_core::{history::HistoryRequest, storage::Storage};
    let folder = std::env::temp_dir().join(format!("piik-room-delete-{}", Uuid::new_v4()));
    std::fs::create_dir(&folder).unwrap();
    let path = folder.join("deleted.sqlite");
    let sibling_path = folder.join("sibling.sqlite");
    let owner = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("deleted", owner, RoomAccess::Public)).unwrap();
    let sibling =
        StoredRoomHost::create(&sibling_path, policy("sibling", owner, RoomAccess::Public))
            .unwrap();
    command(
        &mut host,
        owner,
        owner,
        json!({"type":"browse","roomId":"deleted","active":true}),
    );
    sent(peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: "Retained".into(),
            nonce: "before-delete".into(),
            attachments: vec![],
        },
    ));
    let denied = command(
        &mut host,
        owner,
        stranger,
        json!({"type":"delete_room","deleteData":true,"roomId":"deleted"}),
    );
    assert!(
        matches!(denied.reply.unwrap().result, RoomResult::Error { code } if code == "forbidden")
    );
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON message BEGIN SELECT RAISE(ABORT,'held'); END;").unwrap();
    let failed = command(
        &mut host,
        owner,
        owner,
        json!({"type":"delete_room","deleteData":true,"roomId":"deleted"}),
    );
    assert!(
        matches!(failed.reply.unwrap().result, RoomResult::Error { code } if code == "storage_failed")
    );
    let mut retained = Storage::open(&path).unwrap();
    assert!(
        retained.load().unwrap().is_some(),
        "history failure rolled back policy deletion"
    );
    assert!(
        matches!(retained.history(&HistoryRequest::Read { room_id: "deleted".into(), before: None }).unwrap(), HistoryResult::Page { messages, .. } if messages.len() == 1)
    );
    connection
        .execute_batch("DROP TRIGGER reject_delete")
        .unwrap();
    let removed = command(
        &mut host,
        owner,
        owner,
        json!({"type":"delete_room","deleteData":true,"roomId":"deleted"}),
    );
    assert!(matches!(
        removed.reply.unwrap().result,
        RoomResult::Deleted { data_removed: true }
    ));
    assert!(retained.load().unwrap().is_none());
    assert!(
        matches!(retained.history(&HistoryRequest::Read { room_id: "deleted".into(), before: None }).unwrap(), HistoryResult::Page { messages, .. } if messages.is_empty())
    );
    assert!(Storage::open(&sibling_path)
        .unwrap()
        .load()
        .unwrap()
        .is_some());
    drop((host, sibling, retained, connection));
    std::fs::remove_dir_all(folder).unwrap();
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
        room.appearance.clone(),
        RoomAccess::Private,
        true,
        Some(Some("private-room".into())),
    )
    .unwrap();
    let invitation = room.invite().unwrap();
    let mut host = StoredRoomHost::create(&folder.join("live.sqlite"), room).unwrap();
    command(
        &mut host,
        owner,
        owner,
        json!({"type":"update_room","roomId":"retained",
        "name":"retained","icon":"rocket","picture":ROOM_PICTURE,"access":"private","hidden":true,"allowServiceRelay":true}),
    );
    drop(host);
    let mut host = StoredRoomHost::open(&folder.join("live.sqlite")).unwrap();
    assert!(
        host.policy().allow_service_relay,
        "the normal setting survives reopening the room store"
    );
    let original_policy = serde_json::to_value(host.policy()).unwrap();
    let attachment = piik_channel_core::AttachmentDescriptor {
        id: Uuid::new_v4(),
        name: "retained.bin".into(),
        size: 9,
        media_type: "image/gif".into(),
        sha256: piik_channel_core::attachment::sha256_hex(b"GIF89aabc"),
    };
    let mut original_id = None;
    for seq in 1..=55 {
        let confirmation = sent(peer(
            &mut host,
            owner,
            owner,
            ConversationCommand::Chat {
                mentions: vec![piik_channel_core::history::Mention {
                    user_id: owner,
                    start: 0,
                    end: 6,
                }],
                reply: original_id.map(|message_id| piik_channel_core::history::ReplyTarget {
                    message_id,
                    seq: 1,
                    notify: true,
                }),
                inline_images: BTreeMap::from([(
                    attachment.id,
                    piik_channel_core::attachment::ImageRendition {
                        data: "R0lGODlhZGVm".into(),
                        media_type: "image/gif".into(),
                        original: false,
                        width: 32,
                        height: 32,
                    },
                )]),
                nonce: format!("send-{seq}"),
                text: format!("@Owner Message {seq}"),
                attachments: vec![attachment.clone()],
            },
        ));
        original_id.get_or_insert(confirmation.message.message.id);
    }
    peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::React {
            nonce: 1,
            target: ReactionTarget::Message {
                message_seq: 1,
                message_id: original_id.unwrap(),
            },
            reaction: "wave".into(),
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
    use piik_channel_core::backup::HistoryRow;
    let live = |row| match row {
        HistoryRow::Message(message) => message,
        HistoryRow::Deleted(_) => panic!("expected live archive row"),
    };
    let mut rows = Vec::new();
    backup
        .for_each_row(|row| {
            rows.push(live(row));
            Ok(())
        })
        .unwrap();
    assert_eq!(rows.len(), 55);
    for path in ["", "/reactions", "/attachments/0", "/mentions/0"] {
        let mut row = serde_json::to_value(&rows[0]).unwrap();
        row.pointer_mut(path).unwrap()["unrecognized"] = json!("saved content");
        assert!(serde_json::from_value::<HistoryRow>(row).is_err(), "{path}");
    }
    assert!(
        command(
            &mut host,
            owner,
            owner,
            json!({"type":"browse","roomId":"retained","active":false})
        )
        .projection
        .last_message_seq
            == 55
    );
    assert_eq!(
        rows[1].message.message.reply.as_ref().unwrap().text,
        "@Owner Message 1"
    );
    assert_eq!(rows[0].nonce, "send-1");
    assert_eq!(rows[0].message.message.attachments, vec![attachment]);
    assert_eq!(rows[0].message.reactions.revision, 1);
    assert_eq!(
        rows[0]
            .message
            .message
            .inline_images
            .values()
            .next()
            .unwrap()
            .data,
        "R0lGODlhZGVm"
    );
    let manifest = serde_json::to_value(Metadata::Room(backup.metadata().clone())).unwrap();
    assert_eq!(manifest["kind"], "room");
    assert_eq!(manifest["policy"]["icon"], "rocket");
    assert_eq!(manifest["policy"]["picture"], ROOM_PICTURE);
    assert!(manifest.get("ownCredential").is_none());
    assert!(manifest.get("ownerKey").is_none());
    assert!(manifest.get("users").is_none());
    let mut old_archive = manifest.clone();
    old_archive["policy"]
        .as_object_mut()
        .unwrap()
        .remove("picture");
    old_archive["policy"]["icon"] = json!(ROOM_PICTURE);
    assert!(serde_json::from_value::<Metadata>(old_archive).is_err());
    serde_json::from_value::<Metadata>(manifest)
        .unwrap()
        .validate()
        .unwrap();

    // Copying the exported history keeps attribution/content, not its authority.
    {
        use piik_channel_core::backup::{
            CopyHistoryImport, RetainedFile, RoomCopyInfo, RoomCopyMetadata, RoomMetadata,
        };
        let metadata = RoomCopyMetadata {
            version: 2,
            room_info: Some(RoomCopyInfo {
                name: host.policy().name.clone(),
                appearance: host.policy().appearance.clone(),
                voice_bitrate: host.policy().voice_bitrate,
                relay_capacity: host.policy().relay_capacity,
            }),
            authors: BTreeMap::from([(owner, "Original owner".into())]),
            retained_files: vec![RetainedFile {
                message_seq: 1,
                attachment: rows[0].message.message.attachments[0].clone(),
            }],
        };
        let encoded = serde_json::to_value(Metadata::RoomCopy(metadata.clone())).unwrap();
        assert_eq!(encoded["kind"], "room_copy");
        assert_eq!(encoded["roomInfo"]["icon"], "rocket");
        assert_eq!(encoded["roomInfo"]["picture"], ROOM_PICTURE);
        let mut legacy = encoded.clone();
        legacy["roomInfo"]
            .as_object_mut()
            .unwrap()
            .remove("picture");
        legacy["roomInfo"]["icon"] = json!(ROOM_PICTURE);
        assert!(serde_json::from_value::<Metadata>(legacy).is_err());
        for field in [
            "policy",
            "ownCredential",
            "passwordHash",
            "grants",
            "inviteKey",
        ] {
            assert!(encoded.get(field).is_none());
            let mut injected = encoded.clone();
            injected[field] = json!("source authority");
            assert!(serde_json::from_value::<Metadata>(injected).is_err());
        }
        let mut importer = CopyHistoryImport::new(metadata.clone()).unwrap();
        let copied: Vec<_> = rows
            .iter()
            .cloned()
            .map(|row| live(importer.accept(HistoryRow::Message(row)).unwrap()))
            .collect();
        importer.finish().unwrap();
        let archived = copied[0].message.message.user_id;
        assert_ne!(archived, owner);
        assert_eq!(
            copied[1].message.message.reply.as_ref().unwrap().user_id,
            archived
        );
        assert_eq!(copied[0].message.message.mentions[0].user_id, archived);
        assert_eq!(
            copied[1]
                .message
                .message
                .reply
                .as_ref()
                .unwrap()
                .archived_author_name
                .as_deref(),
            Some("Original owner")
        );
        for (original, copy) in rows.iter().zip(&copied) {
            assert_eq!(copy.message.message.user_id, archived);
            assert_eq!(
                copy.message.message.archived_author_name.as_deref(),
                Some("Original owner")
            );
            assert_ne!(copy.message.message.id, original.message.message.id);
            assert_ne!(copy.nonce, original.nonce);
            assert_eq!(copy.message.message.seq, original.message.message.seq);
            assert_eq!(copy.message.message.text, original.message.message.text);
            assert_eq!(
                copy.message.message.attachments,
                original.message.message.attachments
            );
            assert_eq!(copy.message.reactions, original.message.reactions);
            assert_eq!(
                copy.message.message.inline_images,
                original.message.message.inline_images
            );
        }
        let mut copying_again = CopyHistoryImport::new(RoomCopyMetadata {
            authors: BTreeMap::new(),
            ..metadata.clone()
        })
        .unwrap();
        let copied_again = live(
            copying_again
                .accept(HistoryRow::Message(copied[0].clone()))
                .unwrap(),
        );
        assert_eq!(
            copied_again.message.message.archived_author_name.as_deref(),
            Some("Original owner")
        );
        assert_ne!(copied_again.message.message.user_id, archived);
        let mut malformed = copied[0].clone();
        malformed.message.message.archived_author_name = Some("x".repeat(41));
        assert!(malformed.validate().is_err());

        let new_owner = Uuid::new_v4();
        let copy_policy = policy("copied", new_owner, RoomAccess::Private);
        assert!(
            copy_policy.allow_service_relay,
            "a copy is a new room and takes the new-room default"
        );
        assert!(!copy_policy.view(owner).unwrap().authorized);
        assert!(!copy_policy.accepts_invite(&invitation));
        let staged_copy = RoomBackup::stage(
            &folder.join("copy-staging.sqlite"),
            RoomMetadata {
                version: RoomMetadata::VERSION,
                domain_id: Uuid::new_v4(),
                policy: copy_policy,
                own_credential: None,
                retained_files: metadata.retained_files,
            },
            copied.iter().cloned().map(HistoryRow::Message).map(Ok),
        )
        .unwrap();
        let copied_path = folder.join("copied.sqlite");
        drop(StoredRoomHost::from_backup(&copied_path, &staged_copy).unwrap());
        let mut copied_host = StoredRoomHost::open(&copied_path).unwrap();
        assert_eq!(
            command(
                &mut copied_host,
                new_owner,
                new_owner,
                json!({"type":"browse","roomId":"copied","active":false})
            )
            .projection
            .last_message_seq,
            55,
            "reopened history seeds the authoritative head"
        );
        let HistoryResult::Page { messages, .. } = peer(
            &mut copied_host,
            new_owner,
            new_owner,
            ConversationCommand::History { before: Some(2) },
        )
        .unwrap() else {
            panic!("history expected")
        };
        assert_eq!(
            serde_json::to_value(&messages[0]).unwrap(),
            serde_json::to_value(&copied[0].message).unwrap()
        );
        let fresh = sent(peer(
            &mut copied_host,
            new_owner,
            new_owner,
            ConversationCommand::Chat {
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
                nonce: rows[0].nonce.clone(),
                text: "A new conversation".into(),
                attachments: vec![],
            },
        ));
        assert!(fresh.inserted);
        assert_eq!(fresh.message.message.seq, 56);
        assert!(fresh.message.message.archived_author_name.is_none());
    }

    // The live owner can advance while the frozen rows keep their original head.
    sent(peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            nonce: "later".into(),
            text: "After the backup".into(),
            attachments: vec![],
        },
    ));
    let mut during_import = None;
    let old_archive_path = folder.join("old-version-staging.sqlite");
    let mut old_metadata = backup.metadata().clone();
    old_metadata.version = 3;
    let error = RoomBackup::stage(&old_archive_path, old_metadata, std::iter::empty())
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "unsupported_backup_version");
    assert!(!old_archive_path.exists());
    let staged = RoomBackup::stage(
        &folder.join("import.sqlite"),
        backup.metadata().clone(),
        rows.iter().cloned().enumerate().map(|(index, row)| {
            if index == rows.len() / 2 {
                during_import = Some(RoomBackup::snapshot_readonly(
                    &folder.join("live.sqlite"),
                    &folder.join("during-import.sqlite"),
                    domain,
                    "retained",
                    owner,
                    None,
                    || false,
                )?);
            }
            Ok(HistoryRow::Message(row))
        }),
    )
    .unwrap();
    host.replace(&staged).unwrap();
    let mut last_exported = None;
    during_import
        .unwrap()
        .for_each_row(|row| {
            last_exported = Some(live(row).nonce);
            Ok(())
        })
        .unwrap();
    assert_eq!(last_exported.as_deref(), Some("later"));
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
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
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

    // Imported reply snapshots are rebuilt from the target in this archive.
    let mut stale = rows[2].clone();
    let stale_reply = stale.message.message.reply.as_mut().unwrap();
    stale_reply.text = "Stale preview".into();
    stale_reply.user_id = Uuid::new_v4();
    stale_reply.archived_author_name = Some("Stale identity".into());
    let mut deleted = rows[4].clone();
    deleted.message.message.reply.as_mut().unwrap().seq = 4;
    let mut missing = rows[6].clone();
    missing.message.message.reply.as_mut().unwrap().seq = 6;
    let reply_archive = RoomBackup::stage(
        &folder.join("reply-import.sqlite"),
        backup.metadata().clone(),
        [
            HistoryRow::Message(rows[0].clone()),
            HistoryRow::Message(rows[1].clone()),
            HistoryRow::Message(stale),
            HistoryRow::Deleted(piik_channel_core::backup::DeletedHistoryRow {
                seq: 4,
                retry_key: "a".repeat(64),
            }),
            HistoryRow::Message(deleted),
            HistoryRow::Message(missing),
        ]
        .into_iter()
        .map(Ok),
    )
    .unwrap();
    let mut replies = Vec::new();
    reply_archive
        .for_each_row(|row| {
            if let HistoryRow::Message(row) = row {
                replies.push(row.message.message.reply);
            }
            Ok(())
        })
        .unwrap();
    assert!(replies[0].is_none());
    let authentic = replies[1].as_ref().unwrap();
    assert_eq!(authentic.text, rows[0].message.message.text);
    assert_eq!(
        serde_json::to_value(&replies[2]).unwrap(),
        serde_json::to_value(authentic).unwrap()
    );
    assert!(replies[3].is_none());
    assert!(replies[4].is_none());
    host.replace(&reply_archive).unwrap();
    let HistoryResult::Page { messages, .. } = peer(
        &mut host,
        owner,
        owner,
        ConversationCommand::History { before: None },
    )
    .unwrap() else {
        panic!("history expected");
    };
    assert_eq!(
        serde_json::to_value(
            messages
                .into_iter()
                .map(|row| row.message.reply)
                .collect::<Vec<_>>()
        )
        .unwrap(),
        serde_json::to_value(replies).unwrap()
    );
    drop(reply_archive);

    // A malformed stream rolls back its staging transaction, never the live room.
    let mut duplicate = rows[0].clone();
    duplicate.message.message.seq = 2;
    duplicate.message.message.id = Uuid::new_v4();
    let rejected_path = folder.join("rejected.sqlite");
    assert!(RoomBackup::stage(
        &rejected_path,
        backup.metadata().clone(),
        [
            Ok(HistoryRow::Message(rows[0].clone())),
            Ok(HistoryRow::Message(duplicate))
        ],
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
fn message_reaction_counts_commit_once_and_recover_without_replaying_effects() {
    let path =
        std::env::temp_dir().join(format!("piik-message-reactions-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let author = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("reactions", owner, RoomAccess::Private)).unwrap();
    let key = invitation(&mut host, owner);
    enter(&mut host, owner, author, &key);
    let original = sent(peer(
        &mut host,
        owner,
        author,
        ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: "Retained".into(),
            nonce: "original".into(),
            attachments: vec![],
        },
    ));
    let reaction = |reaction: &str, nonce| ConversationCommand::React {
        target: ReactionTarget::Message {
            message_seq: original.message.message.seq,
            message_id: original.message.message.id,
        },
        reaction: reaction.into(),
        nonce,
    };
    assert!(matches!(
        peer(&mut host, owner, viewer, reaction("wave", 1)),
        Err("room_access_required")
    ));
    enter(&mut host, owner, viewer, &key);
    let react = |host: &mut StoredRoomHost, actor, key, nonce| match peer(
        host,
        owner,
        actor,
        reaction(key, nonce),
    )
    .unwrap()
    {
        HistoryResult::Reacted(confirmation) => confirmation,
        _ => panic!("reaction confirmation expected"),
    };
    let first = react(&mut host, owner, "poop", 1);
    assert!(first.event.is_some());
    assert_eq!(first.snapshot.reactions.counts["poop"], 1);
    let retry = react(&mut host, owner, "poop", 1);
    assert!(retry.event.is_none());
    assert_eq!(retry.snapshot, first.snapshot);
    let second = react(&mut host, owner, "poop", 2);
    assert_eq!(second.snapshot.reactions.counts["poop"], 2);
    assert_ne!(first.event.unwrap().id, second.event.unwrap().id);
    let third = react(&mut host, viewer, "tomato", 1);
    assert_eq!(third.snapshot.reactions.revision, 3);
    let late = react(&mut host, owner, "poop", 1);
    assert!(late.event.is_none());
    assert_eq!(late.snapshot, third.snapshot);
    assert!(matches!(
        peer(
            &mut host,
            owner,
            viewer,
            ConversationCommand::React {
                target: ReactionTarget::Message {
                    message_seq: 99,
                    message_id: original.message.message.id
                },
                reaction: "wave".into(),
                nonce: 2,
            }
        ),
        Err("message_unavailable")
    ));
    assert!(serde_json::from_value::<ConversationCommand>(json!({
        "type":"react", "target":{"type":"message","messageSeq":1}, "reaction":"wave", "nonce":2, "userId":owner,
    })).is_err());
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TABLE reaction_commit_failure (id TEXT REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_reaction AFTER UPDATE OF reactions ON message
        BEGIN INSERT INTO reaction_commit_failure VALUES('missing-message'); END;").unwrap();
    assert!(matches!(
        peer(&mut host, owner, owner, reaction("heart", 3)),
        Err("storage_failed")
    ));
    database
        .execute_batch("DROP TRIGGER reject_reaction")
        .unwrap();
    let recovered = react(&mut host, owner, "heart", 3);
    assert!(
        recovered.event.is_some(),
        "failed commit consumed neither the nonce nor cooldown"
    );
    assert_eq!(recovered.snapshot.reactions.revision, 4);
    assert_eq!(recovered.snapshot.reactions.counts["heart"], 1);
    assert!(react(&mut host, owner, "heart", 3).event.is_none());
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
    assert_eq!(messages[0].reaction_snapshot(), recovered.snapshot);
    let retry = sent(peer(
        &mut host,
        owner,
        author,
        ConversationCommand::Chat {
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
            text: "Changed retry".into(),
            nonce: "original".into(),
            attachments: vec![],
        },
    ));
    assert!(!retry.inserted);
    assert_eq!(retry.message.reaction_snapshot(), recovered.snapshot);
    drop((host, database));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn service_relay_choice_commits_only_for_current_owner_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!("piik-service-choice-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("relay-choice", owner, RoomAccess::Public)).unwrap();
    assert!(host.policy().allow_service_relay);
    let update = |allowed| {
        json!({"type":"update_room","roomId":"relay-choice", "name":"Relay choice",
        "icon":"couch","access":"public","hidden":false,"allowServiceRelay":allowed})
    };
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_service_choice BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'held'); END;").unwrap();
    let failed = command(&mut host, owner, owner, update(false));
    assert!(
        matches!(failed.reply.unwrap().result, RoomResult::Error { code } if code == "storage_failed")
    );
    assert!(
        host.policy().allow_service_relay,
        "failed checkpoint must abort the in-memory policy too"
    );
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    assert!(
        host.policy().allow_service_relay,
        "failed decline must not persist through reopen"
    );
    database
        .execute_batch("DROP TRIGGER reject_service_choice")
        .unwrap();

    let denied = command(&mut host, owner, reader, update(false));
    assert!(
        matches!(denied.reply.unwrap().result, RoomResult::Error { code } if code == "forbidden")
    );
    assert!(host.policy().allow_service_relay);
    let saved = command(&mut host, owner, owner, update(false));
    assert!(matches!(saved.reply.unwrap().result, RoomResult::Done));
    let mut unrelated_update = update(true);
    unrelated_update
        .as_object_mut()
        .unwrap()
        .remove("allowServiceRelay");
    command(&mut host, owner, owner, unrelated_update);
    assert!(
        !host.policy().allow_service_relay,
        "omitting the setting keeps the saved choice"
    );

    let mut retired = input(owner, owner, |context| HostAction::Command {
        context,
        command: Request::parse(&update(true).to_string()).unwrap().command,
    });
    retired.endpoints.remove(&owner);
    let denied = host.dispatch(retired).unwrap();
    assert!(
        matches!(denied.reply.unwrap().result, RoomResult::Error { code } if code == "session_expired")
    );
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    assert!(
        !host.policy().allow_service_relay,
        "departed owner endpoint cannot rewrite retained policy"
    );
    let allowed = command(&mut host, owner, owner, update(true));
    assert!(matches!(allowed.reply.unwrap().result, RoomResult::Done));
    drop(host);
    let host = StoredRoomHost::open(&path).unwrap();
    assert!(
        host.policy().allow_service_relay,
        "explicit allow is durable too"
    );
    drop((host, database));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn failed_storage_withholds_grant_and_confirmation_then_retry_survives_reopen() {
    let path = std::env::temp_dir().join(format!("piik-stored-room-{}.sqlite", Uuid::new_v4()));
    let owner = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("private", owner, RoomAccess::Private)).unwrap();
    let key = invitation(&mut host, owner);
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
    let failed = enter(&mut host, owner, viewer, &key);
    assert!(
        matches!(failed.reply.unwrap().result, RoomResult::Error { code } if code == "storage_failed")
    );
    assert!(!failed.projection.views[&viewer].authorized);
    assert!(host.policy().grants.is_empty());
    assert!(StoredRoomHost::open(&path)
        .unwrap()
        .policy()
        .grants
        .is_empty());

    database
        .execute_batch("DROP TRIGGER reject_policy;")
        .unwrap();
    let granted = enter(&mut host, owner, viewer, &key);
    assert!(matches!(granted.reply.unwrap().result, RoomResult::Done));
    assert!(granted.projection.views[&viewer].authorized);
    // Fail COMMIT after the message INSERT succeeded, using the production SQLite transaction.
    database.execute_batch("CREATE TABLE commit_failure (id TEXT REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_message AFTER INSERT ON message BEGIN INSERT INTO commit_failure VALUES('missing'); END;").unwrap();
    let message = ConversationCommand::Chat {
        mentions: vec![],
        reply: None,
        inline_images: Default::default(),
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
            mentions: vec![],
            reply: None,
            inline_images: Default::default(),
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
    let owner = Uuid::new_v4();
    let first = std::env::temp_dir().join(format!("piik-stored-first-{}.sqlite", Uuid::new_v4()));
    let second = std::env::temp_dir().join(format!("piik-stored-second-{}.sqlite", Uuid::new_v4()));
    assert!(StoredRoomHost::open(&first).is_err());
    assert!(!first.exists(), "open must not create a missing room");
    let mut a = StoredRoomHost::create(&first, policy("first", owner, RoomAccess::Public)).unwrap();
    let mut b =
        StoredRoomHost::create(&second, policy("second", owner, RoomAccess::Public)).unwrap();
    let mut invitations = BTreeMap::new();
    assert!(
        StoredRoomHost::create(&first, policy("replacement", owner, RoomAccess::Public)).is_err()
    );
    for (host, room) in [(&mut a, "first"), (&mut b, "second")] {
        let output = command(
            host,
            owner,
            owner,
            json!({"type":"room_invite","roomId":room}),
        );
        let RoomResult::Invite { key } = output.reply.unwrap().result else {
            panic!("room invitation")
        };
        invitations.insert(room, key);
        command(
            host,
            owner,
            owner,
            json!({"type":"update_room","icon":"rocket","picture":ROOM_PICTURE,"roomId":room,"name":format!("Saved {room}"),"access":"public","hidden":false,"relayCapacity":7}),
        );
        let personal = command(
            host,
            owner,
            owner,
            json!({"type":"relay_capacity","roomId":room,"capacity":0}),
        );
        assert_eq!(personal.projection.views[&owner].relay_override, Some(0));
        let invalid = command(
            host,
            owner,
            owner,
            json!({"type":"update_room","icon":"rocket","picture":ROOM_PICTURE,"roomId":room,"name":"Invalid","access":"public","hidden":false,"relayCapacity":0}),
        );
        assert!(
            matches!(invalid.reply.unwrap().result, RoomResult::Error { code } if code == "invalid_relay_capacity")
        );
        let result = sent(peer(
            host,
            owner,
            owner,
            ConversationCommand::Chat {
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
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
            json!({"type":"publish","publication":{"id":Uuid::new_v4(),"roomId":room,"kind":"screen","source":{"kind":"screen","name":null},"videoSettings":{"ceiling":{"resolution":{"width":1280,"height":720},"maxFramerate":29.97,"maxBitrate":2500000},"degradationPreference":"balanced"}}}),
        );
    }
    drop((a, b));
    for (path, room) in [(&first, "first"), (&second, "second")] {
        let mut restored = StoredRoomHost::open(path).unwrap();
        assert_eq!(restored.policy().id, room);
        assert_eq!(restored.summary().name, format!("Saved {room}"));
        assert_eq!(restored.policy().relay_capacity, 7);
        assert!(restored.policy().accepts_invite(&invitations[room]));
        let output = command(
            &mut restored,
            owner,
            owner,
            json!({"type":"get_room_invite","roomId":room}),
        );
        assert!(
            matches!(output.reply.unwrap().result, RoomResult::InviteState {
            invitation: piik_channel_core::wire::RoomInvitation::Available { key }
        } if key == invitations[room])
        );
        let appearance = serde_json::to_value(restored.policy()).unwrap();
        assert_eq!(appearance["icon"], "rocket");
        assert_eq!(appearance["picture"], ROOM_PICTURE);
        let summary = serde_json::to_value(restored.summary()).unwrap();
        assert_eq!(summary["icon"], "rocket");
        assert!(summary.get("picture").is_none());
        let output = restored
            .dispatch(input(owner, owner, |_| HostAction::Sync))
            .unwrap();
        assert!(!output.projection.views[&owner].reading);
        assert_eq!(output.projection.views[&owner].relay_override, None);
        assert_eq!(output.projection.summary.relay_capacity, 7);
        assert!(output.projection.participant_session_ids.is_empty());
        assert!(output.projection.publications.is_empty());
        assert!(output.projection.flows.is_empty());
        assert!(output.projection.voice.is_empty());
        assert!(output.projection.watch_activities.is_empty());
        assert!(output.projection.views.values().all(|view| {
            view.subscriptions.is_empty()
                && view.watch_subscriptions.is_empty()
                && view.watch_bytes.is_empty()
                && view.files.is_empty()
        }));
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
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
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
        let mut query = json!({"type":"file_offer", "roomId":"private", "messageSeq":original.message.seq, "attachmentId":attachment["id"], "sha256":attachment["sha256"], "available":true});
        let denied = command(&mut host, owner, viewer, query.clone());
        assert!(matches!(
            denied.reply.unwrap().result,
            RoomResult::Error { .. }
        ));
        let mut stale = query.clone();
        stale["sha256"] = json!(piik_channel_core::attachment::sha256_hex(b"old copy"));
        let rejected = command(&mut host, owner, owner, stale.clone());
        assert!(
            matches!(rejected.reply.unwrap().result, RoomResult::Error { code } if code == "attachment_content_mismatch")
        );
        query["sha256"] = json!(attachment["sha256"].as_str().unwrap().to_ascii_uppercase());
        let readable = command(&mut host, owner, owner, query.clone());
        assert!(matches!(readable.reply.unwrap().result, RoomResult::Done));
        stale["available"] = json!(false);
        let rejected = command(&mut host, owner, owner, stale);
        assert!(
            matches!(rejected.reply.unwrap().result, RoomResult::Error { code } if code == "attachment_content_mismatch")
        );
        let receiving = command(
            &mut host,
            owner,
            owner,
            json!({"type":"file_receive", "roomId":"private", "messageSeq":original.message.seq, "attachmentId":attachment["id"], "enabled":true}),
        );
        assert!(matches!(receiving.reply.unwrap().result, RoomResult::Done));
        assert_eq!(
            receiving.projection.views[&owner].files[0].source_id,
            Some(owner)
        );
        query["available"] = json!(false);
        let withdrawn = command(&mut host, owner, owner, query);
        assert!(matches!(withdrawn.reply.unwrap().result, RoomResult::Done));
        assert_eq!(withdrawn.projection.views[&owner].files[0].source_id, None);
        let missing = command(
            &mut host,
            owner,
            owner,
            json!({"type":"file_offer", "roomId":"private", "messageSeq":original.message.seq+1, "attachmentId":attachment["id"], "sha256":attachment["sha256"], "available":true}),
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
                mentions: vec![],
                reply: None,
                inline_images: Default::default(),
                text: "Changed".into(),
                nonce: "file-send".into(),
                attachments: vec![serde_json::from_value(changed).unwrap()],
            },
        ));
        assert!(!retry.inserted);
        assert_eq!(
            serde_json::to_value(retry.message).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        let offer = json!({"type":"file_offer", "roomId":"private", "messageSeq":original.message.seq, "attachmentId":attachment["id"], "sha256":attachment["sha256"], "available":true});
        command(&mut host, owner, owner, offer.clone());
        let request = ConversationRequest {
            address: ConversationAddress {
                room_id: "private".into(),
                binding_id: owner,
                sender: owner,
                recipient: owner,
                request_id: "delete-file".into(),
            },
            command: ConversationCommand::DeleteMessage {
                message_seq: original.message.seq,
                message_id: original.message.id,
            },
        };
        let packet = SessionSigner::from_seed([1; 32])
            .sign(owner, &request)
            .unwrap();
        let outcome = host.dispatch_peer(&packet, 2).unwrap();
        assert!(matches!(
            outcome.result,
            Ok(ConversationResult::History(
                HistoryResult::MessageDeleted { .. }
            ))
        ));
        assert!(outcome.projection_update.unwrap().projection.views[&owner]
            .files
            .is_empty());
        assert!(
            matches!(command(&mut host, owner, owner, offer).reply.unwrap().result, RoomResult::Error { code } if code == "attachment_unavailable")
        );
        let frozen = path.with_extension("snapshot.sqlite");
        let backup = host.snapshot(&frozen, Uuid::new_v4(), None).unwrap();
        let mut exported = Vec::new();
        backup
            .for_each_row(|row| {
                exported.push(serde_json::to_value(row)?);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            exported,
            vec![json!({
                "seq": original.message.seq, "retryKey": piik_channel_core::history::retry_key(owner, "file-send")
            })]
        );
        assert!(backup.metadata().retained_files.is_empty());
        drop(backup);
        std::fs::remove_file(frozen).unwrap();
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn committed_removals_reach_their_background_file_participants() {
    let path = std::env::temp_dir().join(format!("piik-file-moderation-{}.sqlite", Uuid::new_v4()));
    let [owner, holder, receiver, reader, sibling] = std::array::from_fn(|_| Uuid::new_v4());
    let mut host =
        StoredRoomHost::create(&path, policy("room", owner, RoomAccess::Public)).unwrap();
    let attachment = json!({"id": Uuid::new_v4(), "name": "file", "size": 3,
        "mediaType": "application/octet-stream", "sha256": piik_channel_core::attachment::sha256_hex(b"abc")});
    let send = |host: &mut StoredRoomHost, nonce: &str| {
        sent(peer(
            host,
            owner,
            owner,
            ConversationCommand::Chat {
                nonce: nonce.into(),
                text: String::new(),
                mentions: vec![],
                reply: None,
                attachments: vec![serde_json::from_value(attachment.clone()).unwrap()],
                inline_images: Default::default(),
            },
        ))
        .message
        .message
    };
    let first = send(&mut host, "first");
    let second = send(&mut host, "second");
    let register = |host: &mut StoredRoomHost, actor, value: Value| {
        let command = Request::parse(&value.to_string()).unwrap().command;
        let mut turn = input(owner, actor, |context| HostAction::Command {
            context,
            command,
        });
        for id in [holder, receiver, reader, sibling] {
            turn.endpoints.insert(
                id,
                Endpoint {
                    member: Member { user_id: id },
                    ..turn.endpoints[&owner].clone()
                },
            );
        }
        assert!(matches!(
            host.dispatch(turn).unwrap().reply.unwrap().result,
            RoomResult::Done
        ));
    };
    register(
        &mut host,
        reader,
        json!({"type":"browse","roomId":"room","active":true}),
    );
    for (seq, actor) in [(first.seq, holder), (second.seq, sibling)] {
        register(
            &mut host,
            actor,
            json!({"type":"file_offer","roomId":"room","messageSeq":seq,"attachmentId":attachment["id"],"sha256":attachment["sha256"],"available":true}),
        );
    }
    for seq in [first.seq, second.seq] {
        register(
            &mut host,
            receiver,
            json!({"type":"file_receive","roomId":"room","messageSeq":seq,"attachmentId":attachment["id"],"enabled":true}),
        );
    }
    assert_eq!(host.current_readers(), vec![reader]);
    let moderate = |host: &mut StoredRoomHost, command| {
        let request = ConversationRequest {
            address: ConversationAddress {
                room_id: "room".into(),
                binding_id: owner,
                sender: owner,
                recipient: owner,
                request_id: Uuid::new_v4().to_string(),
            },
            command,
        };
        let packet = SessionSigner::from_seed([1; 32])
            .sign(owner, &request)
            .unwrap();
        host.dispatch_peer(&packet, 2).unwrap()
    };
    let rejected = moderate(
        &mut host,
        ConversationCommand::DeleteMessage {
            message_seq: first.seq,
            message_id: Uuid::new_v4(),
        },
    );
    assert!(rejected.result.is_err() && rejected.projection_update.is_none());
    assert_eq!(rejected.replies().unwrap().len(), 1);
    for (command, expected_holder, remaining) in [
        (
            ConversationCommand::DeleteMessage {
                message_seq: first.seq,
                message_id: first.id,
            },
            holder,
            Some(second.seq),
        ),
        (
            ConversationCommand::ClearHistory {
                through_seq: second.seq,
            },
            sibling,
            None,
        ),
    ] {
        let outcome = moderate(&mut host, command);
        let files = &outcome.projection_update.as_ref().unwrap().projection.views[&receiver].files;
        assert_eq!(
            files
                .iter()
                .map(|plan| plan.message_seq)
                .collect::<Vec<_>>(),
            remaining.into_iter().collect::<Vec<_>>()
        );
        let (replies, broadcast) = outcome.delivery().unwrap();
        assert!(broadcast.is_none());
        let mut recipients: Vec<_> = replies.into_iter().map(|reply| reply.address.recipient).collect();
        recipients.sort();
        let mut expected = vec![owner, reader, receiver, expected_holder];
        expected.sort();
        assert_eq!(recipients, expected);
    }
    drop(host);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn restored_sequence_rejects_reactions_for_its_previous_message() {
    let owner = Uuid::new_v4();
    let path = std::env::temp_dir().join(Uuid::new_v4().to_string());
    std::fs::create_dir(&path).unwrap();
    let mut host = StoredRoomHost::create(
        &path.join("live"),
        policy("same", owner, RoomAccess::Public),
    )
    .unwrap();
    let empty_backup = host
        .snapshot(&path.join("empty"), Uuid::new_v4(), None)
        .unwrap();
    let post = |text: &str| ConversationCommand::Chat {
        nonce: text.into(),
        text: text.into(),
        mentions: vec![],
        reply: None,
        attachments: vec![],
        inline_images: Default::default(),
    };
    let original = sent(peer(&mut host, owner, owner, post("original")))
        .message
        .message;
    let click = |message_id| ConversationCommand::React {
        target: ReactionTarget::Message {
            message_seq: original.seq,
            message_id,
        },
        reaction: "wave".into(),
        nonce: 1,
    };
    host.replace(&empty_backup).unwrap();
    let replacement = sent(peer(&mut host, owner, owner, post("replacement")))
        .message
        .message;
    assert_eq!(original.seq, replacement.seq);
    assert_ne!(original.id, replacement.id);
    assert_eq!(
        peer(&mut host, owner, owner, click(original.id)).err(),
        Some("message_unavailable")
    );
    let HistoryResult::Reacted(result) =
        peer(&mut host, owner, owner, click(replacement.id)).unwrap()
    else {
        panic!("expected the replacement message's reaction")
    };
    assert_eq!(result.snapshot.message_id, replacement.id);
    assert_eq!(result.snapshot.reactions.counts["wave"], 1);
    assert!(result.event.is_some());
    drop(host);
    drop(empty_backup);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn installed_history_lineage_survives_rebind_and_rolls_back_with_history() {
    let folder = std::env::temp_dir().join(format!("piik-install-{}", Uuid::new_v4()));
    std::fs::create_dir(&folder).unwrap();
    let path = folder.join("live.sqlite");
    let owner = Uuid::new_v4();
    let guest = Uuid::new_v4();
    let mut host =
        StoredRoomHost::create(&path, policy("room", owner, RoomAccess::Private)).unwrap();
    let project = |host: &mut StoredRoomHost| {
        let result = host
            .dispatch(input(owner, guest, |_| HostAction::Sync))
            .unwrap()
            .projection;
        let g = result.history_lineage;
        assert!(!g.is_nil());
        assert_eq!(
            result.snapshot(owner, true).unwrap().room.history_lineage,
            Some(g)
        );
        assert_eq!(
            result.snapshot(owner, false).unwrap().room.history_lineage,
            None
        );
        assert_eq!(
            result.snapshot(guest, true).unwrap().room.history_lineage,
            None
        );
        g
    };
    let original = project(&mut host);
    let backup = host
        .snapshot(&folder.join("frozen.sqlite"), Uuid::new_v4(), None)
        .unwrap();
    let metadata = serde_json::to_string(backup.metadata()).unwrap();
    assert!(!metadata.contains(&original.to_string()) && !metadata.contains("bindingId"));
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    assert_eq!(project(&mut host), original);
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_install BEFORE INSERT ON checkpoint BEGIN SELECT RAISE(ABORT,'rejected'); END;").unwrap();
    assert!(host.replace(&backup).is_err());
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    assert_eq!(project(&mut host), original);
    sql.execute_batch("DROP TRIGGER reject_install").unwrap();
    host.replace(&backup).unwrap();
    let g2 = project(&mut host);
    host.replace(&backup).unwrap();
    let g3 = project(&mut host);
    assert_ne!(original, g2);
    assert_ne!(g2, g3);
    drop(host);
    let mut host = StoredRoomHost::open(&path).unwrap();
    assert_eq!(project(&mut host), g3);
    drop(host);
    let mut restored =
        StoredRoomHost::from_backup(&folder.join("restored.sqlite"), &backup).unwrap();
    assert_ne!(project(&mut restored), g3);
    drop((restored, sql, backup));
    std::fs::remove_dir_all(folder).unwrap();
}
