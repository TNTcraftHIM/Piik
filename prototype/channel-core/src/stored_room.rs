//! Native room execution and SQLite persistence. Transport and session lifetime
//! remain with the caller; this adapter executes one room input at a time.
use crate::{
    backup::{HistoryRow, OwnCredential, RoomMetadata},
    host::{HostInput, HostOutput, RoomHost, RoomSummary},
    storage::{Storage, StoreResult},
    RoomState,
};
use std::path::Path;
use uuid::Uuid;

/// A frozen local database for streaming export or a fully validated import.
/// The caller owns the disposable path; only this handle can mutate its store.
pub struct RoomBackup {
    metadata: RoomMetadata,
    store: Storage,
}

impl RoomBackup {
    pub fn metadata(&self) -> &RoomMetadata {
        &self.metadata
    }

    /// Build a fresh, known SQLite schema from portable rows. No imported SQL or
    /// database file is executed. A failed row rolls back the whole import.
    pub fn stage(
        path: &Path,
        metadata: RoomMetadata,
        rows: impl IntoIterator<Item = StoreResult<HistoryRow>>,
    ) -> StoreResult<Self> {
        metadata.validate()?;
        let mut store = Storage::create_staging(path)?;
        store.stage_room(&metadata.policy, rows)?;
        Ok(Self { metadata, store })
    }

    pub fn for_each_row(
        &self,
        visit: impl FnMut(HistoryRow) -> StoreResult<()>,
    ) -> StoreResult<()> {
        self.store
            .for_each_history_row(&self.metadata.policy.id, visit)
    }
}

pub struct StoredRoomHost {
    host: RoomHost,
    store: Storage,
}

impl StoredRoomHost {
    pub fn snapshot(
        &self,
        path: &Path,
        domain_id: Uuid,
        own_credential: Option<OwnCredential>,
    ) -> StoreResult<RoomBackup> {
        let store = self.store.snapshot(path)?;
        let metadata = RoomMetadata {
            version: 1,
            domain_id,
            policy: serde_json::from_value(store.load()?.ok_or("room_not_found")?)?,
            own_credential,
            retained_files: vec![],
        };
        metadata.validate()?;
        Ok(RoomBackup { metadata, store })
    }

    /// Install a validated snapshot during the owner's serialized turn. Only
    /// durable policy/history survive; the replacement room has no live state.
    pub fn replace(&mut self, backup: &RoomBackup) -> StoreResult<()> {
        let policy = &backup.metadata.policy;
        if policy.id != self.host.policy().id || policy.creator_id != self.host.policy().creator_id
        {
            return Err("backup_room_mismatch".into());
        }
        self.store.replace_from(&backup.store)?;
        self.host = RoomHost::new(policy.clone());
        Ok(())
    }

    pub fn from_backup(path: &Path, backup: &RoomBackup) -> StoreResult<Self> {
        let store = backup.store.snapshot(path)?;
        Ok(Self {
            host: RoomHost::new(backup.metadata.policy.clone()),
            store,
        })
    }

    /// The caller supplies a trusted, separate database path for this room.
    pub fn create(path: &Path, policy: RoomState) -> StoreResult<Self> {
        let mut store = Storage::open(path)?;
        if store.load()?.is_some() {
            return Err("room_already_exists".into());
        }
        store.save(&serde_json::to_value(&policy)?)?;
        Ok(Self {
            host: RoomHost::new(policy),
            store,
        })
    }

    pub fn open(path: &Path) -> StoreResult<Self> {
        std::fs::metadata(path)?;
        let store = Storage::open(path)?;
        let policy = serde_json::from_value(store.load()?.ok_or("room_not_found")?)?;
        Ok(Self {
            host: RoomHost::new(policy),
            store,
        })
    }

    pub fn dispatch_peer(
        &mut self,
        packet: &crate::conversation::SignedPacket,
        now: u64,
    ) -> Result<crate::conversation::ConversationOutcome, &'static str> {
        let prepared = self.host.prepare_peer(packet, now)?;
        use crate::conversation::{ConversationResult, ConversationWork};
        let result = prepared.work.and_then(|work| match work {
            ConversationWork::History(request) => self
                .store
                .history(&request)
                .map(ConversationResult::History),
            ConversationWork::Immediate(record) => Ok(ConversationResult::Immediate(record)),
        });
        Ok(crate::conversation::ConversationOutcome {
            address: prepared.address,
            result,
        })
    }

    pub fn current_readers(&self) -> Vec<uuid::Uuid> {
        self.host.current_readers()
    }

    pub fn policy(&self) -> &RoomState {
        self.host.policy()
    }

    pub fn summary(&self) -> RoomSummary {
        self.host.summary()
    }

    /// Domain-authenticated input follows the same commit boundary as Browser
    /// hosting. A storage failure completes with the core's scoped error output.
    pub fn dispatch(&mut self, input: HostInput) -> Result<HostOutput, &'static str> {
        let work = self.host.dispatch(input)?;
        let result = (|| {
            if let Some(policy) = work.policy {
                let value = serde_json::to_value(policy).map_err(|_| "storage_failed")?;
                self.store.save(&value).map_err(|_| "storage_failed")?;
            }
            work.history
                .as_ref()
                .map(|request| self.store.history(request))
                .transpose()
        })();
        match result {
            Ok(history) => self.host.finish(history),
            Err(code) => self.host.abort(code.into()),
        }
    }
}
