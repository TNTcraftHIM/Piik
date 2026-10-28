//! One native room's storage and exclusive runtime ownership.
use anyhow::{anyhow, bail, Result};
use piik_channel_core::{
    conversation::{ConversationOutcome, SignedPacket},
    host::{HostInput, HostOutput, RoomSummary},
    RoomState, StoredRoomHost,
};
use std::{
    fs::File,
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

fn lock(path: &Path, room_id: &str) -> Result<File> {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => bail!("room_storage_in_use: {room_id}"),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}
