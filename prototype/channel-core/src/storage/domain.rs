use super::{StorageDataError, StoreResult};
use crate::{backup::DomainMetadata, channel::DurableState, Authority};
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use uuid::Uuid;

const HEADER: &str = "INSERT INTO checkpoint(id,body) VALUES(1,?1)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE checkpoint.body != excluded.body";
const USER: &str = "INSERT INTO domain_user(body) VALUES(?1)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body";

pub struct DomainStorage {
    connection: Connection,
}

impl DomainStorage {
    pub fn open(path: &Path) -> StoreResult<Self> {
        let connection = super::open_connection(path, Default::default())?;
        connection.execute_batch("PRAGMA secure_delete=ON")?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match version {
            1 => {}
            0 => connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
                CREATE TABLE domain_user(body TEXT NOT NULL, id TEXT AS (json_extract(body,'$.id')) UNIQUE NOT NULL);
                PRAGMA user_version=1; COMMIT;")?,
            _ => return Err(StorageDataError("unsupported_storage_version".into()).into()),
        }
        Ok(Self { connection })
    }

    pub fn load(&self) -> StoreResult<Option<DomainMetadata>> {
        let header: Option<String> = self
            .connection
            .query_row("SELECT body FROM checkpoint WHERE id=1", [], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(header) = header else {
            let orphaned: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM domain_user)",
                [],
                |row| row.get(0),
            )?;
            if orphaned {
                return Err(StorageDataError("invalid_storage_schema".into()).into());
            }
            return Ok(None);
        };
        let mut metadata: DomainMetadata = serde_json::from_str(&header)
            .map_err(|_| StorageDataError("unsupported_domain_checkpoint".into()))?;
        if !metadata.state.users.is_empty() {
            return Err(StorageDataError("invalid_storage_schema".into()).into());
        }
        let mut users = self
            .connection
            .prepare("SELECT body FROM domain_user ORDER BY id")?;
        for row in users.query_map([], |row| row.get::<_, String>(0))? {
            metadata.state.users.push(serde_json::from_str(&row?)?);
        }
        Ok(Some(metadata))
    }

    pub fn save_user(&mut self, authority: &Authority, connection: Uuid) -> StoreResult<()> {
        let identity = &authority.channel.identity;
        let session = identity
            .session_for_connection(connection)
            .ok_or("missing_admitted_session")?;
        let user = &identity.users[&identity.sessions[&session].user_id];
        let tx = self.connection.transaction()?;
        tx.execute(HEADER, [Self::header(authority)?])?;
        tx.execute(USER, [serde_json::to_string(&user.stored())?])?;
        tx.commit()?;
        Ok(())
    }

    fn header(authority: &Authority) -> StoreResult<String> {
        let metadata = DomainMetadata {
            version: DomainMetadata::VERSION,
            state: DurableState {
                version: DurableState::VERSION,
                header: authority.channel.export_header(),
                users: vec![],
            },
            owner_key: authority.owner_admission_key().into(),
        };
        Ok(serde_json::to_string(&metadata)?)
    }

    pub fn save_header(&self, authority: &Authority) -> StoreResult<()> {
        self.connection
            .execute(HEADER, [Self::header(authority)?])?;
        Ok(())
    }

    pub fn replace(&mut self, mut metadata: DomainMetadata) -> StoreResult<()> {
        let users = std::mem::take(&mut metadata.state.users);
        let tx = self.connection.transaction()?;
        tx.execute(HEADER, [serde_json::to_string(&metadata)?])?;
        tx.execute("DELETE FROM domain_user", [])?;
        {
            let mut insert = tx.prepare("INSERT INTO domain_user(body) VALUES(?1)")?;
            for user in users {
                insert.execute([serde_json::to_string(&user)?])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
