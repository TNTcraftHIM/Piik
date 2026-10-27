//! The local Server experiment's durable checkpoint and bounded attachment store.
//! Media sessions and routes never enter this database.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeSet, path::Path};
use uuid::Uuid;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_file_bytes: usize,
    pub total_bytes: u64,
    pub max_stored_files: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 16 * 1024 * 1024,
            total_bytes: 128 * 1024 * 1024,
            max_stored_files: 256,
        }
    }
}
const PENDING_LIFETIME_MS: u64 = 60 * 60 * 1000;
pub type StoreResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: Uuid,
    pub room_id: String,
    pub user_id: Uuid,
    pub name: String,
    pub size: u64,
    pub media_type: String,
    pub created_at: u64,
}

pub struct Storage {
    connection: Connection,
    pub limits: Limits,
}

impl Storage {
    pub fn open(path: &Path, limits: Limits) -> StoreResult<Self> {
        if limits.max_file_bytes == 0
            || limits.max_file_bytes as u64 > limits.total_bytes
            || limits.max_stored_files == 0
        {
            return Err("invalid_attachment_limits".into());
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS attachment (
               id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL,
               name TEXT NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL,
               committed INTEGER NOT NULL DEFAULT 0, content BLOB NOT NULL
             );",
        )?;
        Ok(Self { connection, limits })
    }

