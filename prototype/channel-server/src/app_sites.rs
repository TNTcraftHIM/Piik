//! Local site permission and its data namespace. Domain credentials stay in memory.
use crate::web::origin;
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, num::NonZeroU16, path::Path};
use uuid::Uuid;

pub(super) struct Sites(Connection);

#[derive(Serialize)]
pub(super) struct Bookmark {
    pub id: Uuid,
    pub origin: String,
    pub name: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub(super) enum StartupIntent {
    #[default]
    None,
    External(String),
    Owned(super::hosted::Request),
}

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
             CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS app_bookmark (
               id TEXT PRIMARY KEY, origin TEXT NOT NULL UNIQUE, name TEXT NOT NULL);",
        )?;
        Ok(Self(db))
    }
    pub fn bookmarks(&self) -> Result<Vec<Bookmark>> {
        let mut statement = self
            .0
            .prepare("SELECT id, origin, name FROM app_bookmark ORDER BY rowid")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.map(|row| {
            let (id, origin, name) = row?;
            Ok(Bookmark {
                id: Uuid::parse_str(&id)?,
                origin,
                name,
            })
        })
        .collect()
    }
    // False means another bookmark already owns this origin.
    pub fn save_bookmark(&self, bookmark: &Bookmark) -> Result<bool> {
        let duplicate: bool = self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_bookmark WHERE origin=?1 AND id<>?2)",
            params![bookmark.origin, bookmark.id.to_string()],
            |row| row.get(0),
        )?;
        if duplicate {
            return Ok(false);
        }
        self.0.execute(
            "INSERT INTO app_bookmark(id,origin,name) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET origin=excluded.origin,name=excluded.name",
            params![bookmark.id.to_string(), bookmark.origin, bookmark.name],
        )?;
        Ok(true)
    }
    pub fn delete_bookmark(&self, id: Uuid) -> Result<()> {
        self.0
            .execute("DELETE FROM app_bookmark WHERE id=?1", [id.to_string()])?;
        Ok(())
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
    pub fn startup(&self) -> Result<StartupIntent> {
        let saved: Option<String> = self
            .0
            .query_row(
                "SELECT value FROM app_setting WHERE key = 'startup'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match saved.as_deref().unwrap_or("") {
            "" => Ok(StartupIntent::None),
            value if value.starts_with('{') => Ok(serde_json::from_str(value)?),
            site => Ok(StartupIntent::External(origin(site)?)),
        }
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
    pub fn set_startup(&self, startup: &StartupIntent) -> Result<()> {
        if let StartupIntent::External(site) = startup {
            if !self.approved()?.contains_key(site) {
                bail!("site_not_approved");
            }
        }
        self.0.execute(
            "INSERT INTO app_setting(key,value) VALUES('startup',?1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [match startup {
                StartupIntent::None => String::new(),
                StartupIntent::External(site) => site.clone(),
                StartupIntent::Owned(_) => serde_json::to_string(startup)?,
            }],
        )?;
        Ok(())
    }
    pub fn approve(&mut self, site: &str, allowed: bool) -> Result<Uuid> {
        let clear_startup = !allowed
            && matches!(self.startup()?, StartupIntent::External(origin) if origin == site);
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
        if clear_startup {
            transaction.execute("DELETE FROM app_setting WHERE key='startup'", [])?;
        }
        transaction.commit()?;
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookmarks_reopen_edit_and_delete_without_changing_approval_or_startup() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let site = "https://friend.example";
        let mut bookmark = Bookmark {
            id: Uuid::new_v4(),
            origin: site.into(),
            name: "Friend".into(),
        };
        let namespace = {
            let mut sites = Sites::open(directory.path())?;
            assert!(sites.save_bookmark(&bookmark)?);
            assert!(sites.approved()?.is_empty());
            assert!(matches!(sites.startup()?, StartupIntent::None));
            let namespace = sites.approve(site, true)?;
            sites.set_startup(&StartupIntent::External(site.into()))?;
            namespace
        };
        let sites = Sites::open(directory.path())?;
        assert_eq!(sites.bookmarks()?[0].id, bookmark.id);
        bookmark.origin = "https://next.example".into();
        bookmark.name = String::new();
        assert!(sites.save_bookmark(&bookmark)?);
        assert_eq!(sites.bookmarks()?[0].origin, bookmark.origin);
        assert!(sites.bookmarks()?[0].name.is_empty());
        let duplicate = Bookmark {
            id: Uuid::new_v4(),
            origin: bookmark.origin.clone(),
            name: "Other".into(),
        };
        assert!(!sites.save_bookmark(&duplicate)?);
        sites.delete_bookmark(bookmark.id)?;
        assert!(sites.bookmarks()?.is_empty());
        assert_eq!(sites.approved()?.get(site), Some(&namespace));
        assert!(matches!(sites.startup()?, StartupIntent::External(origin) if origin == site));
        Ok(())
    }

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
        assert!(sites
            .set_startup(&StartupIntent::External(site.into()))
            .is_err());
        assert_eq!(sites.approve(site, true)?, namespace);
        assert_eq!(sites.approved()?.get(site), Some(&namespace));
        sites.set_startup(&StartupIntent::External(site.into()))?;
        sites.approve(site, false)?;
        assert!(sites.approved()?.is_empty());
        assert!(matches!(sites.startup()?, StartupIntent::None));
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
            sites.set_startup(&StartupIntent::External(site.into()))?;
            let saved: String = sites.0.query_row(
                "SELECT value FROM app_setting WHERE key='startup'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(
                saved, site,
                "fixed external bookmarks keep their existing representation"
            );
            assert!(sites.domain_port()?.is_none());
            sites.set_domain_port(NonZeroU16::new(31337).unwrap())?;
            (namespace, serde_json::to_value(sites.local_identity()?)?)
        };
        let sites = Sites::open(&directory)?;
        assert_eq!(sites.approved()?.get(site), Some(&namespace));
        assert!(matches!(sites.startup()?, StartupIntent::External(origin) if origin == site));
        assert_eq!(sites.domain_port()?.unwrap().get(), 31337);
        assert_eq!(serde_json::to_value(sites.local_identity()?)?, identity);
        Ok(())
    }
}
