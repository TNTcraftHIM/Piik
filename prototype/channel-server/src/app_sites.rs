//! Local site permission and its data namespace. Domain credentials stay in memory.
use crate::web::origin;
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use uuid::Uuid;

pub(super) struct Sites(Connection);

#[derive(Deserialize, Serialize)]
pub(super) struct LocalIdentity {
    pub owner: String,
    pub invite: String,
    pub namespace: Uuid,
}

impl Sites {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let db = Connection::open(directory.join("app.sqlite"))?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_site (
               origin TEXT PRIMARY KEY, data_id TEXT NOT NULL, allowed INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self(db))
    }
    pub fn approved(&self) -> Result<BTreeMap<String, Uuid>> {
        let mut statement = self
            .0
            .prepare("SELECT origin, data_id FROM app_site WHERE allowed = 1")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (site, id) = row?;
            Ok((origin(&site)?, Uuid::parse_str(&id)?))
        })
        .collect()
    }
    pub fn startup(&self) -> Result<String> {
        Ok(self
            .0
            .query_row(
                "SELECT value FROM app_setting WHERE key = 'startup'",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_default())
    }
    pub fn local_identity(&self) -> Result<LocalIdentity> {
        let saved: Option<String> = self
            .0
            .query_row(
                "SELECT value FROM app_setting WHERE key = 'domain'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            return Ok(serde_json::from_str(&saved)?);
        }
        let identity = LocalIdentity {
            owner: Uuid::new_v4().to_string(),
            invite: Uuid::new_v4().to_string(),
            namespace: Uuid::new_v4(),
        };
        self.0.execute(
            "INSERT INTO app_setting(key,value) VALUES('domain',?1)",
            [serde_json::to_string(&identity)?],
        )?;
        Ok(identity)
    }
    pub fn set_startup(&self, site: &str) -> Result<()> {
        if !site.is_empty()
            && !self.0.query_row(
                "SELECT EXISTS(SELECT 1 FROM app_site WHERE origin = ?1 AND allowed = 1)",
                [site],
                |row| row.get::<_, bool>(0),
            )?
        {
            bail!("site_not_approved");
        }
        self.0.execute(
            "INSERT INTO app_setting(key,value) VALUES('startup',?1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [site],
        )?;
        Ok(())
    }
    pub fn approve(&mut self, site: &str, allowed: bool) -> Result<Uuid> {
        let transaction = self.0.transaction()?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT data_id FROM app_site WHERE origin = ?1",
                [site],
                |row| row.get(0),
            )
            .optional()?;
        let id = match previous {
            Some(id) => Uuid::parse_str(&id)?,
            None => Uuid::new_v4(),
        };
        transaction.execute(
            "INSERT INTO app_site(origin,data_id,allowed) VALUES(?1,?2,?3)
             ON CONFLICT(origin) DO UPDATE SET allowed=excluded.allowed",
            params![site, id.to_string(), allowed],
        )?;
        if !allowed {
            transaction.execute(
                "DELETE FROM app_setting WHERE key='startup' AND value=?1",
                [site],
            )?;
        }
        transaction.commit()?;
        Ok(id)
    }
}
