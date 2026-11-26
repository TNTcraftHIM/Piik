//! One native room's storage and exclusive runtime ownership.
use anyhow::{anyhow, bail, Result};
use piik_channel_core::{
    conversation::{ConversationOutcome, SignedPacket},
    host::{HostInput, HostOutput, RoomSummary},
    storage::{StorageDataError, StoreResult},
    RoomBackup, RoomState, StoredRoomHost,
};
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const INSTALL_EXTENSION: &str = "piik-room-install";

pub struct HostedRoom {
    path: PathBuf,
    host: StoredRoomHost,
    binding: tokio::sync::watch::Sender<Option<Uuid>>,
    // Keep the process lock until the room runtime and SQLite connection drop.
    _file_owner: File,
}

pub(crate) fn storage_error(error: Box<dyn std::error::Error + Send + Sync>) -> anyhow::Error {
    // Preserve the data-error type across the boxed Core/anyhow boundary.
    match error.downcast::<StorageDataError>() {
        Ok(error) => anyhow::Error::new(*error),
        Err(error) => anyhow::Error::from_boxed(error),
    }
}

impl HostedRoom {
    pub(crate) fn creator_id(&self) -> Uuid {
        self.host.policy().creator_id
    }

    pub(crate) fn snapshot_source(&self) -> (PathBuf, String, Uuid) {
        (
            self.path.clone(),
            self.host.policy().id.clone(),
            self.host.policy().creator_id,
        )
    }

    pub fn from_backup(path: &Path, backup: &RoomBackup, identity: (Uuid, Uuid)) -> Result<Self> {
        backup_identity(backup, identity)?;
        let file_owner = lock(path, &backup.metadata().policy.id)?;
        Self::install(path, file_owner, |staged| {
            StoredRoomHost::from_backup(staged, backup)
        })
    }

    /// The session serializes this operation and registers the room again with
    /// resume_binding=None. Its file lock remains held throughout replacement.
    pub fn replace(&mut self, backup: &RoomBackup, identity: (Uuid, Uuid)) -> Result<()> {
        backup_identity(backup, identity)?;
        self.host
            .replace(backup)
            .map_err(anyhow::Error::from_boxed)?;
        self.binding.send_replace(None);
        Ok(())
    }

    pub fn open(path: &Path, room_id: &str, creator: Uuid) -> Result<Self> {
        let file_owner = lock(path, room_id)?;
        let host = StoredRoomHost::open(path).map_err(storage_error)?;
        if host.policy().id != room_id || host.policy().creator_id != creator {
            bail!("room storage does not belong to this room and admitted identity");
        }
        Ok(Self {
            path: path.into(),
            host,
            binding: tokio::sync::watch::channel(None).0,
            _file_owner: file_owner,
        })
    }

    pub fn create(path: &Path, policy: RoomState) -> Result<Self> {
        let file_owner = lock(path, &policy.id)?;
        Self::install(path, file_owner, |staged| {
            StoredRoomHost::create(staged, policy)
        })
    }

