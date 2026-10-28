//! Native room execution and SQLite persistence. Transport and session lifetime
//! remain with the caller; this adapter executes one room input at a time.
use crate::{
    host::{HostInput, HostOutput, RoomHost, RoomSummary},
    storage::{Storage, StoreResult},
    RoomState,
};
use std::path::Path;

pub struct StoredRoomHost {
    host: RoomHost,
    store: Storage,
}

impl StoredRoomHost {
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
