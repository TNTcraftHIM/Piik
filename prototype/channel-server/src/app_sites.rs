//! Local site permission and its data namespace. Domain credentials stay in memory.
use crate::web::origin;
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, num::NonZeroU16, path::Path};
use uuid::Uuid;

pub(super) struct Sites(Connection);

// Approval covers room hosting and device capture. A narrower saved consent
// must be approved again; its room-data namespace remains the same.
const APPROVAL_SCOPE: i64 = 2;

#[derive(Deserialize, Serialize)]
pub(super) struct LocalIdentity {
    // Seeds for first creation only. The opened Domain owns its active keys.
    pub owner: String,
    pub namespace: Uuid,
}

impl Sites {
    pub fn domain_port(&self) -> Result<Option<NonZeroU16>> {
        let saved: Option<String> = self
            .0
            .query_row(
                "SELECT value FROM app_setting WHERE key='domain_port'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        saved
            .map(|value| value.parse().map_err(Into::into))
            .transpose()
    }
    pub fn set_domain_port(&self, port: NonZeroU16) -> Result<()> {
        self.0.execute(
            "INSERT INTO app_setting(key,value) VALUES('domain_port',?1)",
            [port.to_string()],
        )?;
        Ok(())
    }
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        // Resolve the directory so SQLite can create journals beside long Windows paths.
        let db = Connection::open(std::fs::canonicalize(directory)?.join("app.sqlite"))?;
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
            .prepare("SELECT origin, data_id FROM app_site WHERE allowed = ?1")?;
        let rows = statement.query_map([APPROVAL_SCOPE], |row| {
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
                "SELECT EXISTS(SELECT 1 FROM app_site WHERE origin = ?1 AND allowed = ?2)",
                params![site, APPROVAL_SCOPE],
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
            params![
                site,
                id.to_string(),
                if allowed { APPROVAL_SCOPE } else { 0 }
            ],
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_requires_current_consent_and_preserves_room_namespace() -> Result<()> {
        let directory = std::env::temp_dir().join(format!("piik-site-consent-{}", Uuid::new_v4()));
        let mut sites = Sites::open(&directory)?;
        let site = "https://channel.example";
        let namespace = sites.approve(site, true)?;
        sites
            .0
            .execute("UPDATE app_site SET allowed=1 WHERE origin=?1", [site])?;
        assert!(!sites.approved()?.contains_key(site));
        assert!(sites.set_startup(site).is_err());
        assert_eq!(sites.approve(site, true)?, namespace);
        assert_eq!(sites.approved()?.get(site), Some(&namespace));
        sites.set_startup(site)?;
        sites.approve(site, false)?;
        assert!(sites.approved()?.is_empty());
        assert!(sites.startup()?.is_empty());
        assert_eq!(sites.approve(site, true)?, namespace);
        drop(sites);
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn long_data_directory_retains_approval_and_identity_after_reopen() -> Result<()> {
        let root = tempfile::tempdir()?;
        let directory = root
            .path()
            .join("app-data-".repeat(16))
            .join("room-data-".repeat(16));
        let site = "https://channel.example";
        let (namespace, identity) = {
            let mut sites = Sites::open(&directory)?;
            let namespace = sites.approve(site, true)?;
            sites.set_startup(site)?;
            assert!(sites.domain_port()?.is_none());
            sites.set_domain_port(NonZeroU16::new(31337).unwrap())?;
            (namespace, serde_json::to_value(sites.local_identity()?)?)
        };
        let sites = Sites::open(&directory)?;
        assert_eq!(sites.approved()?.get(site), Some(&namespace));
        assert_eq!(sites.startup()?, site);
        assert_eq!(sites.domain_port()?.unwrap().get(), 31337);
        assert_eq!(serde_json::to_value(sites.local_identity()?)?, identity);
        Ok(())
    }
}
