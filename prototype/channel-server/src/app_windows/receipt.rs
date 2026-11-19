use rusqlite::{params, Connection};
use std::{
    fs,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};
use uuid::Uuid;
use windows::Win32::{
    Foundation::HANDLE,
    Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
    },
};

const MAX_DEVICE_RECEIPTS: i64 = 4096;
const RECEIPT_SCHEMA: i64 = 1;

fn schema(db: &Connection) -> Option<i64> {
    db.pragma_query_value(None, "user_version", |row| row.get(0))
        .ok()
}

pub(crate) struct ReceiptBook(PathBuf);
impl ReceiptBook {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self(directory)
    }
    fn db(&self) -> PathBuf {
        self.0.join("download-receipts.sqlite")
    }
    pub(super) fn remember(&self, origin: &str, path: &Path) -> Option<Uuid> {
        let (created, modified, size, identity) = stamp(path)?;
        fs::create_dir_all(&self.0).ok()?;
        let mut db = Connection::open(self.db()).ok()?;
        let tx = db.transaction().ok()?;
        let version = schema(&tx)?;
        if version == 0 {
            // Existing rows have no file ID. They expire through the usual lookup.
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='receipts')",
                [], |row| row.get(0),
            ).ok()?;
            if exists {
                tx.execute_batch("ALTER TABLE receipts ADD COLUMN identity BLOB")
                    .ok()?;
            } else {
                tx.execute_batch(
                    "CREATE TABLE receipts (
                       token TEXT PRIMARY KEY, origin TEXT, path TEXT, created INTEGER,
                       modified INTEGER, size INTEGER, identity BLOB)",
                )
                .ok()?;
            }
            tx.pragma_update(None, "user_version", RECEIPT_SCHEMA)
                .ok()?;
        } else if version != RECEIPT_SCHEMA {
            return None;
        }
        let token = Uuid::new_v4();
        tx.execute(
            "INSERT INTO receipts(token, origin, path, created, modified, size, identity)
             VALUES(?, ?, ?, ?, ?, ?, ?)",
            params![
                token.to_string(),
                origin,
                path.to_str()?,
                created,
                modified,
                size,
                identity
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
        if schema(&db)? != RECEIPT_SCHEMA {
            return None;
        }
        let (path, created, modified, size, identity): (String, i64, i64, i64, Vec<u8>) = db
            .query_row(
                "SELECT path, created, modified, size, identity FROM receipts WHERE token = ? AND origin = ?",
                params![token.to_string(), origin],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok()?;
        let path = PathBuf::from(path);
        (stamp(&path)? == (created, modified, size, identity)).then_some(path)
    }
}
fn stamp(path: &Path) -> Option<(i64, i64, i64, Vec<u8>)> {
    if !path.is_absolute() {
        return None;
    }
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .ok()?;
    let m = file.metadata().ok()?;
    if !m.is_file() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return None;
    }
    let mut info = FILE_ID_INFO::default();
    // The handle remains open while Windows fills the complete FILE_ID_INFO structure.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .ok()?;
    if info.FileId.Identifier == [0; 16] {
        return None;
    }
    let identity = [
        info.VolumeSerialNumber.to_le_bytes().as_slice(),
        info.FileId.Identifier.as_slice(),
    ]
    .concat();
    Some((
        m.creation_time() as i64,
        m.last_write_time() as i64,
        m.file_size() as i64,
        identity,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::FileTimesExt;
    #[test]
    fn legacy_receipts_expire_and_future_stores_are_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let book = ReceiptBook::new(dir.path().to_owned());
        let path = dir.path().join("file.txt");
        fs::write(&path, b"synthetic").unwrap();
        let old = Uuid::new_v4();
        let db = Connection::open(book.db()).unwrap();
        db.execute_batch("CREATE TABLE receipts(token TEXT, origin TEXT, path TEXT, created INTEGER, modified INTEGER, size INTEGER)").unwrap();
        db.execute(
            "INSERT INTO receipts(token,origin,path) VALUES(?,?,?)",
            params![
                old.to_string(),
                "https://test.invalid",
                path.to_str().unwrap()
            ],
        )
        .unwrap();
        assert!(book.resolve("https://test.invalid", old).is_none());
        let fresh = book.remember("https://test.invalid", &path).unwrap();
        assert_eq!(
            book.resolve("https://test.invalid", fresh),
            Some(path.clone())
        );
        assert!(book.resolve("https://test.invalid", old).is_none());
        db.pragma_update(None, "user_version", 2).unwrap();
        drop(db);
        let before = fs::read(book.db()).unwrap();
        assert!(book.resolve("https://test.invalid", fresh).is_none());
        assert!(book.remember("https://test.invalid", &path).is_none());
        assert_eq!(fs::read(book.db()).unwrap(), before);
    }
    #[test]
    fn replace_file_preserving_metadata_invalidates_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("download.txt");
        let replacement = dir.path().join("replacement.txt");
        fs::write(&path, b"first").unwrap();
        fs::write(&replacement, b"other").unwrap();
        let before = fs::metadata(&path).unwrap();
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap();
        file.set_times(
            fs::FileTimes::new()
                .set_created(before.created().unwrap())
                .set_modified(before.modified().unwrap()),
        )
        .unwrap();
        drop(file);
        let book = ReceiptBook::new(dir.path().join("store"));
        let token = book.remember("https://test.invalid", &path).unwrap();
        unsafe {
            windows::Win32::Storage::FileSystem::ReplaceFileW(
                &windows_core::HSTRING::from(path.as_os_str()),
                &windows_core::HSTRING::from(replacement.as_os_str()),
                None,
                Default::default(),
                None,
                None,
            )
            .unwrap()
        };
        let after = fs::metadata(&path).unwrap();
        assert_eq!(
            (
                before.creation_time(),
                before.last_write_time(),
                before.file_size()
            ),
            (
                after.creation_time(),
                after.last_write_time(),
                after.file_size()
            )
        );
        assert!(book.resolve("https://test.invalid", token).is_none());
    }
}
