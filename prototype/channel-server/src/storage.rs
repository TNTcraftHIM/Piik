//! The local Server experiment's metadata, confirmed room history and attachments.
//! Media sessions and routes never enter this database.
use piik_channel_prototype::{
    history::{AttachmentOwner, ConfirmationInput, HistoryRequest, HistoryResult, HISTORY_PAGE},
    wire::ChatMessage,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
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
             CREATE TABLE IF NOT EXISTS message (
               room_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
               user_id TEXT NOT NULL, nonce TEXT NOT NULL, text TEXT NOT NULL,
               time INTEGER NOT NULL, attachments TEXT NOT NULL,
               PRIMARY KEY(room_id,seq), UNIQUE(room_id,user_id,nonce)
             );
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

    /// This checkpoint contains authority metadata, never confirmed messages.
    pub fn save(&mut self, state: &Value) -> StoreResult<()> {
        let body = serde_json::to_string(state)?;
        self.connection.execute("INSERT INTO checkpoint(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [body])?;
        Ok(())
    }

    /// Resolve one already-authorized operation before publishing its result.
    /// Sequence, retry identity and attachment publication commit together.
    pub fn history(&mut self, request: &HistoryRequest) -> Result<HistoryResult, &'static str> {
        let behavior = match request {
            HistoryRequest::Read { .. } => TransactionBehavior::Deferred,
            HistoryRequest::Send { .. } => TransactionBehavior::Immediate,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(behavior)
            .map_err(|_| "storage_failed")?;
        let result = match request {
            HistoryRequest::Read { room_id, before } => {
                let newest = before
                    .map(|seq| seq.saturating_sub(1))
                    .unwrap_or(u64::MAX)
                    .min(i64::MAX as u64);
                let messages = {
                    let mut query = transaction
                        .prepare(
                            "SELECT seq,id,user_id,text,time,attachments FROM message
                         WHERE room_id=?1 AND seq<=?2
                         ORDER BY seq DESC LIMIT ?3",
                        )
                        .map_err(|_| "storage_failed")?;
                    let rows = query
                        .query_map(params![room_id, newest, HISTORY_PAGE + 1], read_message)
                        .map_err(|_| "storage_failed")?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| "storage_failed")?;
                    rows
                };
                let oldest_seq = transaction
                    .query_row(
                        "SELECT min(seq) FROM message WHERE room_id=?1",
                        [room_id],
                        |row| row.get(0),
                    )
                    .map_err(|_| "storage_failed")?;
                HistoryResult::page(messages, oldest_seq, *before)
            }
            HistoryRequest::Send { room_id, draft } => {
                let previous = transaction
                    .query_row(
                        "SELECT seq,id,user_id,text,time,attachments FROM message
                         WHERE room_id=?1 AND user_id=?2 AND nonce=?3",
                        params![room_id, draft.user_id.to_string(), draft.nonce],
                        read_message,
                    )
                    .optional()
                    .map_err(|_| "storage_failed")?;
                let input = if let Some(message) = previous {
                    ConfirmationInput::Existing { message }
                } else {
                    let mut attachments = Vec::new();
                    for id in &draft.attachments {
                        if let Some(attachment) = transaction
                            .query_row(
                                "SELECT room_id,user_id FROM attachment WHERE id=?1",
                                [id.to_string()],
                                |row| {
                                    Ok(AttachmentOwner {
                                        id: *id,
                                        room_id: row.get(0)?,
                                        user_id: read_uuid(row, 1)?,
                                    })
                                },
                            )
                            .optional()
                            .map_err(|_| "storage_failed")?
                        {
                            attachments.push(attachment);
                        }
                    }
                    // No owner-history deletion exists in this slice. The last
                    // persisted row is the room's order, independent of other rooms.
                    let last_seq = transaction
                        .query_row(
                            "SELECT coalesce(max(seq),0) FROM message WHERE room_id=?1",
                            [room_id],
                            |row| row.get(0),
                        )
                        .map_err(|_| "storage_failed")?;
                    ConfirmationInput::New {
                        last_seq,
                        attachments,
                    }
                };
                let confirmation = draft.prepare_confirmation(room_id, input)?;
                if confirmation.inserted {
                    let message = &confirmation.message;
                    for id in &message.attachments {
                        transaction
                            .execute(
                                "UPDATE attachment SET committed=1 WHERE id=?1",
                                [id.to_string()],
                            )
                            .map_err(|_| "storage_failed")?;
                    }
                    let attachments = serde_json::to_string(&message.attachments)
                        .map_err(|_| "storage_failed")?;
                    transaction.execute(
                        "INSERT INTO message(room_id,seq,id,user_id,nonce,text,time,attachments)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![room_id, message.seq, message.id.to_string(),
                            message.user_id.to_string(), draft.nonce, message.text,
                            message.time, attachments],
                    ).map_err(|_| "storage_failed")?;
                }
                HistoryResult::Sent(confirmation)
            }
        };
        transaction.commit().map_err(|_| "storage_failed")?;
        Ok(result)
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
}

