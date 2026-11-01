//! One native room's storage and exclusive runtime ownership.
use anyhow::{anyhow, bail, Result};
use piik_channel_core::{
    backup::OwnCredential,
    conversation::{ConversationOutcome, SignedPacket},
    host::{HostInput, HostOutput, RoomSummary},
    RoomBackup, RoomState, StoredRoomHost,
};
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub struct HostedRoom {
    path: PathBuf,
    host: StoredRoomHost,
    binding: Option<Uuid>,
    // Keep the process lock until the room runtime and SQLite connection drop.
    _file_owner: File,
}

impl HostedRoom {
    pub fn snapshot(
        &self,
        path: &Path,
        domain_id: Uuid,
        own_credential: Option<OwnCredential>,
    ) -> Result<RoomBackup> {
        self.host
            .snapshot(path, domain_id, own_credential)
            .map_err(anyhow::Error::from_boxed)
    }

    pub fn from_backup(path: &Path, backup: &RoomBackup, identity: (Uuid, Uuid)) -> Result<Self> {
        backup_identity(backup, identity)?;
        let file_owner = lock(path, &backup.metadata().policy.id)?;
        let host = StoredRoomHost::from_backup(path, backup).map_err(anyhow::Error::from_boxed)?;
        Ok(Self {
            path: path.into(),
            host,
            binding: None,
            _file_owner: file_owner,
        })
    }

    /// The session serializes this operation and registers the room again with
    /// resume_binding=None. Its file lock remains held throughout replacement.
    pub fn replace(&mut self, backup: &RoomBackup, identity: (Uuid, Uuid)) -> Result<()> {
        backup_identity(backup, identity)?;
        self.host
            .replace(backup)
            .map_err(anyhow::Error::from_boxed)?;
        self.binding = None;
        Ok(())
    }

    pub fn open(path: &Path, room_id: &str, creator: Uuid) -> Result<Self> {
        let file_owner = lock(path, room_id)?;
        let host = StoredRoomHost::open(path).map_err(|error| anyhow!(error.to_string()))?;
        if host.policy().id != room_id || host.policy().creator_id != creator {
            bail!("room storage does not belong to this room and admitted identity");
        }
        Ok(Self {
            path: path.into(),
            host,
            binding: None,
            _file_owner: file_owner,
        })
    }

    pub fn create(path: &Path, policy: RoomState) -> Result<Self> {
        let file_owner = lock(path, &policy.id)?;
        let host =
            StoredRoomHost::create(path, policy).map_err(|error| anyhow!(error.to_string()))?;
        Ok(Self {
            path: path.into(),
            host,
            binding: None,
            _file_owner: file_owner,
        })
    }

    pub fn binding(&self) -> Option<Uuid> {
        self.binding
    }

    pub fn bind(&mut self, binding: Uuid) -> Result<()> {
        if self.binding.is_some_and(|old| old != binding) {
            self.host =
                StoredRoomHost::open(&self.path).map_err(|error| anyhow!(error.to_string()))?;
        }
        self.binding = Some(binding);
        Ok(())
    }

    pub fn summary(&self) -> RoomSummary {
        self.host.summary()
    }

    pub fn dispatch(&mut self, input: HostInput) -> Result<HostOutput, &'static str> {
        if self.binding != Some(input.binding_id) {
            return Err("stale_room_host");
        }
        self.host.dispatch(input)
    }

    pub fn dispatch_peer(
        &mut self,
        packet: &SignedPacket,
        now: u64,
    ) -> Result<ConversationOutcome, &'static str> {
        if self.binding.is_none() {
            return Err("stale_room_host");
        }
        self.host.dispatch_peer(packet, now)
    }

    pub fn current_readers(&self) -> Vec<Uuid> {
        self.host.current_readers()
    }
}

fn backup_identity(backup: &RoomBackup, (domain, owner): (Uuid, Uuid)) -> Result<()> {
    if backup.metadata().domain_id != domain || backup.metadata().policy.creator_id != owner {
        bail!("backup_owner_mismatch");
    }
    Ok(())
}

/// The caller keeps the file open for the lifetime of its exclusive ownership.
pub fn try_lock_file(file: &File) -> io::Result<()> {
    // std's Unix implementation omits Android on the pinned Rust toolchain.
    #[cfg(unix)]
    return rustix::fs::flock(file, rustix::fs::FlockOperation::NonBlockingLockExclusive)
        .map_err(io::Error::from);
    #[cfg(not(unix))]
    file.try_lock().map_err(io::Error::from)
}

