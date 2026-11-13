//! The copied, installed executable waits for the exact parent process, then swaps two directories.
use super::{
    package::{self, BundleLayout, Installation, Prepared},
    Options, Selection,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const RECORD: &str = "update-workspace.json";
const HELPER: &str = "apply-update.exe";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    schema: u8,
    operation: uuid::Uuid,
    root: PathBuf,
    data_root: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    headless: bool,
    parent: u32,
    selection: Selection,
    layout: BundleLayout,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    operation: uuid::Uuid,
    workspace: PathBuf,
}

#[derive(Serialize)]
struct Outcome<'a> {
    state: &'a str,
    detail: Option<String>,
}

struct Process(isize);

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn SetStdHandle(kind: u32, handle: isize) -> i32;
}

impl Process {
    fn open(pid: u32) -> Result<Self> {
        // SYNCHRONIZE only: the updater cannot terminate the running App.
        let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
        ensure!(
            handle != 0,
            "Open original App process: {}",
            std::io::Error::last_os_error()
        );
        let result = Self(handle);
        ensure!(
            unsafe { WaitForSingleObject(handle, 0) } == 0x102,
            "Original App already exited"
        );
        Ok(result)
    }
    fn wait(&self) -> Result<()> {
        match unsafe { WaitForSingleObject(self.0, 30_000) } {
            0 => Ok(()),
            0x102 => {
                anyhow::bail!("Original App did not finish shutting down; files were preserved")
            }
            _ => Err(std::io::Error::last_os_error().into()),
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let mut bytes = vec![];
    File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1024 * 1024, "Update record is too large");
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = File::options().write(true).create_new(true).open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.sync_all()?;
    Ok(())
}

fn matching_workspace(workspace: &Path, plan: &Plan) -> Result<()> {
    ensure!(
        plan.schema == 1
            && workspace.is_absolute()
            && plan.root.is_absolute()
            && plan.data_root.is_absolute(),
        "Invalid update workspace"
    );
    ensure!(
        package::entry_kind(&fs::symlink_metadata(workspace)?)? == package::EntryKind::Directory,
        "Update workspace must be a real directory"
    );
    ensure!(
        workspace
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&format!(".piik-update-{}-", plan.operation)))
            && workspace
                .parent()
                .zip(plan.root.parent())
                .is_some_and(|(a, b)| package::same_path(a, b))
            && package::outside(workspace, &plan.data_root),
        "Update workspace does not belong to this installation"
    );
    Ok(())
}

fn retire_previous(installation: &Installation) -> Result<()> {
    let record_path = installation.data_root.join(RECORD);
    if !record_path.exists() {
        return Ok(());
    }
    let record: Record = read_json(&record_path)?;
    let plan: Plan = read_json(&record.workspace.join("plan.json"))?;
    matching_workspace(&record.workspace, &plan)?;
    ensure!(
        record.operation == plan.operation
            && package::same_path(&plan.root, &installation.root)
            && package::same_path(&plan.data_root, &installation.data_root),
        "Previous update record does not match this App"
    );
    let allowed = [
        HELPER,
        "plan.json",
        "update.json",
        "update.json.sig",
        "package.zip",
        "incoming",
        "previous",
        "result.json",
    ];
    for entry in fs::read_dir(&record.workspace)? {
        let entry = entry?;
        ensure!(
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| allowed.contains(&name)),
            "Previous update contains unknown files"
        );
    }
    // Do not follow a junction or clean an old program directory to which the
    // user added files after updating. A mismatched record stays recoverable.
    package::entries(&record.workspace)?;
    let previous = record.workspace.join("previous");
    if previous.exists() {
        plan.layout.check(&previous)?;
    }
    fs::remove_dir_all(&record.workspace)?;
    fs::remove_file(record_path)?;
    Ok(())
}