    fn install(
        path: &Path,
        file_owner: File,
        initialize: impl FnOnce(&Path) -> StoreResult<StoredRoomHost>,
    ) -> Result<Self> {
        // Discovery treats an existing room path as committed, including on restart.
        // tempfile passes both paths directly to Win32 when publishing.
        let parent = std::fs::canonicalize(
            path.parent()
                .filter(|dir| !dir.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
        let target = parent.join(
            path.file_name()
                .ok_or_else(|| anyhow!("invalid room path"))?,
        );
        let scratch = target.with_added_extension(INSTALL_EXTENSION);
        remove_install_dir(&scratch)?;
        let staging = tempfile::Builder::new()
            .prefix(
                scratch
                    .file_name()
                    .ok_or_else(|| anyhow!("invalid room path"))?,
            )
            .rand_bytes(0)
            .tempdir_in(&parent)?;
        let staged = tempfile::TempPath::try_from_path(staging.path().join("room.sqlite"))?;
        drop(initialize(&staged).map_err(storage_error)?);
        staged.persist_noclobber(&target).map_err(|failure| {
            if failure.error.kind() == io::ErrorKind::AlreadyExists {
                anyhow!("room_already_exists")
            } else {
                failure.error.into()
            }
        })?;
        let host = StoredRoomHost::open(path).map_err(storage_error)?;
        Ok(Self {
            path: path.into(),
            host,
            binding: tokio::sync::watch::channel(None).0,
            _file_owner: file_owner,
        })
    }

    pub(crate) fn publish_binding(&mut self, binding: tokio::sync::watch::Sender<Option<Uuid>>) {
        binding.send_replace(self.binding());
        self.binding = binding;
    }

    pub fn binding(&self) -> Option<Uuid> {
        *self.binding.borrow()
    }

    pub fn bind(&mut self, binding: Uuid) -> Result<()> {
        if self.binding().is_some_and(|old| old != binding) {
            self.host =
                StoredRoomHost::open(&self.path).map_err(|error| anyhow!(error.to_string()))?;
        }
        self.binding.send_replace(Some(binding));
        Ok(())
    }

    pub fn summary(&self) -> RoomSummary {
        self.host.summary()
    }

    pub fn dispatch(&mut self, input: HostInput) -> Result<HostOutput, &'static str> {
        if self.binding() != Some(input.binding_id) {
            return Err("stale_room_host");
        }
        self.host.dispatch(input)
    }

    pub fn dispatch_peer(
        &mut self,
        packet: &SignedPacket,
        now: u64,
    ) -> Result<ConversationOutcome, &'static str> {
        if self.binding().is_none() {
            return Err("stale_room_host");
        }
        self.host.dispatch_peer(packet, now)
    }

    pub(crate) fn discard_unpublished(self) -> Result<()> {
        drop(self.host);
        // Keep the stable advisory lock held until SQLite and its file are gone.
        std::fs::remove_file(self.path)?;
        Ok(())
    }

    pub(crate) fn delete_data(&mut self) -> Result<()> {
        self.host.delete_data().map_err(storage_error)
    }

    pub fn current_readers(&self) -> Vec<Uuid> {
        self.host.current_readers()
    }
}

