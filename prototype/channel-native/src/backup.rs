//! Portable archives at the native storage boundary. The caller owns staging
//! paths and commits a validated result through its existing Domain/Room turn.
use anyhow::{bail, Result};
use piik_channel_core::{
    attachment::AttachmentHash,
    backup::{DomainMetadata, HistoryImport, HistoryRow, Metadata, RetainedFile, RECORD_BYTES},
    storage::StoreResult,
    AttachmentDescriptor, RoomBackup,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufRead, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "manifest.json";
const HISTORY: &str = "history.ndjson";

/// The SQLite handle closes before its disposable directory is removed, even
/// when an HTTP caller disappears while the owning actor consumes the snapshot.
pub struct RoomSnapshot {
    pub room: RoomBackup,
    pub directory: tempfile::TempDir,
}

pub enum StagedBackup {
    Domain(DomainMetadata),
    Room {
        snapshot: RoomBackup,
        /// One verified file per digest. Message identities remain in metadata.
        content: BTreeMap<String, PathBuf>,
    },
}

/// STORE keeps Piik's native and Browser writers interoperable without a
/// compression engine. The output can be a file or a bounded HTTP stream.
pub fn write_domain(metadata: &DomainMetadata, output: impl Write) -> Result<()> {
    metadata.validate().map_err(anyhow::Error::msg)?;
    let mut zip = ZipWriter::new_stream(output);
    zip.start_file(MANIFEST, options())?;
    zip.write_all(&record(&Metadata::Domain(metadata.clone()))?)?;
    zip.finish()?;
    Ok(())
}

/// Inventory comes from readable retained copies, never from descriptions alone.
/// The opener is called once per digest; its bytes must match the confirmed row.
pub fn write_room<R: Read>(
    snapshot: &RoomBackup,
    inventory: &[RetainedFile],
    output: impl Write,
    mut open: impl FnMut(&RetainedFile) -> Result<R>,
) -> Result<()> {
    let mut metadata = snapshot.metadata().clone();
    metadata.retained_files = inventory.to_vec();
    let mut import = HistoryImport::new(&metadata).map_err(anyhow::Error::msg)?;
    let mut zip = ZipWriter::new_stream(output);
    zip.start_file(MANIFEST, options())?;
    zip.write_all(&record(&Metadata::Room(metadata))?)?;
    zip.start_file(HISTORY, options().large_file(true))?;
    snapshot
        .for_each_row(|row| {
            import.accept(&row)?;
            zip.write_all(&record(&row).map_err(anyhow::Error::into_boxed_dyn_error)?)?;
            zip.write_all(b"\n")?;
            Ok(())
        })
        .map_err(anyhow::Error::from_boxed)?;
    import.finish().map_err(anyhow::Error::msg)?;
    let mut written = BTreeSet::new();
    for file in inventory {
        let hash = file.attachment.sha256.to_ascii_lowercase();
        if written.insert(hash.clone()) {
            zip.start_file(format!("content/{hash}"), options())?;
            copy_verified(open(file)?, &mut zip, &file.attachment)?;
        }
    }
    zip.finish()?;
    Ok(())
}

/// Read into an empty caller-owned directory. An error leaves only disposable
/// staging files; no live writer or authority is touched here.
pub fn stage(input: impl Read + Seek, directory: &Path) -> Result<StagedBackup> {
    let mut zip = ZipArchive::new(input)?;
    if zip.has_duplicate_names() {
        bail!("invalid_backup_entries");
    }
    let metadata: Metadata = serde_json::from_slice(&read_record(zip.by_name(MANIFEST)?)?)?;
    metadata.validate().map_err(anyhow::Error::msg)?;
    let mut expected = BTreeSet::from([MANIFEST.to_owned()]);
    if let Metadata::Room(room) = &metadata {
        expected.insert(HISTORY.into());
        for file in &room.retained_files {
            expected.insert(format!(
                "content/{}",
                file.attachment.sha256.to_ascii_lowercase()
            ));
        }
    }
    if zip.len() != expected.len()
        || zip
            .file_names()
            .any(|name| name.map_or(true, |name| !expected.contains(name.as_ref())))
    {
        bail!("invalid_backup_entries");
    }
    for index in 0..zip.len() {
        let entry = zip.by_index(index)?;
        if !entry.is_file() || entry.compression() != CompressionMethod::Stored {
            bail!("unsupported_backup_entry");
        }
    }
    match metadata {
        Metadata::Domain(domain) => Ok(StagedBackup::Domain(domain)),
        Metadata::Room(room) => {
            let history = BufReader::new(zip.by_name(HISTORY)?);
            let snapshot = RoomBackup::stage(
                &directory.join("room.sqlite"),
                room.clone(),
                history_rows(history),
            )
            .map_err(anyhow::Error::from_boxed)?;
            let mut content = BTreeMap::new();
            for file in &room.retained_files {
                let hash = file.attachment.sha256.to_ascii_lowercase();
                if !content.contains_key(&hash) {
                    let path = directory.join(&hash);
                    let output = File::options().write(true).create_new(true).open(&path)?;
                    copy_verified(
                        zip.by_name(&format!("content/{hash}"))?,
                        output,
                        &file.attachment,
                    )?;
                    content.insert(hash, path);
                }
            }
            Ok(StagedBackup::Room { snapshot, content })
        }
    }
}

fn options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
}