    pub fn load(&self) -> StoreResult<Option<Value>> {
        self.connection
            .query_row("SELECT body FROM checkpoint WHERE id=1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .map(|body| serde_json::from_str(&body).map_err(Into::into))
            .transpose()
    }

    /// Commit authority state before publishing its events. Previously referenced
    /// content follows retained history; unfinished uploads expire after one hour.
    pub fn save(
        &mut self,
        state: &Value,
        references: &BTreeSet<Uuid>,
        now: u64,
    ) -> StoreResult<()> {
        let body = serde_json::to_string(state)?;
        let transaction = self.connection.transaction()?;
        transaction.execute("INSERT INTO checkpoint(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [body])?;
        let rows = {
            let mut query =
                transaction.prepare("SELECT id,committed,created_at FROM attachment")?;
            let rows = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, u64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (id, committed, created_at) in rows {
            if references.contains(&Uuid::parse_str(&id)?) {
                transaction.execute("UPDATE attachment SET committed=1 WHERE id=?1", [&id])?;
            } else if committed || now.saturating_sub(created_at) >= PENDING_LIFETIME_MS {
                transaction.execute("DELETE FROM attachment WHERE id=?1", [&id])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn put(&mut self, attachment: &Attachment, content: &[u8], now: u64) -> StoreResult<()> {
        if content.len() > self.limits.max_file_bytes || attachment.size != content.len() as u64 {
            return Err("file_too_large".into());
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM attachment WHERE committed=0 AND created_at<=?1",
            [now.saturating_sub(PENDING_LIFETIME_MS)],
        )?;
        let (count, bytes): (u64, u64) = transaction.query_row(
            "SELECT count(*),coalesce(sum(length(content)),0) FROM attachment",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if count >= self.limits.max_stored_files
            || bytes.saturating_add(content.len() as u64) > self.limits.total_bytes
        {
            return Err("attachment_store_full".into());
        }
        transaction.execute("INSERT INTO attachment(id,room_id,user_id,name,media_type,created_at,content) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![attachment.id.to_string(), attachment.room_id, attachment.user_id.to_string(), attachment.name,
                attachment.media_type, attachment.created_at, content])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn metadata(&self, id: Uuid) -> StoreResult<Option<Attachment>> {
        let result = self.connection.query_row(
            "SELECT room_id,user_id,name,length(content),media_type,created_at FROM attachment WHERE id=?1", [id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?, row.get::<_, String>(4)?, row.get::<_, u64>(5)?))).optional()?;
        result
            .map(|(room_id, user_id, name, size, media_type, created_at)| {
                Ok(Attachment {
                    id,
                    room_id,
                    user_id: Uuid::parse_str(&user_id)?,
                    name,
                    size,
                    media_type,
                    created_at,
                })
            })
            .transpose()
    }

    pub fn content(&self, id: Uuid) -> StoreResult<Option<Vec<u8>>> {
        Ok(self
            .connection
            .query_row(
                "SELECT content FROM attachment WHERE id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn readable(&self, id: Uuid, user_id: Uuid) -> StoreResult<bool> {
        Ok(self
            .connection
            .query_row(
                "SELECT committed=1 OR user_id=?2 FROM attachment WHERE id=?1",
                params![id.to_string(), user_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }

    pub fn delete(&mut self, id: Uuid) -> StoreResult<()> {
        self.connection
            .execute("DELETE FROM attachment WHERE id=?1", [id.to_string()])?;
        Ok(())
    }

    pub fn discard_draft(&mut self, id: Uuid) -> StoreResult<bool> {
        Ok(self.connection.execute(
            "DELETE FROM attachment WHERE id=?1 AND committed=0",
            [id.to_string()],
        )? == 1)
    }

    pub fn validate(&self, room_id: &str, user_id: Uuid, ids: &[Uuid]) -> StoreResult<()> {
        for id in ids {
            let attachment = self.metadata(*id)?.ok_or("attachment_unavailable")?;
            if attachment.room_id != room_id || attachment.user_id != user_id {
                return Err("attachment_unavailable".into());
            }
        }
        Ok(())
    }
}

/// Only recognized raster formats receive image MIME types. Everything else is
/// downloaded as bytes, regardless of a supplied extension or Content-Type.
pub fn media_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn attachment(id: Uuid) -> Attachment {
        Attachment {
            id,
            room_id: "living".into(),
            user_id: Uuid::new_v4(),
            name: "picture.svg".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            created_at: 1,
        }
    }

    #[test]
    fn checkpoint_reopens_without_live_state_and_attachments_follow_history_retention() {
        let path = std::env::temp_dir().join(format!("piik-storage-{}.sqlite", Uuid::new_v4()));
        let id = Uuid::new_v4();
        let file = attachment(id);
        {
            let mut store = Storage::open(&path, Limits::default()).unwrap();
            store.put(&file, b"abc", 1).unwrap();
            store
                .save(
                    &json!({"channelId":"same", "history":["saved"]}),
                    &BTreeSet::from([id]),
                    2,
                )
                .unwrap();
        }
        {
            let mut store = Storage::open(&path, Limits::default()).unwrap();
            assert_eq!(store.load().unwrap().unwrap()["channelId"], "same");
            assert_eq!(store.content(id).unwrap().unwrap(), b"abc");
            assert!(store.validate("other-room", file.user_id, &[id]).is_err());
            store
                .save(&json!({"history":[]}), &BTreeSet::new(), 3)
                .unwrap();
            assert!(store.metadata(id).unwrap().is_none());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_commit_does_not_replace_checkpoint_and_pending_uploads_expire() {
        let mut store = Storage::open(Path::new(":memory:"), Limits::default()).unwrap();
        store
            .save(&json!({"saved":1}), &BTreeSet::new(), 0)
            .unwrap();
        store.connection.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
        assert!(store
            .save(&json!({"saved":2}), &BTreeSet::new(), 1)
            .is_err());
        assert_eq!(store.load().unwrap().unwrap()["saved"], 1);
        let first = attachment(Uuid::new_v4());
        store.put(&first, b"abc", 1).unwrap();
        let second = attachment(Uuid::new_v4());
        store.put(&second, b"abc", PENDING_LIFETIME_MS + 2).unwrap();
        assert!(store.metadata(first.id).unwrap().is_none());
    }

    #[test]
    fn only_raster_signatures_are_previewable() {
        assert_eq!(
            media_type(b"<svg xmlns='http://www.w3.org/2000/svg'>"),
            "application/octet-stream"
        );
        assert_eq!(media_type(b"<html>hello"), "application/octet-stream");
        assert_eq!(media_type(b"\x89PNG\r\n\x1a\ncontent"), "image/png");
        assert_eq!(media_type(b"RIFFabcdWEBPcontent"), "image/webp");
    }

    #[test]
    fn quota_failure_keeps_existing_content_and_delete_releases_capacity() {
        let limits = Limits {
            max_file_bytes: 4,
            total_bytes: 5,
            max_stored_files: 2,
        };
        let mut store = Storage::open(Path::new(":memory:"), limits).unwrap();
        let first = attachment(Uuid::new_v4());
        let second = attachment(Uuid::new_v4());
        store.put(&first, b"abc", 1).unwrap();
        assert!(store.put(&second, b"abc", 1).is_err());
        assert_eq!(store.content(first.id).unwrap().unwrap(), b"abc");
        store.delete(first.id).unwrap();
        store.put(&second, b"abc", 1).unwrap();
        assert_eq!(store.metadata(second.id).unwrap().unwrap().size, 3);
    }
}