pub(super) async fn handoff(
    options: &Options,
    installation: &Installation,
    prepared: Prepared,
    mut closing: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    ensure!(!*closing.borrow(), "App is closing");
    options.layout.check(&installation.root)?;
    ensure!(
        package::outside(
            &installation.root,
            &fs::canonicalize(&installation.data_root)?
        ),
        "App data is inside program files"
    );
    retire_previous(installation)?;
    let workspace = fs::canonicalize(prepared.directory.path())?;
    let plan = Plan {
        schema: 1,
        operation: prepared.operation,
        root: installation.root.clone(),
        data_root: installation.data_root.clone(),
        working_directory: installation.working_directory.clone(),
        arguments: options.arguments.clone(),
        headless: std::env::var_os("PIIK_CHANNEL_APP_NO_BROWSER").is_some(),
        parent: std::process::id(),
        selection: prepared.selection,
        layout: options.layout.clone(),
    };
    matching_workspace(&workspace, &plan)?;
    fs::copy(&options.executable, workspace.join(HELPER))?;
    write_new(&workspace.join("plan.json"), &plan)?;
    let record = installation.data_root.join(RECORD);
    write_new(
        &record,
        &Record {
            operation: plan.operation,
            workspace: workspace.clone(),
        },
    )?;

    let mut command = tokio::process::Command::new(workspace.join(HELPER));
    command
        .arg("--apply-update")
        .arg(workspace.join("plan.json"))
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&record);
            return Err(error).context("Start update helper");
        }
    };
    let launch = async {
        let mut output = BufReader::new(child.stdout.take().context("Update helper stdout")?);
        let mut line = String::new();
        let ready = tokio::select! {
            biased;
            _ = closing.changed() => anyhow::bail!("App closed before the update helper was ready"),
            ready = tokio::time::timeout(Duration::from_secs(60), output.read_line(&mut line)) => ready,
        };
        ensure!(
            matches!(ready, Ok(Ok(_))) && line.trim_end() == "PIIK_UPDATE_READY",
            "Update helper did not become ready"
        );
        ensure!(!*closing.borrow(), "App closed before update handoff");
        // EOF before this acknowledgement means handoff failed: the helper must
        // exit without renaming anything, even if the App subsequently closes.
        child
            .stdin
            .take()
            .context("Update helper stdin")?
            .write_all(b"APPLY\n")
            .await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    match launch {
        Ok(()) => {
            let _ = prepared.directory.keep();
            Ok(())
        }
        Err(error) => {
            // Before APPLY this helper has no permission to replace anything.
            // Reap it before its workspace is removed; never terminate the App.
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = fs::remove_file(record);
            Err(error)
        }
    }
}

fn start(plan: &Plan) -> Result<()> {
    let mut command = Command::new(plan.root.join(&plan.layout.entrypoint));
    command
        .args(&plan.arguments)
        .current_dir(&plan.working_directory)
        .env("PIIK_CHANNEL_APP_DATA_DIR", &plan.data_root)
        .env_remove("PIIK_CHANNEL_APP_WEB_DIR")
        .env_remove("PIIK_CHANNEL_CLOUDFLARED");
    if plan.headless {
        command
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    } else {
        // The ordinary native window hides its own console when ready. Browser
        // mode and unavailable-WebView fallback retain usable output and Ctrl+C.
        command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE
    }
    command.spawn().context("Create updated App process")?;
    Ok(())
}

fn replace(plan: &Plan, workspace: &Path) -> Result<()> {
    let incoming = workspace.join("incoming");
    let previous = workspace.join("previous");
    plan.layout.check(&plan.root)?;
    if let Err(error) = fs::rename(&plan.root, &previous) {
        let _ = start(plan);
        return Err(error).context(
            "Replacement could not start; old App directory retained and restart requested",
        );
    }
    if let Err(error) = fs::rename(&incoming, &plan.root) {
        fs::rename(&previous, &plan.root)
            .context("Replacement failed; old App remains in the update workspace")?;
        let _ = start(plan);
        return Err(error).context("Replacement failed; old App restored");
    }
    if let Err(error) = start(plan) {
        fs::rename(&plan.root, &incoming)
            .context("New process could not start; preserve both program copies")?;
        fs::rename(&previous, &plan.root)
            .context("New process could not start; old App remains in the update workspace")?;
        let _ = start(plan);
        return Err(error).context("New process could not start; old App restored");
    }
    // Creating the process is the boundary. Its subsequent exit is not permission
    // to downgrade code after it may have changed durable authority.
    Ok(())
}