fn record(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > RECORD_BYTES {
        bail!("backup_record_too_large");
    }
    Ok(bytes)
}

fn read_record(input: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input
        .take(RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > RECORD_BYTES {
        bail!("backup_record_too_large");
    }
    Ok(bytes)
}

fn history_rows(mut input: impl BufRead) -> impl Iterator<Item = StoreResult<HistoryRow>> {
    std::iter::from_fn(move || {
        let mut line = Vec::new();
        let result = input
            .by_ref()
            .take(RECORD_BYTES as u64 + 2)
            .read_until(b'\n', &mut line);
        match result {
            Ok(0) => None,
            Err(error) => Some(Err(error.into())),
            Ok(_) => {
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                Some(if line.len() > RECORD_BYTES {
                    Err("backup_record_too_large".into())
                } else {
                    serde_json::from_slice(&line).map_err(Into::into)
                })
            }
        }
    })
}

fn copy_verified(
    mut input: impl Read,
    mut output: impl Write,
    descriptor: &AttachmentDescriptor,
) -> Result<()> {
    let mut hash = AttachmentHash::default();
    let mut size = 0;
    let mut buffer = [0; 8192];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > descriptor.size {
            bail!("backup_content_mismatch");
        }
        hash.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    if size != descriptor.size || !hash.finish().eq_ignore_ascii_case(&descriptor.sha256) {
        bail!("backup_content_mismatch");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use piik_channel_core::{
        attachment::sha256_hex,
        backup::{OwnCredential, RoomMetadata},
        history::{MessageReactions, StoredMessage},
        wire::{ChatMessage, RoomAccess},
        Authority, RoomState,
    };
    use std::io::Cursor;
    use uuid::Uuid;

    fn room() -> (RoomMetadata, Vec<HistoryRow>, Vec<RetainedFile>) {
        let owner = Uuid::new_v4();
        let attachment = AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "retained.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: sha256_hex(b"abc"),
        };
        let rows = (1..=55)
            .map(|seq| HistoryRow {
                nonce: format!("retry-{seq}"),
                message: StoredMessage {
                    message: ChatMessage {
                        seq,
                        id: Uuid::new_v4(),
                        user_id: owner,
                        text: format!("Message {seq}"),
                        time: seq,
                        attachments: if seq == 1 || seq == 55 {
                            vec![attachment.clone()]
                        } else {
                            vec![]
                        },
                    },
                    reactions: MessageReactions {
                        revision: 1,
                        choices: BTreeMap::from([(owner, BTreeSet::from(["wave".into()]))]),
                    },
                },
            })
            .collect();
        let inventory = [1, 55]
            .into_iter()
            .map(|message_seq| RetainedFile {
                message_seq,
                attachment: attachment.clone(),
            })
            .collect();
        let metadata = RoomMetadata {
            version: 1,
            domain_id: Uuid::new_v4(),
            policy: RoomState::new(
                "living".into(),
                "Living".into(),
                Default::default(),
                owner,
                RoomAccess::Private,
                false,
                Some("password".into()),
            )
            .unwrap(),
            own_credential: Some(OwnCredential {
                user_id: owner,
                credential: "own-credential".into(),
            }),
            retained_files: vec![],
        };
        (metadata, rows, inventory)
    }

    fn pack(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        let mut bytes = vec![];
        let mut zip = ZipWriter::new_stream(&mut bytes);
        for (name, data) in entries {
            zip.start_file(name, options()).unwrap();
            zip.write_all(&data).unwrap();
        }
        zip.finish().unwrap();
        bytes
    }

    #[test]
    fn named_room_archive_retains_all_rows_retry_identity_reactions_and_verified_content(
    ) -> Result<()> {
        let folder = std::env::temp_dir().join(format!("piik-room-archive-{}", Uuid::new_v4()));
        std::fs::create_dir(&folder)?;
        let (metadata, rows, inventory) = room();
        let snapshot = RoomBackup::stage(
            &folder.join("source.sqlite"),
            metadata,
            rows.iter().cloned().map(Ok),
        )
        .map_err(anyhow::Error::from_boxed)?;
        let mut bytes = vec![]; // Write-only: no seekable archive buffer is required.
        let mut opens = 0;
        write_room(&snapshot, &inventory, &mut bytes, |_| {
            opens += 1;
            Ok(Cursor::new(b"abc"))
        })?;
        assert_eq!(opens, 1, "identical content is stored once");
        let directory = folder.join("import");
        std::fs::create_dir(&directory)?;
        let StagedBackup::Room {
            snapshot: restored,
            content,
        } = stage(Cursor::new(bytes), &directory)?
        else {
            panic!("room expected");
        };
        assert_eq!(restored.metadata().policy.id, "living");
        assert_eq!(restored.metadata().retained_files, inventory);
        assert_eq!(
            restored
                .metadata()
                .own_credential
                .as_ref()
                .unwrap()
                .credential,
            "own-credential"
        );
        let mut actual = vec![];
        restored
            .for_each_row(|row| {
                actual.push(row);
                Ok(())
            })
            .map_err(anyhow::Error::from_boxed)?;
        assert_eq!(serde_json::to_value(actual)?, serde_json::to_value(rows)?);
        assert_eq!(content.len(), 1);
        assert_eq!(std::fs::read(content.values().next().unwrap())?, b"abc");

        let mut wrong = inventory.clone();
        wrong[0].attachment.name = "not the confirmed description".into();
        assert!(
            write_room(&snapshot, &wrong, Vec::new(), |_| Ok(Cursor::new(b"abc")))
                .unwrap_err()
                .to_string()
                .contains("backup_content_not_in_history")
        );
        assert!(
            write_room(&snapshot, &inventory, Vec::new(), |_| Ok(Cursor::new(
                b"abd"
            )))
            .unwrap_err()
            .to_string()
            .contains("backup_content_mismatch")
        );
        drop((snapshot, restored));
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[test]
    fn archive_staging_rejects_unverified_content_and_bounds_each_record() -> Result<()> {
        let folder = std::env::temp_dir().join(format!("piik-rejected-archive-{}", Uuid::new_v4()));
        std::fs::create_dir(&folder)?;
        let (mut metadata, rows, inventory) = room();
        metadata.retained_files = inventory[..1].to_vec();
        let manifest = record(&Metadata::Room(metadata.clone()))?;
        let history = record(&rows[0])?;
        let content_name = format!("content/{}", inventory[0].attachment.sha256);
        let bytes = pack(vec![
            (MANIFEST, manifest.clone()),
            (HISTORY, history.clone()),
            (&content_name, b"abd".to_vec()),
        ]);
        assert!(stage(Cursor::new(bytes), &folder)
            .err()
            .unwrap()
            .to_string()
            .contains("backup_content_mismatch"));
        let bytes = pack(vec![
            (MANIFEST, manifest),
            (HISTORY, history),
            (&content_name, b"abc".to_vec()),
            ("../outside", vec![]),
        ]);
        assert!(stage(Cursor::new(bytes), &folder)
            .err()
            .unwrap()
            .to_string()
            .contains("invalid_backup_entries"));

        assert!(read_record(Cursor::new(vec![b' '; RECORD_BYTES + 1]))
            .unwrap_err()
            .to_string()
            .contains("backup_record_too_large"));
        assert!(history_rows(Cursor::new(vec![b' '; RECORD_BYTES + 3]))
            .next()
            .unwrap()
            .err()
            .unwrap()
            .to_string()
            .contains("backup_record_too_large"));
        assert!(record(&"x".repeat(RECORD_BYTES))
            .unwrap_err()
            .to_string()
            .contains("backup_record_too_large"));
        let mut import = HistoryImport::new(&metadata).unwrap();
        import.accept(&rows[1]).unwrap();
        assert_eq!(import.accept(&rows[0]), Err("invalid_backup_history_order"));
        assert_eq!(import.finish(), Err("backup_content_not_in_history"));
        let missing = folder.join("missing.sqlite");
        assert!(RoomBackup::stage(&missing, metadata.clone(), std::iter::empty()).is_err());
        assert!(piik_channel_core::storage::Storage::open(&missing)
            .map_err(anyhow::Error::from_boxed)?
            .load()
            .map_err(anyhow::Error::from_boxed)?
            .is_none());
        metadata
            .retained_files
            .push(metadata.retained_files[0].clone());
        assert_eq!(metadata.validate(), Err("invalid_backup_content"));
        metadata.retained_files[1].message_seq = 55;
        metadata.retained_files[1].attachment.size += 1;
        assert_eq!(metadata.validate(), Err("invalid_backup_content"));
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[test]
    fn domain_archive_contains_only_its_own_authority() -> Result<()> {
        let metadata = Authority::new("owner".into(), "invite".into(), vec![])
            .unwrap()
            .export_backup();
        let mut bytes = vec![];
        write_domain(&metadata, &mut bytes)?;
        let StagedBackup::Domain(restored) = stage(Cursor::new(bytes), Path::new("unused"))? else {
            panic!("domain expected");
        };
        assert_eq!(
            serde_json::to_value(&restored)?,
            serde_json::to_value(&metadata)?
        );
        let bytes = pack(vec![
            (MANIFEST, record(&Metadata::Domain(metadata))?),
            (HISTORY, vec![]),
        ]);
        assert!(stage(Cursor::new(bytes), Path::new("unused"))
            .err()
            .unwrap()
            .to_string()
            .contains("invalid_backup_entries"));
        Ok(())
    }
}
