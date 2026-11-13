use super::{Options, Selection};
use anyhow::{ensure, Context, Result};
use ring::{digest, signature};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BundleLayout {
    pub schema: u8,
    pub entrypoint: String,
    pub entries: Vec<BundleEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct BundleEntry {
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Package {
    pub artifact: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize)]
struct Index {
    schema: u8,
    version: String,
    revision: String,
    targets: BTreeMap<String, Package>,
}

#[derive(Clone)]
pub(super) struct Installation {
    pub root: PathBuf,
    pub data_root: PathBuf,
    pub working_directory: PathBuf,
}

impl Installation {
    pub fn inspect(options: &Options, config: &super::super::Config) -> Result<Self> {
        let directory = options
            .executable
            .parent()
            .context("App directory is missing")?;
        ensure!(
            entry_kind(&fs::symlink_metadata(directory)?)? == EntryKind::Directory,
            "App directory must be a real directory"
        );
        let root = fs::canonicalize(directory)?;
        options.layout.check(&root)?;
        ensure!(
            options
                .executable
                .file_name()
                .and_then(|name| name.to_str())
                == Some(&options.layout.entrypoint),
            "App entrypoint does not match this package"
        );
        let data_root = fs::canonicalize(&config.data_root)?;
        ensure!(
            outside(&root, &data_root),
            "App data must remain outside the program directory"
        );
        ensure!(
            same_path(&fs::canonicalize(&config.assets)?, &root.join("web"))
                && same_path(
                    &fs::canonicalize(&config.cloudflared)?,
                    &root.join("runtime/tunnel/cloudflared.exe")
                ),
            "Custom App resources require a manual update"
        );
        ensure!(
            options.target == "windows-amd64",
            "This package target is not supported for installation"
        );
        Ok(Self {
            root,
            data_root,
            working_directory: fs::canonicalize(&options.working_directory)?,
        })
    }
}

pub(super) struct Prepared {
    pub directory: tempfile::TempDir,
    pub selection: Selection,
    pub operation: uuid::Uuid,
}

pub(super) fn hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut result = [0; N];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}

pub(super) fn validate_selection(current: &str, selection: &Selection) -> Result<()> {
    let version = semver::Version::parse(
        selection
            .version
            .strip_prefix('v')
            .context("Invalid version")?,
    )?;
    let current = semver::Version::parse(
        current
            .strip_prefix('v')
            .context("Unknown installed version")?,
    )?;
    ensure!(
        selection.version == format!("v{version}")
            && version.pre.is_empty()
            && version.build.is_empty()
            && version.cmp_precedence(&current).is_gt(),
        "An update must be a newer stable release"
    );
    ensure!(
        hex::<20>(&selection.revision).is_some()
            && selection.revision == selection.revision.to_ascii_lowercase(),
        "Invalid source revision"
    );
    Ok(())
}

pub(super) fn verify_index(
    key: &[u8; 32],
    bytes: &[u8],
    signature: &[u8],
    selection: &Selection,
    target: &str,
) -> Result<Package> {
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(bytes, signature)
        .map_err(|_| anyhow::anyhow!("Update signature is invalid"))?;
    let mut index: Index = serde_json::from_slice(bytes)?;
    ensure!(
        index.schema == 1
            && index.version == selection.version
            && index.revision == selection.revision,
        "Signed release identity does not match the selected release"
    );
    let package = index
        .targets
        .remove(target)
        .context("Signed release has no matching App package")?;
    ensure!(
        package.artifact == format!("piik-app-{target}.zip")
            && package.size > 0
            && package.size <= MAX_PACKAGE_BYTES
            && hex::<32>(&package.sha256).is_some()
            && package.sha256 == package.sha256.to_ascii_lowercase(),
        "Invalid signed App package"
    );
    Ok(package)
}

pub(super) fn verify_archive(path: &Path, package: &Package) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() == package.size,
        "Update package size changed"
    );
    let mut source = File::open(path)?;
    let mut hash = digest::Context::new(&digest::SHA256);
    let mut bytes = [0; 64 * 1024];
    loop {
        let count = source.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    ensure!(
        hash.finish().as_ref() == hex::<32>(&package.sha256).context("Invalid package digest")?,
        "Update package digest changed"
    );
    Ok(())
}

fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':', '\0', '<', '>', '"', '|', '?', '*'])
        && path.split('/').all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !part.is_empty()
                && !part.ends_with(['.', ' '])
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}

pub(super) fn entry_kind(metadata: &fs::Metadata) -> Result<EntryKind> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "Update directories cannot contain reparse points"
        );
    }
    ensure!(
        !metadata.file_type().is_symlink(),
        "Update directories cannot contain links"
    );
    if metadata.is_file() {
        Ok(EntryKind::File)
    } else if metadata.is_dir() {
        Ok(EntryKind::Directory)
    } else {
        anyhow::bail!("Unsupported update directory entry")
    }
}

pub(super) fn entries(root: &Path) -> Result<Vec<BundleEntry>> {
    fn walk(root: &Path, directory: &Path, found: &mut Vec<BundleEntry>) -> Result<()> {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let kind = entry_kind(&fs::symlink_metadata(&path)?)?;
            let relative = path
                .strip_prefix(root)?
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .context("Non-Unicode package path")
                })
                .collect::<Result<Vec<_>>>()?
                .join("/");
            found.push(BundleEntry {
                path: relative,
                kind,
            });
            ensure!(found.len() <= 100_000, "Too many package entries");
            if kind == EntryKind::Directory {
                walk(root, &path, found)?;
            }
        }
        Ok(())
    }
    ensure!(
        entry_kind(&fs::symlink_metadata(root)?)? == EntryKind::Directory,
        "Expected a real directory"
    );
    let mut result = vec![];
    walk(root, root, &mut result)?;
    result.sort();
    Ok(result)
}

impl BundleLayout {
    pub(super) fn check(&self, root: &Path) -> Result<()> {
        ensure!(
            self.schema == 1 && relative_path(&self.entrypoint) && !self.entrypoint.contains('/'),
            "Invalid package layout"
        );
        let mut expected = self.entries.clone();
        expected.sort();
        let mut unique = BTreeSet::new();
        for entry in &expected {
            ensure!(
                relative_path(&entry.path) && unique.insert(entry.path.to_ascii_lowercase()),
                "Invalid package layout entry"
            );
        }
        ensure!(
            expected.contains(&BundleEntry {
                path: self.entrypoint.clone(),
                kind: EntryKind::File
            }),
            "Missing package entrypoint"
        );
        ensure!(
            entries(root)? == expected,
            "Program directory contains missing, changed or additional entries"
        );
        Ok(())
    }
}

pub(super) fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

pub(super) fn outside(root: &Path, path: &Path) -> bool {
    !path.ancestors().any(|parent| same_path(root, parent))
}

pub(super) fn extract(archive: &Path, stage: &Path, entrypoint: &str) -> Result<()> {
    fs::create_dir(stage)?;
    let mut archive = zip::ZipArchive::new(File::open(archive)?)?;
    ensure!(archive.len() <= 100_000, "Too many update entries");
    let mut paths = BTreeSet::new();
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name()?.trim_end_matches('/').to_owned();
        ensure!(
            relative_path(&name)
                && entry.enclosed_name().is_some()
                && paths.insert(name.to_ascii_lowercase()),
            "Invalid or duplicate update path"
        );
        let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
        ensure!(
            mode == 0
                || (entry.is_dir() && mode == 0o040000)
                || (entry.is_file() && mode == 0o100000),
            "Update packages may contain only regular files and directories"
        );
        let destination = stage.join(&name);
        if entry.is_dir() {
            fs::create_dir_all(destination)?;
            continue;
        }
        ensure!(entry.is_file(), "Invalid update entry");
        expanded = expanded
            .checked_add(entry.size())
            .context("Update package is too large")?;
        ensure!(
            expanded <= MAX_EXTRACTED_BYTES,
            "Update package is too large"
        );
        fs::create_dir_all(destination.parent().unwrap())?;
        let mut output = File::options()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let size = entry.size();
        let copied = std::io::copy(&mut (&mut entry).take(size + 1), &mut output)?;
        ensure!(copied == size, "Update entry size mismatch");
        output.flush()?;
    }
    ensure!(
        stage.join(entrypoint).is_file()
            && stage.join("web/index.html").is_file()
            && stage.join("runtime/tunnel/cloudflared.exe").is_file()
            && stage.join("REVISION").is_file(),
        "Update package is incomplete"
    );
    Ok(())
}