fn read_uuid(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    use rusqlite::types::Type;
    let text: String = row.get(index)?;
    Uuid::parse_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn read_message(row: &Row<'_>) -> rusqlite::Result<ChatMessage> {
    use rusqlite::types::Type;
    let attachments: String = row.get(5)?;
    let attachments = serde_json::from_str(&attachments).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, Type::Text, Box::new(error))
    })?;
    Ok(ChatMessage {
        seq: row.get(0)?,
        id: read_uuid(row, 1)?,
        user_id: read_uuid(row, 2)?,
        text: row.get(3)?,
        time: row.get(4)?,
        attachments,
    })
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
    use piik_channel_prototype::history::MessageDraft;
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

    fn copy_draft(draft: &MessageDraft) -> MessageDraft {
        MessageDraft {
            user_id: draft.user_id,
            nonce: draft.nonce.clone(),
            text: draft.text.clone(),
            attachments: draft.attachments.clone(),
            time: draft.time,
        }
    }

    fn confirmed(store: &mut Storage, room: &str, draft: &MessageDraft) -> (ChatMessage, bool) {
        match store
            .history(&HistoryRequest::Send {
                room_id: room.into(),
                draft: copy_draft(draft),
            })
            .unwrap()
        {
            HistoryResult::Sent(confirmation) => (confirmation.message, confirmation.inserted),
            _ => panic!("send returned a history page"),
        }
    }

    fn page(
        store: &mut Storage,
        room: &str,
        before: Option<u64>,
    ) -> (Vec<ChatMessage>, bool, Option<u64>) {
        match store
            .history(&HistoryRequest::Read {
                room_id: room.into(),
                before,
            })
            .unwrap()
        {
            HistoryResult::Page {
                messages,
                has_more,
                oldest_seq,
                before: cursor,
            } => {
                assert_eq!(cursor, before);
                (messages, has_more, oldest_seq)
            }
            _ => panic!("read returned a message confirmation"),
        }
    }

    #[test]
    fn room_order_and_original_confirmation_survive_restart_and_removed_bytes() {
        let path = std::env::temp_dir().join(format!("piik-storage-{}.sqlite", Uuid::new_v4()));
        let id = Uuid::new_v4();
        let file = attachment(id);
        let mut draft = MessageDraft {
            user_id: file.user_id,
            nonce: "same-send".into(),
            text: "original".into(),
            attachments: vec![id],
            time: 2,
        };
        let original;
        {
            let mut store = Storage::open(&path, Limits::default()).unwrap();
            store.put(&file, b"abc", 1).unwrap();
            store.save(&json!({"channelId":"same"})).unwrap();
            let (message, inserted) = confirmed(&mut store, "living", &draft);
            assert!(inserted);
            assert_eq!(message.seq, 1);
            original = serde_json::to_value(&message).unwrap();
            let other_room = MessageDraft {
                text: "quiet".into(),
                attachments: vec![],
                ..copy_draft(&draft)
            };
            assert_eq!(confirmed(&mut store, "quiet", &other_room).0.seq, 1);
            let other_author = MessageDraft {
                user_id: Uuid::new_v4(),
                ..other_room
            };
            assert_eq!(confirmed(&mut store, "living", &other_author).0.seq, 2);
            // Metadata saves cannot reclaim another room's confirmed content.
            store
                .save(&json!({"channelId":"same", "name":"changed"}))
                .unwrap();
            assert_eq!(store.content(id).unwrap().unwrap(), b"abc");
            store.delete(id).unwrap();
            draft.text = "different retry payload".into();
            draft.attachments = vec![Uuid::new_v4()];
            draft.time = 999;
            let (retried, inserted) = confirmed(&mut store, "living", &draft);
            assert!(!inserted);
            assert_eq!(serde_json::to_value(retried).unwrap(), original);
        }
        {
            let mut store = Storage::open(&path, Limits::default()).unwrap();
            assert_eq!(store.load().unwrap().unwrap()["channelId"], "same");
            assert!(store.metadata(id).unwrap().is_none());
            let (retried, inserted) = confirmed(&mut store, "living", &draft);
            assert!(!inserted);
            assert_eq!(serde_json::to_value(retried).unwrap(), original);
            let (messages, more, oldest) = page(&mut store, "living", None);
            assert_eq!(messages.len(), 2);
            assert!(!more);
            assert_eq!(oldest, Some(1));
            draft.nonce = "next-send".into();
            draft.attachments.clear();
            assert_eq!(confirmed(&mut store, "living", &draft).0.seq, 3);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_commit_does_not_replace_checkpoint_and_pending_uploads_expire() {
        let mut store = Storage::open(Path::new(":memory:"), Limits::default()).unwrap();
        store.save(&json!({"saved":1})).unwrap();
        store.connection.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
        assert!(store.save(&json!({"saved":2})).is_err());
        assert_eq!(store.load().unwrap().unwrap()["saved"], 1);
        let first = attachment(Uuid::new_v4());
        store.put(&first, b"abc", 1).unwrap();
        let second = attachment(Uuid::new_v4());
        store.put(&second, b"abc", PENDING_LIFETIME_MS + 2).unwrap();
        assert!(store.metadata(first.id).unwrap().is_none());
    }

    #[test]
    fn confirmed_history_exceeds_one_thousand_and_reads_bounded_room_pages() {
        let mut store = Storage::open(Path::new(":memory:"), Limits::default()).unwrap();
        let user_id = Uuid::new_v4();
        for seq in 1..=1010 {
            let draft = MessageDraft {
                user_id,
                nonce: format!("send-{seq}"),
                text: format!("retained-{seq}"),
                attachments: vec![],
                time: seq,
            };
            assert_eq!(confirmed(&mut store, "living", &draft).0.seq, seq);
        }
        let (latest, more, oldest) = page(&mut store, "living", None);
        assert_eq!((latest.len(), more, oldest), (100, true, Some(1)));
        assert_eq!((latest[0].seq, latest[99].seq), (911, 1010));
        let (older, more, oldest) = page(&mut store, "living", Some(11));
        assert_eq!((older.len(), more, oldest), (10, false, Some(1)));
        assert_eq!((older[0].seq, older[9].seq), (1, 10));
        let (empty, more, oldest) = page(&mut store, "living", Some(1));
        assert!(empty.is_empty());
        assert!(!more);
        assert_eq!(oldest, Some(1));
        let (empty, more, oldest) = page(&mut store, "other-room", None);
        assert!(empty.is_empty());
        assert!(!more);
        assert_eq!(oldest, None);
    }

    #[test]
    fn failed_commit_preserves_previous_history_order_and_unpublished_attachment() {
        let mut store = Storage::open(Path::new(":memory:"), Limits::default()).unwrap();
        let file = attachment(Uuid::new_v4());
        let mut draft = MessageDraft {
            user_id: file.user_id,
            nonce: "first".into(),
            text: "saved".into(),
            attachments: vec![],
            time: 1,
        };
        let original = serde_json::to_value(confirmed(&mut store, "living", &draft).0).unwrap();
        store.put(&file, b"abc", 1).unwrap();
        // The INSERT and attachment UPDATE succeed. The deferred constraint
        // fails COMMIT itself, exercising the whole transaction's rollback.
        store.connection.execute_batch(
            "CREATE TABLE commit_failure (id TEXT REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TRIGGER reject_message AFTER INSERT ON message
             BEGIN INSERT INTO commit_failure VALUES('missing-message'); END;",
        ).unwrap();
        draft.nonce = "retry-after-failure".into();
        draft.attachments = vec![file.id];
        assert!(matches!(
            store.history(&HistoryRequest::Send {
                room_id: "living".into(),
                draft: copy_draft(&draft),
            }),
            Err("storage_failed")
        ));
        assert!(store.connection.is_autocommit());
        let (retained, _, _) = page(&mut store, "living", None);
        assert_eq!(retained.len(), 1);
        assert_eq!(serde_json::to_value(&retained[0]).unwrap(), original);
        assert!(!store.readable(file.id, Uuid::new_v4()).unwrap());
        store
            .connection
            .execute_batch("DROP TRIGGER reject_message")
            .unwrap();
        let (retried, inserted) = confirmed(&mut store, "living", &draft);
        assert!(inserted);
        assert_eq!(retried.seq, 2);
        assert!(store.readable(file.id, Uuid::new_v4()).unwrap());
    }

    #[test]
    fn unavailable_attachment_rolls_back_other_attachment_publication() {
        let mut store = Storage::open(Path::new(":memory:"), Limits::default()).unwrap();
        let file = attachment(Uuid::new_v4());
        store.put(&file, b"abc", 1).unwrap();
        let mut other = attachment(Uuid::new_v4());
        other.user_id = file.user_id;
        other.room_id = "quiet".into();
        store.put(&other, b"abc", 1).unwrap();
        let mut draft = MessageDraft {
            user_id: file.user_id,
            nonce: "send".into(),
            text: String::new(),
            attachments: vec![file.id, other.id],
            time: 1,
        };
        assert!(matches!(
            store.history(&HistoryRequest::Send {
                room_id: "living".into(),
                draft: copy_draft(&draft),
            }),
            Err("attachment_unavailable")
        ));
        assert!(!store.readable(file.id, Uuid::new_v4()).unwrap());
        assert!(page(&mut store, "living", None).0.is_empty());
        draft.attachments = vec![file.id];
        assert_eq!(confirmed(&mut store, "living", &draft).0.seq, 1);
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