pub(super) fn run(path: PathBuf) -> Result<()> {
    let executable = std::env::current_exe()?;
    let workspace = fs::canonicalize(executable.parent().context("Update helper directory")?)?;
    ensure!(
        package::same_path(&fs::canonicalize(&path)?, &workspace.join("plan.json")),
        "Unexpected update plan path"
    );
    let plan: Plan = read_json(&path)?;
    let outcome = (|| -> Result<()> {
        matching_workspace(&workspace, &plan)?;
        let options = match super::Config::packaged() {
            super::Config::Enabled(options) => options,
            _ => anyhow::bail!("Installed App does not have an update trust root"),
        };
        ensure!(
            serde_json::to_value(&plan.layout)? == serde_json::to_value(&options.layout)?,
            "Update plan changed its installed layout"
        );
        package::validate_selection(&options.version, &plan.selection)?;
        let record: Record = read_json(&plan.data_root.join(RECORD))?;
        ensure!(
            record.operation == plan.operation && package::same_path(&record.workspace, &workspace),
            "Update handoff no longer belongs to this App"
        );
        let parent = Process::open(plan.parent)?;
        options.layout.check(&plan.root)?;
        ensure!(
            package::outside(&plan.root, &fs::canonicalize(&plan.data_root)?),
            "App data is inside program files"
        );
        let package = package::verify_index(
            &options.public_key,
            &fs::read(workspace.join("update.json"))?,
            &fs::read(workspace.join("update.json.sig"))?,
            &plan.selection,
            &options.target,
        )?;
        package::verify_archive(&workspace.join("package.zip"), &package)?;
        package::extract(
            &workspace.join("package.zip"),
            &workspace.join("incoming"),
            &plan.layout.entrypoint,
        )?;
        ensure!(
            fs::read_to_string(workspace.join("incoming/REVISION"))?.trim()
                == plan.selection.revision,
            "New package revision differs from signed release"
        );
        println!("PIIK_UPDATE_READY");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        ensure!(line == "APPLY\n", "Update handoff was cancelled");
        parent.wait()?;
        // The single-threaded helper has finished its pipe handshake. Null
        // inherited handles let CreateProcess initialize the new console's own
        // streams instead of inheriting this helper's closed readiness pipe.
        for kind in [-10i32, -11, -12] {
            ensure!(
                unsafe { SetStdHandle(kind as u32, 0) } != 0,
                "Reset updater standard handles"
            );
        }
        replace(&plan, &workspace)
    })();
    let _ = write_new(
        &workspace.join("result.json"),
        &Outcome {
            state: if outcome.is_ok() { "started" } else { "failed" },
            detail: outcome.as_ref().err().map(|error| format!("{error:#}")),
        },
    );
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Plan, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("app");
        let data = directory.path().join("data");
        let workspace = directory.path().join("work");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join("incoming")).unwrap();
        let executable =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/where.exe");
        fs::copy(&executable, root.join("piik-app.exe")).unwrap();
        fs::copy(&executable, workspace.join("incoming/piik-app.exe")).unwrap();
        fs::write(root.join("version.txt"), "old").unwrap();
        fs::write(workspace.join("incoming/version.txt"), "new").unwrap();
        fs::write(data.join("state.txt"), "retained identity").unwrap();
        let layout = BundleLayout {
            schema: 1,
            entrypoint: "piik-app.exe".into(),
            entries: package::entries(&root).unwrap(),
        };
        let plan = Plan {
            schema: 1,
            operation: uuid::Uuid::new_v4(),
            root,
            data_root: data,
            working_directory: directory.path().to_owned(),
            arguments: vec!["/?".into()],
            headless: true,
            parent: std::process::id(),
            selection: Selection {
                version: "v3.0.1".into(),
                revision: "a".repeat(40),
            },
            layout,
        };
        (directory, plan, workspace)
    }

    #[test]
    fn replacement_failure_restores_old_files_before_a_new_process_exists() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_directory, plan, workspace) = fixture();
        let lock = File::options()
            .read(true)
            .share_mode(3)
            .custom_flags(0x02000000)
            .open(workspace.join("incoming"))
            .unwrap();
        assert!(replace(&plan, &workspace).is_err());
        assert_eq!(
            fs::read_to_string(plan.root.join("version.txt")).unwrap(),
            "old"
        );
        assert!(workspace.join("incoming/piik-app.exe").is_file());
        assert!(!workspace.join("previous").exists());
        drop(lock);
    }

    #[test]
    fn process_creation_failure_restores_old_files_without_restoring_data() {
        let (_directory, plan, workspace) = fixture();
        fs::write(workspace.join("incoming/piik-app.exe"), "not an executable").unwrap();
        assert!(replace(&plan, &workspace).is_err());
        assert_eq!(
            fs::read_to_string(plan.root.join("version.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(plan.data_root.join("state.txt")).unwrap(),
            "retained identity"
        );
    }

    #[test]
    fn successfully_created_process_keeps_new_program_and_previous_copy() {
        let (_directory, plan, workspace) = fixture();
        replace(&plan, &workspace).unwrap();
        assert_eq!(
            fs::read_to_string(plan.root.join("version.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("previous/version.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(plan.data_root.join("state.txt")).unwrap(),
            "retained identity"
        );
    }
}