fn remove_install_dir(path: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Discovery may run beside another process installing into the same directory.
pub(crate) fn reclaim_room_install(path: &Path) -> io::Result<()> {
    if path.extension().and_then(|ext| ext.to_str()) != Some(INSTALL_EXTENSION) {
        return Ok(());
    }
    let target = path.with_extension("");
    if target.extension().and_then(|ext| ext.to_str()) != Some("sqlite") {
        return Ok(());
    }
    let owner = match File::options()
        .read(true)
        .write(true)
        .open(target.with_added_extension("lock"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    match try_lock_file(&owner) {
        Ok(()) => remove_install_dir(path),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
        Err(error) => Err(error),
    }
}

pub(crate) fn backup_identity(backup: &RoomBackup, (domain, owner): (Uuid, Uuid)) -> Result<()> {
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

#[derive(Debug)]
pub(crate) struct RoomStorageInUse(String);

impl std::fmt::Display for RoomStorageInUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "room_storage_in_use: {}", self.0)
    }
}

impl std::error::Error for RoomStorageInUse {}

fn lock(path: &Path, room_id: &str) -> Result<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_added_extension("lock"))?;
    match try_lock_file(&file) {
        Ok(()) => Ok(file),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            Err(RoomStorageInUse(room_id.into()).into())
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_initialization_keeps_the_room_path_available_for_retry() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let owner = Uuid::new_v4();
        let policy = |id: &str| {
            RoomState::new(
                id.into(),
                id.into(),
                Default::default(),
                owner,
                piik_channel_core::wire::RoomAccess::Public,
                false,
                None,
            )
            .unwrap()
        };
        let path = folder.path().join("living.sqlite");
        let sibling = folder.path().join("quiet.sqlite");
        let quiet = HostedRoom::create(&sibling, policy("quiet"))?;
        let result = HostedRoom::install(&path, lock(&path, "living")?, |staged| {
            File::create_new(staged)?;
            assert!(!path.try_exists()?);
            Err("interrupted_before_schema".into())
        });
        assert_eq!(
            result.err().unwrap().to_string(),
            "interrupted_before_schema"
        );
        assert!(!path.try_exists()?);
        drop(HostedRoom::create(&path, policy("living"))?);
        let original = std::fs::read(&path)?;
        assert!(HostedRoom::create(&path, policy("replacement")).is_err());
        assert_eq!(std::fs::read(&path)?, original);
        assert_eq!(
            HostedRoom::open(&path, "living", owner)?.summary().id,
            "living"
        );
        assert_eq!(quiet.summary().id, "quiet");
        Ok(())
    }

    #[test]
    fn backup_replacement_keeps_exclusive_ownership_and_requires_a_fresh_binding() -> Result<()> {
        use piik_channel_core::{backup::RoomMetadata, host::HostAction, wire::RoomAccess};
        let root = tempfile::tempdir()?;
        let mut folder = root.path().to_owned();
        while folder.as_os_str().len() < 270 {
            folder.push("nested-room-installation");
        }
        std::fs::create_dir_all(&folder)?;
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
                version: RoomMetadata::VERSION,
                domain_id: domain,
                policy: room.clone(),
                own_credential: None,
                retained_files: vec![],
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
            hosting_mode: Default::default(),
            channel_owner_id: Uuid::nil(),
            service_endpoint: None,
            now: 1,
            binding_id: old_binding,
            host_session_id: owner,
            revision: 1,
            confirmed_pairs: Default::default(),
            disconnected_pairs: Default::default(),
            failed_pairs: Vec::new(),
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
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: host_key.signing_key(),
                },
            ),
            (
                sender,
                Endpoint {
                    member: actor,
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: actor_key.signing_key(),
                },
            ),
            (
                other,
                Endpoint {
                    member: outsider,
                    can_use_peer_transport: true,
                    connected: true,
                    signing_key: actor_key.signing_key(),
                },
            ),
        ]);
        let input = |endpoints: &BTreeMap<Uuid, Endpoint>, binding_id| HostInput {
            hosting_mode: Default::default(),
            channel_owner_id: Uuid::nil(),
            service_endpoint: None,
            now: 0,
            binding_id,
            host_session_id: local,
            revision: 1,
            confirmed_pairs: Default::default(),
            disconnected_pairs: Default::default(),
            failed_pairs: Vec::new(),
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
            matches!(&ready[0].record, ConversationRecord::InteractionReady { server_time: 500, reaction_ids, .. } if reaction_ids.iter().any(|id| id == "wave"))
        );
        let action = packet(
            sender,
            ConversationCommand::React {
                nonce: 1,
                reaction: "tomato".into(),
                target: piik_channel_core::conversation::ReactionTarget::Person {
                    user_id: owner.user_id,
                },
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
            matches!(&replies[0].record, ConversationRecord::Reaction { event: Some(event), .. }
                if event.occurred_at == 1000 && event.sender_user_id == actor.user_id && event.reaction == "tomato"
                && event.target == (piik_channel_core::conversation::ReactionTarget::Person { user_id: owner.user_id }))
        );
        let signed = host_key.sign(local, &replies[0]).unwrap();
        assert_eq!(
            ConversationReply::verify(&signed, host_key.signing_key())
                .unwrap()
                .address,
            replies[0].address
        );
        assert!(matches!(
            host.dispatch_peer(&action, 1001)
                .unwrap()
                .replies()
                .unwrap()[0]
                .record,
            ConversationRecord::Reaction { event: None, .. }
        ));
        let private_target = packet(
            sender,
            ConversationCommand::React {
                nonce: 2,
                reaction: "wave".into(),
                target: piik_channel_core::conversation::ReactionTarget::Person {
                    user_id: outsider.user_id,
                },
            },
        );
        assert!(
            matches!(host.dispatch_peer(&private_target, 1800).unwrap().replies().unwrap()[0].record,
                ConversationRecord::Error { ref code } if code == "target_unavailable")
        );
        endpoints.get_mut(&local).unwrap().connected = false;
        host.dispatch(input(&endpoints, binding)).unwrap();
        assert!(
            matches!(host.dispatch_peer(&packet(sender, ConversationCommand::React {
                nonce: 2, reaction: "tomato".into(), target: piik_channel_core::conversation::ReactionTarget::Person { user_id: owner.user_id },
            }), 2600).unwrap().replies().unwrap()[0].record,
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
