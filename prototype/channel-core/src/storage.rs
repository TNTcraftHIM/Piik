//! The local Server experiment's metadata and confirmed room history.
//! Media sessions and routes never enter this database.
use crate::{
    backup::{HistoryImport, HistoryRow},
    history::{ConfirmationInput, HistoryRequest, HistoryResult, StoredMessage, HISTORY_PAGE},
    wire::ChatMessage,
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

pub type StoreResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub struct Storage {
    connection: Connection,
}
impl Storage {
    pub fn open(path: &Path) -> StoreResult<Self> {
        let connection = Connection::open(path)?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let existing: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('checkpoint','message','attachment'))", [], |row| row.get(0))?;
        if version != 3 && (version != 0 || existing) {
            return Err("unsupported_storage_version".into());
        }
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS message (
               room_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
               user_id TEXT NOT NULL, nonce TEXT NOT NULL, text TEXT NOT NULL,
               time INTEGER NOT NULL, attachments TEXT NOT NULL, reactions TEXT NOT NULL,
               PRIMARY KEY(room_id,seq), UNIQUE(room_id,user_id,nonce)
             );
             PRAGMA user_version=3;",
        )?;
        Ok(Self { connection })
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

    /// Freeze this database with SQLite's online backup API. The caller owns the
    /// disposable destination and keeps it until its streaming reader finishes.
    pub fn snapshot(&self, path: &Path) -> StoreResult<Self> {
        let mut snapshot = Self::create_staging(path)?;
        snapshot.replace_from(self)?;
        Ok(snapshot)
    }

    pub(crate) fn create_staging(path: &Path) -> StoreResult<Self> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        Self::open(path)
    }

    /// The owner pauses its writer for this call. SQLite commits the replacement
    /// atomically; a failed copy leaves the previous database intact.
    pub(crate) fn replace_from(&mut self, snapshot: &Self) -> StoreResult<()> {
        let copy = rusqlite::backup::Backup::new(&snapshot.connection, &mut self.connection)?;
        match copy.step(-1)? {
            rusqlite::backup::StepResult::Done => Ok(()),
            _ => Err("storage_busy".into()),
        }
    }

    pub(crate) fn for_each_history_row(
        &self,
        room_id: &str,
        mut visit: impl FnMut(HistoryRow) -> StoreResult<()>,
    ) -> StoreResult<()> {
        let mut statement = self.connection.prepare(
            "SELECT seq,id,user_id,text,time,attachments,reactions,nonce FROM message
             WHERE room_id=?1 ORDER BY seq",
        )?;
        let rows = statement.query_map([room_id], |row| {
            Ok(HistoryRow {
                message: read_message(row)?,
                nonce: row.get(7)?,
            })
        })?;
        for row in rows {
            visit(row?)?;
        }
        Ok(())
    }

    pub(crate) fn stage_room(
        &mut self,
        policy: &crate::RoomState,
        rows: impl IntoIterator<Item = StoreResult<HistoryRow>>,
        mut import: HistoryImport,
    ) -> StoreResult<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO checkpoint(id,body) VALUES(1,?1)",
            [serde_json::to_string(policy)?],
        )?;
        for row in rows {
            let row = row?;
            import.accept(&row)?;
            let message = row.message.message;
            transaction.execute(
                "INSERT INTO message(room_id,seq,id,user_id,nonce,text,time,attachments,reactions)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    policy.id,
                    message.seq,
                    message.id.to_string(),
                    message.user_id.to_string(),
                    row.nonce,
                    message.text,
                    message.time,
                    serde_json::to_string(&message.attachments)?,
                    serde_json::to_string(&row.message.reactions)?,
                ],
            )?;
        }
        import.finish()?;
        transaction.commit()?;
        Ok(())
    }

    /// Resolve one already-authorized operation before publishing its result.
    /// Sequence, retry identity and embedded descriptions commit together.
    pub fn history(&mut self, request: &HistoryRequest) -> Result<HistoryResult, &'static str> {
        let behavior = match request {
            HistoryRequest::Read { .. } | HistoryRequest::Attachment { .. } => {
                TransactionBehavior::Deferred
            }
            HistoryRequest::Send { .. } | HistoryRequest::SetReaction { .. } => {
                TransactionBehavior::Immediate
            }
        };
        let transaction = self
            .connection
            .transaction_with_behavior(behavior)
            .map_err(|_| "storage_failed")?;
        let result = match request {
            HistoryRequest::SetReaction {
                room_id,
                message_seq,
                ..
            } => {
                let message = transaction.query_row(
                    "SELECT seq,id,user_id,text,time,attachments,reactions FROM message WHERE room_id=?1 AND seq=?2",
                    params![room_id, message_seq], read_message).optional().map_err(|_| "storage_failed")?;
                let confirmation = request.reaction_result(message)?;
                if confirmation.changed {
                    let reactions = serde_json::to_string(&confirmation.snapshot.reactions)
                        .map_err(|_| "storage_failed")?;
                    transaction
                        .execute(
                            "UPDATE message SET reactions=?3 WHERE room_id=?1 AND seq=?2",
                            params![room_id, message_seq, reactions],
                        )
                        .map_err(|_| "storage_failed")?;
                }
                HistoryResult::Reacted(confirmation)
            }
            HistoryRequest::Attachment {
                room_id,
                message_seq,
                ..
            } => {
                let message = transaction.query_row(
                    "SELECT seq,id,user_id,text,time,attachments,reactions FROM message WHERE room_id=?1 AND seq=?2",
                    params![room_id, message_seq], read_message).optional().map_err(|_| "storage_failed")?
                    ;
                request.attachment_result(message)?
            }
            HistoryRequest::Read { room_id, before } => {
                let newest = before
                    .map(|seq| seq.saturating_sub(1))
                    .unwrap_or(u64::MAX)
                    .min(i64::MAX as u64);
                let messages = {
                    let mut query = transaction
                        .prepare(
                            "SELECT seq,id,user_id,text,time,attachments,reactions FROM message
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
                        "SELECT seq,id,user_id,text,time,attachments,reactions FROM message
                         WHERE room_id=?1 AND user_id=?2 AND nonce=?3",
                        params![room_id, draft.user_id.to_string(), draft.nonce],
                        read_message,
                    )
                    .optional()
                    .map_err(|_| "storage_failed")?;
                let input = if let Some(message) = previous {
                    ConfirmationInput::Existing { message }
                } else {
                    // No owner-history deletion exists in this slice. The last
                    // persisted row is the room's order, independent of other rooms.
                    let last_seq = transaction
                        .query_row(
                            "SELECT coalesce(max(seq),0) FROM message WHERE room_id=?1",
                            [room_id],
                            |row| row.get(0),
                        )
                        .map_err(|_| "storage_failed")?;
                    ConfirmationInput::New { last_seq }
                };
                let confirmation = draft.prepare_confirmation(input)?;
                if confirmation.inserted {
                    let message = &confirmation.message.message;
                    let attachments = serde_json::to_string(&message.attachments)
                        .map_err(|_| "storage_failed")?;
                    let reactions = serde_json::to_string(&confirmation.message.reactions)
                        .map_err(|_| "storage_failed")?;
                    transaction.execute(
                        "INSERT INTO message(room_id,seq,id,user_id,nonce,text,time,attachments,reactions)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                        params![room_id, message.seq, message.id.to_string(),
                            message.user_id.to_string(), draft.nonce, message.text,
                            message.time, attachments, reactions],
                    ).map_err(|_| "storage_failed")?;
                }
                HistoryResult::Sent(confirmation)
            }
        };
        transaction.commit().map_err(|_| "storage_failed")?;
        Ok(result)
    }
}

