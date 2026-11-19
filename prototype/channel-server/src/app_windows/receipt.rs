use rusqlite::{params, Connection};
use std::{
    fs,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_DEVICE_RECEIPTS: i64 = 4096;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

pub(crate) struct ReceiptBook(PathBuf);
impl ReceiptBook {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self(directory)
    }
    fn db(&self) -> PathBuf {
        self.0.join("download-receipts.sqlite")
    }
    pub(super) fn remember(&self, origin: &str, path: &Path) -> Option<Uuid> {
        let (created, modified, size) = stamp(path)?;
        fs::create_dir_all(&self.0).ok()?;
        let mut db = Connection::open(self.db()).ok()?;
        let tx = db.transaction().ok()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS receipts (
                token TEXT PRIMARY KEY, origin TEXT, path TEXT,
                created INTEGER, modified INTEGER, size INTEGER
            )",
        )
        .ok()?;
        let token = Uuid::new_v4();
        tx.execute(
            "INSERT INTO receipts(token, origin, path, created, modified, size)
             VALUES(?, ?, ?, ?, ?, ?)",
            params![
                token.to_string(),
                origin,
                path.to_str()?,
                created,
                modified,
                size
            ],
        )
        .ok()?;
        tx.execute(
            "DELETE FROM receipts WHERE rowid <=
             (SELECT rowid FROM receipts ORDER BY rowid DESC LIMIT 1 OFFSET ?)",
            [MAX_DEVICE_RECEIPTS],
        )
        .ok()?;
        tx.commit().ok()?;
        Some(token)
    }
    pub(crate) fn resolve(&self, origin: &str, token: Uuid) -> Option<PathBuf> {
        let db = Connection::open_with_flags(self.db(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
        let (path, created, modified, size): (String, i64, i64, i64) = db
            .query_row(
                "SELECT path, created, modified, size FROM receipts WHERE token = ? AND origin = ?",
                params![token.to_string(), origin],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok()?;
        let path = PathBuf::from(path);
        (stamp(&path)? == (created, modified, size)).then_some(path)
    }
}
fn stamp(path: &Path) -> Option<(i64, i64, i64)> {
    if !path.is_absolute() {
        return None;
    }
    let m = fs::symlink_metadata(path).ok()?;
    (m.is_file() && m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0).then(|| {
        (
            m.creation_time() as i64,
            m.last_write_time() as i64,
            m.file_size() as i64,
        )
    })
}
