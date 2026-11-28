use anyhow::{ensure, Context, Result};
use piik_channel_prototype::domain::Domain;
use std::{path::Path, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LINK_BYTES: u64 = 8 * 1024;

pub async fn request(directory: &Path) -> Result<String> {
    let stream = transport::connect(directory)
        .await
        .context("Connect to the running Server as its local operator")?;
    tokio::time::timeout(EXCHANGE_TIMEOUT, async {
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        let n = (&mut stream).take(MAX_LINK_BYTES).read_line(&mut line).await?;
        ensure!(
            n > 0 && line.ends_with('\n'),
            "Server returned no complete owner link"
        );
        stream.write_all(b"K").await?;
        Ok(line.trim_end().to_string())
    })
    .await?
}

pub use transport::Listener;

pub async fn serve(mut listener: Listener, domain: &Domain) -> Result<()> {
    let target = url::Url::parse(domain.origin())?.join("/")?;
    loop {
        let mut stream = listener.accept().await?;
        let Ok(ticket) = domain.launch_ticket() else {
            continue;
        };
        let link = format!("{target}#launch={ticket}\n");
        let _ = tokio::time::timeout(EXCHANGE_TIMEOUT, async {
            stream.write_all(link.as_bytes()).await?;
            stream.read_u8().await
        })
        .await;
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_local_client_does_not_retire_listener() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let mut listener = Listener::bind(directory.path())?;
        drop(transport::connect(directory.path()).await?);
        let accepted = tokio::time::timeout(Duration::from_secs(3), listener.accept()).await?;
        drop(accepted.context("accept after the cancelled client")?);
        let client = transport::connect(directory.path()).await?;
        drop(tokio::time::timeout(Duration::from_secs(3), listener.accept()).await??);
        drop(client);
        Ok(())
    }
}

#[cfg(unix)]
mod transport {
    use anyhow::{ensure, Context, Result};
    use std::{
        fs,
        os::unix::{
            fs::{symlink, DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
            net::SocketAddr,
        },
        path::{Path, PathBuf},
    };
    use tempfile::TempDir;
    use tokio::net::{UnixListener, UnixStream};

    pub struct Listener(UnixListener, PathBuf);

    fn path(directory: &Path) -> PathBuf {
        directory.join(".operator").join("owner.sock")
    }

    fn call_path(socket: &Path) -> Result<(PathBuf, Option<TempDir>)> {
        if SocketAddr::from_pathname(socket).is_ok() {
            return Ok((socket.to_owned(), None));
        }
        // Each caller needs its own short spelling only until bind or connect returns.
        let parent = socket.parent().unwrap().canonicalize()?;
        let alias = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .context("Create a temporary directory for the operator socket address")?;
        let link = alias.path().join("d");
        symlink(parent, &link)?;
        Ok((link.join(socket.file_name().unwrap()), Some(alias)))
    }

    pub async fn connect(directory: &Path) -> Result<UnixStream> {
        let (address, _alias) = call_path(&path(directory))?;
        Ok(UnixStream::connect(address).await?)
    }

    impl Listener {
        pub fn bind(directory: &Path) -> Result<Self> {
            let socket = path(directory);
            let parent = socket.parent().unwrap();
            match fs::DirBuilder::new().mode(0o700).create(parent) {
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                other => other?,
            }
            let meta = fs::symlink_metadata(parent)?;
            ensure!(
                meta.is_dir()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.mode() & 0o077 == 0,
                "Server requires a private .operator directory"
            );
            if let Ok(meta) = fs::symlink_metadata(&socket) {
                ensure!(meta.file_type().is_socket(), "Unexpected operator endpoint");
                fs::remove_file(&socket)?;
            }
            let (address, _alias) = call_path(&socket)?;
            Ok(Self(UnixListener::bind(address)?, socket))
        }

        pub async fn accept(&mut self) -> Result<UnixStream> {
            loop {
                let (stream, _) = self.0.accept().await?;
                if stream.peer_cred()?.uid() == unsafe { libc::geteuid() } {
                    return Ok(stream);
                }
            }
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.1);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        #[tokio::test]
        async fn operator_socket_follows_the_data_directory() -> Result<()> {
            let root = tempfile::tempdir_in(".")?;
            let relative = Path::new(root.path().file_name().unwrap());
            let long = relative.join("x".repeat(128));
            fs::create_dir(&long)?;
            for directory in [relative, long.as_path()] {
                let marker = directory.join("marker");
                fs::write(&marker, b"data")?;
                let mut listener = Listener::bind(directory)?;
                assert!(fs::metadata(path(directory))?.file_type().is_socket());
                let mut client = connect(directory).await?;
                let mut server = listener.accept().await?;
                client.write_u8(42).await?;
                assert_eq!(server.read_u8().await?, 42);
                drop(listener);
                assert!(!path(directory).try_exists()?);
                assert_eq!(fs::read(marker)?, b"data");
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
mod transport {
    use anyhow::Result;
    use std::{io, os::windows::ffi::OsStrExt, path::Path};
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
    };

    pub struct Listener(NamedPipeServer, String);

    fn name(directory: &Path) -> Result<String> {
        let bytes: Vec<_> = directory
            .canonicalize()?
            .as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect();
        let hash = ring::digest::digest(&ring::digest::SHA256, &bytes);
        let suffix: String = hash
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(format!(r"\\.\pipe\piik-owner-{suffix}"))
    }

    fn pipe(name: &str, first: bool) -> Result<NamedPipeServer> {
        // OW grants the object's owner access. BA grants elevated local administrators access.
        let sddl: Vec<u16> = "D:P(A;;GA;;;OW)(A;;GA;;;BA)\0".encode_utf16().collect();
        let mut descriptor = std::ptr::null_mut();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error().into());
            }
            let mut sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let result = ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    name,
                    (&mut sa as *mut SECURITY_ATTRIBUTES).cast(),
                );
            LocalFree(descriptor);
            Ok(result?)
        }
    }

    pub async fn connect(directory: &Path) -> Result<NamedPipeClient> {
        Ok(ClientOptions::new().open(name(directory)?)?)
    }

    impl Listener {
        pub fn bind(directory: &Path) -> Result<Self> {
            let name = name(directory)?;
            Ok(Self(pipe(&name, true)?, name))
        }

        pub async fn accept(&mut self) -> Result<NamedPipeServer> {
            self.0.connect().await?;
            let next = pipe(&self.1, false)?;
            Ok(std::mem::replace(&mut self.0, next))
        }
    }
}