fn read_uuid(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    use rusqlite::types::Type;
    let text: String = row.get(index)?;
    Uuid::parse_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn read_message(row: &Row<'_>) -> rusqlite::Result<StoredMessage> {
    use rusqlite::types::Type;
    let attachments: String = row.get(5)?;
    let attachments = serde_json::from_str(&attachments).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, Type::Text, Box::new(error))
    })?;
    let reactions: String = row.get(6)?;
    let reactions = serde_json::from_str(&reactions).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, Type::Text, Box::new(error))
    })?;
    Ok(StoredMessage {
        message: ChatMessage {
            seq: row.get(0)?,
            id: read_uuid(row, 1)?,
            user_id: read_uuid(row, 2)?,
            text: row.get(3)?,
            time: row.get(4)?,
            attachments,
        },
        reactions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::MessageDraft;
    fn attachment() -> crate::AttachmentDescriptor {
        crate::AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: crate::attachment::sha256_hex(b"abc"),
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
            HistoryResult::Sent(confirmation) => {
                (confirmation.message.message, confirmation.inserted)
            }
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
                (
                    messages
                        .into_iter()
                        .map(|message| message.message)
                        .collect(),
                    has_more,
                    oldest_seq,
                )
            }
            _ => panic!("read returned a message confirmation"),
        }
    }

    #[test]
    fn original_descriptions_and_nonce_survive_restart() {
        let path = std::env::temp_dir().join(format!("piik-storage-{}.sqlite", Uuid::new_v4()));
        let file = attachment();
        let mut draft = MessageDraft::new(
            Uuid::new_v4(),
            "same-send".into(),
            "original".into(),
            vec![file.clone()],
            2,
        )
        .unwrap();
        let original;
        {
            let mut store = Storage::open(&path).unwrap();
            let (message, inserted) = confirmed(&mut store, "living", &draft);
            assert!(inserted);
            original = serde_json::to_value(&message).unwrap();
            assert_eq!(message.attachments, vec![file]);
            draft.text = "changed retry".into();
            draft.attachments[0].sha256 = crate::attachment::sha256_hex(b"different");
            assert_eq!(
                serde_json::to_value(confirmed(&mut store, "living", &draft).0).unwrap(),
                original
            );
        }
        {
            let mut store = Storage::open(&path).unwrap();
            let (retried, inserted) = confirmed(&mut store, "living", &draft);
            assert!(!inserted);
            assert_eq!(serde_json::to_value(retried).unwrap(), original);
            assert_eq!(page(&mut store, "living", None).0.len(), 1);
            draft.nonce = "next-send".into();
            assert_eq!(confirmed(&mut store, "living", &draft).0.seq, 2);
            assert_eq!(confirmed(&mut store, "other", &draft).0.seq, 1);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn old_private_store_is_rejected_without_discarding_records() {
        let path = std::env::temp_dir().join(format!("piik-old-storage-{}.sqlite", Uuid::new_v4()));
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE message(body TEXT); INSERT INTO message VALUES('old'); PRAGMA user_version=2;",
                )
                .unwrap();
        }
        assert!(Storage::open(&path)
            .err()
            .unwrap()
            .to_string()
            .contains("unsupported_storage_version"));
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("SELECT body FROM message", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "old"
        );
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn confirmed_history_exceeds_one_thousand_and_reads_bounded_room_pages() {
        let mut store = Storage::open(Path::new(":memory:")).unwrap();
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
        assert_eq!((latest.len(), more, oldest), (HISTORY_PAGE, true, Some(1)));
        assert_eq!(
            (latest[0].seq, latest[HISTORY_PAGE - 1].seq),
            (1011 - HISTORY_PAGE as u64, 1010)
        );
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
    fn failed_commit_preserves_history_order_and_descriptions() {
        let mut store = Storage::open(Path::new(":memory:")).unwrap();
        let file = attachment();
        let mut draft = MessageDraft {
            user_id: Uuid::new_v4(),
            nonce: "first".into(),
            text: "saved".into(),
            attachments: vec![],
            time: 1,
        };
        let original = serde_json::to_value(confirmed(&mut store, "living", &draft).0).unwrap();
        // The INSERT succeeds. The deferred constraint
        // fails COMMIT itself, exercising the whole transaction's rollback.
        store.connection.execute_batch(
            "CREATE TABLE commit_failure (id TEXT REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TRIGGER reject_message AFTER INSERT ON message
             BEGIN INSERT INTO commit_failure VALUES('missing-message'); END;",
        ).unwrap();
        draft.nonce = "retry-after-failure".into();
        draft.attachments = vec![file.clone()];
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
        store
            .connection
            .execute_batch("DROP TRIGGER reject_message")
            .unwrap();
        let (retried, inserted) = confirmed(&mut store, "living", &draft);
        assert!(inserted);
        assert_eq!(retried.seq, 2);
        assert_eq!(retried.attachments, vec![file]);
    }
}