fn lock(path: &Path, room_id: &str) -> Result<File> {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    match try_lock_file(&file) {
        Ok(()) => Ok(file),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            bail!("room_storage_in_use: {room_id}")
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_replacement_keeps_exclusive_ownership_and_requires_a_fresh_binding() -> Result<()> {
        use piik_channel_core::{backup::RoomMetadata, host::HostAction, wire::RoomAccess};
        let folder = std::env::temp_dir().join(format!("piik-native-backup-{}", Uuid::new_v4()));
        std::fs::create_dir(&folder)?;
        let (domain, owner, old_binding) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let room = RoomState::new(
            "room".into(),
            "Restored".into(),
            Default::default(),
            owner,
            RoomAccess::Public,
            false,
            None,
        )
        .map_err(anyhow::Error::msg)?;
        let backup = RoomBackup::stage(
            &folder.join("staged.sqlite"),
            RoomMetadata {
                version: 1,
                domain_id: domain,
                policy: room.clone(),
                own_credential: None,
            },
            std::iter::empty(),
        )
        .map_err(anyhow::Error::from_boxed)?;
        let path = folder.join("live.sqlite");
        let mut host = HostedRoom::create(&path, room)?;
        host.bind(old_binding)?;
        assert!(host.replace(&backup, (Uuid::new_v4(), owner)).is_err());
        assert_eq!(host.binding(), Some(old_binding));
        host.replace(&backup, (domain, owner))?;
        assert_eq!(host.binding(), None);
        assert!(HostedRoom::open(&path, "room", owner).is_err());
        let stale = || HostInput {
            now: 1,
            binding_id: old_binding,
            host_session_id: owner,
            revision: 1,
            endpoints: Default::default(),
            action: HostAction::Sync,
        };
        assert!(matches!(host.dispatch(stale()), Err("stale_room_host")));
        let fresh = Uuid::new_v4();
        host.bind(fresh)?;
        assert_eq!(host.binding(), Some(fresh));
        assert!(matches!(host.dispatch(stale()), Err("stale_room_host")));
        let imported = folder.join("imported.sqlite");
        assert!(HostedRoom::from_backup(&imported, &backup, (domain, Uuid::new_v4())).is_err());
        assert!(!imported.exists());
        let restored = HostedRoom::from_backup(&imported, &backup, (domain, owner))?;
        assert_eq!(restored.summary().id, "room");
        assert!(restored.binding().is_none());
        drop((host, restored, backup));
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[test]
    fn signed_interactions_use_read_access_and_the_current_native_binding_without_history(
    ) -> Result<()> {
        use piik_channel_core::{
            conversation::{
                ConversationAddress, ConversationCommand, ConversationRecord, ConversationReply,
                ConversationRequest, SessionSigner,
            },
            host::HostAction,
            storage::Storage,
            wire::RoomAccess,
            Endpoint, Member,
        };
        use std::collections::BTreeMap;
        let folder =
            std::env::temp_dir().join(format!("piik-native-interaction-{}", Uuid::new_v4()));
        std::fs::create_dir(&folder)?;
        let path = folder.join("room.sqlite");
        let owner = Member {
            user_id: Uuid::new_v4(),
            participates: false,
            domain_owner: false,
        };
        let actor = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let outsider = Member {
            user_id: Uuid::new_v4(),
            ..owner
        };
        let (local, sender, other, binding) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let actor_key = SessionSigner::from_seed([1; 32]);
        let host_key = SessionSigner::from_seed([2; 32]);
        let mut policy = RoomState::new(
            "room".into(),
            "Room".into(),
            Default::default(),
            owner.user_id,
            RoomAccess::Private,
            false,
            None,
        )
        .unwrap();
        policy.grants.insert(actor.user_id);
        let original = serde_json::to_value(&policy)?;
        let mut host = HostedRoom::create(&path, policy)?;
        host.bind(binding)?;
        let mut endpoints = BTreeMap::from([
            (
                local,
                Endpoint {
                    member: owner,
                    connected: true,
                    signing_key: host_key.signing_key(),
                },
            ),
            (
                sender,
                Endpoint {
                    member: actor,
                    connected: true,
                    signing_key: actor_key.signing_key(),
                },
            ),
            (
                other,
                Endpoint {
                    member: outsider,
                    connected: true,
                    signing_key: actor_key.signing_key(),
                },
            ),
        ]);
        let input = |endpoints: &BTreeMap<Uuid, Endpoint>, binding_id| HostInput {
            now: 0,
            binding_id,
            host_session_id: local,
            revision: 1,
            endpoints: endpoints.clone(),
            action: HostAction::Sync,
        };
        host.dispatch(input(&endpoints, binding)).unwrap();
        let packet = |sender, command| {
            actor_key
                .sign(
                    sender,
                    &ConversationRequest {
                        address: ConversationAddress {
                            room_id: "room".into(),
                            binding_id: binding,
                            sender,
                            recipient: local,
                            request_id: "action".into(),
                        },
                        command,
                    },
                )
                .unwrap()
        };
        let ready = host
            .dispatch_peer(&packet(sender, ConversationCommand::InteractionReady), 500)
            .unwrap()
            .replies()
            .unwrap();
        assert!(
            matches!(&ready[0].record, ConversationRecord::InteractionReady { server_time: 500, reaction_ids } if reaction_ids.iter().any(|id| id == "wave"))
        );
        let action = packet(
            sender,
            ConversationCommand::Interaction {
                reaction: "tomato".into(),
                target_user_id: Some(owner.user_id),
            },
        );
        let replies = host
            .dispatch_peer(&action, 1000)
            .unwrap()
            .replies()
            .unwrap();
        assert_eq!(replies[0].address.request_id, "action");
        assert_eq!(replies[0].address.sender, local);
        assert_eq!(replies[0].address.recipient, sender);
        assert!(
            matches!(&replies[0].record, ConversationRecord::Interaction { occurred_at: 1000, sender_user_id, reaction, target_user_id: Some(target), .. }
                if *sender_user_id == actor.user_id && reaction == "tomato" && *target == owner.user_id)
        );
        let signed = host_key.sign(local, &replies[0]).unwrap();
        assert_eq!(
            ConversationReply::verify(&signed, host_key.signing_key())
                .unwrap()
                .address,
            replies[0].address
        );
        assert!(
            matches!(host.dispatch_peer(&action, 1001).unwrap().replies().unwrap()[0].record,
                ConversationRecord::Error { ref code } if code == "rate_limited")
        );
        let private_target = packet(
            sender,
            ConversationCommand::Interaction {
                reaction: "wave".into(),
                target_user_id: Some(outsider.user_id),
            },
        );
        assert!(
            matches!(host.dispatch_peer(&private_target, 1800).unwrap().replies().unwrap()[0].record,
                ConversationRecord::Error { ref code } if code == "target_unavailable")
        );
        endpoints.get_mut(&local).unwrap().connected = false;
        host.dispatch(input(&endpoints, binding)).unwrap();
        assert!(
            matches!(host.dispatch_peer(&action, 2600).unwrap().replies().unwrap()[0].record,
                ConversationRecord::Error { ref code } if code == "target_unavailable")
        );
        assert!(
            matches!(host.dispatch_peer(&packet(other, ConversationCommand::InteractionReady), 5000).unwrap().replies().unwrap()[0].record,
                ConversationRecord::Error { ref code } if code == "room_access_required")
        );
        let mut store = Storage::open(&path).map_err(|e| anyhow!(e.to_string()))?;
        assert_eq!(
            store.load().map_err(|e| anyhow!(e.to_string()))?.unwrap(),
            original
        );
        assert!(
            matches!(store.history(&piik_channel_core::history::HistoryRequest::Read { room_id: "room".into(), before: None }).unwrap(),
                piik_channel_core::history::HistoryResult::Page { messages, .. } if messages.is_empty())
        );
        let replacement = Uuid::new_v4();
        host.bind(replacement)?;
        host.dispatch(input(&endpoints, replacement)).unwrap();
        assert!(matches!(
            host.dispatch_peer(&action, 6000),
            Err("invalid_conversation_scope")
        ));
        drop(store);
        drop(host);
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[test]
    fn room_lock_is_exclusive_until_its_file_closes() -> Result<()> {
        let directory = std::env::temp_dir().join(format!("piik-room-lock-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory)?;
        let path = directory.join("room.sqlite");
        let owner = lock(&path, "test-room")?;
        assert_eq!(
            lock(&path, "test-room").unwrap_err().to_string(),
            "room_storage_in_use: test-room"
        );
        drop(owner);
        drop(lock(&path, "test-room")?);
        std::fs::remove_file(directory.join("room.sqlite.lock"))?;
        std::fs::remove_dir(directory)?;
        Ok(())
    }
}
