//! Same-build private process boundary. WGC/MFT remain the existing owners.
use super::{windows, CaptureClock, Settings, Target};
use anyhow::{anyhow, bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read, sync::Arc};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, Mutex},
    task::JoinSet,
};
use uuid::Uuid;

pub(super) const ARG: &str = "--piik-capture-worker";
pub(super) const COMMANDS: usize = 64;
const MAX_HEADER: usize = 64 * 1024;
// Same representation ceiling as internal/media/encoded.MaxAccessUnitBytes.
pub(super) const MAX_AU: usize = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Command {
    Start { target: Target, fps: u32 },
    Add { id: Uuid, settings: Settings },
    Read { id: Uuid },
    Bitrate { id: Uuid, bitrate: u32 },
    Keyframe { id: Uuid },
    Remove { id: Uuid },
    Stop,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Reply {
    Au {
        id: Uuid,
        qpc: i64,
        keyframe: bool,
        length: usize,
    },
    EncodingEnded {
        id: Uuid,
        error: Option<String>,
    },
    CaptureEnded {
        error: Option<String>,
    },
}
pub(super) async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<()> {
    let header = serde_json::to_vec(value)?;
    ensure!(header.len() <= MAX_HEADER, "capture IPC header too large");
    writer.write_u32_le(header.len() as u32).await?;
    writer.write_all(&header).await?;
    Ok(())
}
pub(super) async fn read_json<R: AsyncRead + Unpin, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> Result<T> {
    let size = reader.read_u32_le().await? as usize;
    ensure!(size <= MAX_HEADER, "capture IPC header too large");
    let mut header = vec![0; size];
    reader.read_exact(&mut header).await?;
    Ok(serde_json::from_slice(&header)?)
}
async fn reply(writer: &Arc<Mutex<tokio::io::Stdout>>, value: Reply, bytes: &[u8]) -> Result<()> {
    ensure!(bytes.len() <= MAX_AU, "capture IPC AU too large");
    let mut writer = writer.lock().await;
    write_json(&mut *writer, &value).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}
fn read_command(reader: &mut impl Read) -> Result<Command> {
    let mut size = [0; 4];
    reader.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    ensure!(size <= MAX_HEADER, "capture IPC header too large");
    let mut header = vec![0; size];
    reader.read_exact(&mut header)?;
    Ok(serde_json::from_slice(&header)?)
}

/// Call before normal App/Native startup in every executable using the proxy.
/// Returns false without doing work when this is not the private worker entry.
pub fn worker_entry() -> Result<bool> {
    if std::env::args().nth(1).as_deref() != Some(ARG) {
        return Ok(false);
    }
    let _runtime = super::Runtime::new()?;
    // A source owns this whole process, including its COM/MF lifetime.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run())?;
    Ok(true)
}

async fn run() -> Result<()> {
    let (commands, mut receiver) = mpsc::channel(COMMANDS);
    let reader = std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        while let Ok(command) = read_command(&mut stdin) {
            let stop = matches!(command, Command::Stop);
            if commands.blocking_send(command).is_err() || stop {
                break;
            }
        }
    });
    let (target, fps) = match receiver.recv().await {
        Some(Command::Start { target, fps }) => (target, fps),
        Some(Command::Stop) | None => {
            reader
                .join()
                .map_err(|_| anyhow!("capture IPC reader panicked"))?;
            return Ok(());
        }
        _ => bail!("expected capture Start"),
    };
    let capture = windows::Capture::start(target, fps)?;
    let clock = capture.clock;
    let control = capture.control();
    let writer = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut encodings = HashMap::new();
    let mut tasks = JoinSet::new();
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = control.stopped() => break,
                Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                    let (id, error) = result?;
                    encodings.remove(&id);
                    reply(&writer, Reply::EncodingEnded { id, error }, &[]).await?;
                }
                command = receiver.recv() => match command {
                    Some(Command::Add { id, settings }) => {
                        ensure!(!encodings.contains_key(&id), "duplicate capture encoding");
                        match capture.encode(settings) {
                            Ok(encoding) => {
                                let (send, recv) = mpsc::channel(1);
                                let ctl = encoding.control();
                                encodings.insert(id, (send, ctl));
                                tasks.spawn(encode(id, encoding, recv, writer.clone(), clock));
                            }
                            Err(error) => reply(&writer, Reply::EncodingEnded { id, error: Some(format!("{error:#}")) }, &[]).await?,
                        }
                    }
                    Some(Command::Stop) | None => break,
                    Some(command) => {
                        let id = match &command {
                            Command::Read { id } | Command::Bitrate { id, .. } | Command::Keyframe { id } | Command::Remove { id } => *id,
                            Command::Start { .. } => bail!("duplicate capture Start"),
                            _ => unreachable!(),
                        };
                        let retire = if matches!(command, Command::Remove { .. }) { true }
                        else if let Some((send, ctl)) = encodings.get(&id) {
                            match command {
                                Command::Read { .. } => match send.try_send(()) {
                                    Ok(()) | Err(mpsc::error::TrySendError::Closed(())) => false,
                                    Err(mpsc::error::TrySendError::Full(())) => {
                                        eprintln!("Native capture encoding {id} received duplicate Read"); true
                                    }
                                },
                                Command::Bitrate { bitrate, .. } => ctl.set_bitrate(bitrate).err().is_some_and(|error| {
                                    eprintln!("Native capture encoding {id} control failed: {error:#}"); true
                                }),
                                Command::Keyframe { .. } => ctl.force_keyframe().err().is_some_and(|error| {
                                    eprintln!("Native capture encoding {id} control failed: {error:#}"); true
                                }),
                                _ => unreachable!(),
                            }
                        } else { false };
                        if retire {
                            // Closing this one mailbox wakes encode even with no
                            // Read. JoinSet remains the sole Ended/join owner.
                            if let Some((send, ctl)) = encodings.remove(&id) { ctl.stop(); drop(send); }
                        }
                    }
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    control.stop();
    for (_, (_, control)) in encodings.drain() {
        control.stop();
    }
    // Parent continues draining replies during this shutdown. All physical
    // encoding/Capture joins stay in their existing implementation.
    let capture_stop = tokio::task::spawn_blocking(move || capture.stop());
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((id, error)) => {
                if let Some(error) = &error {
                    eprintln!("Native capture encoding {id} cleanup failed: {error}");
                }
                // Preserve each join result even when the source is already
                // stopping. A retired encoder error remains its own result.
                if let Err(error) = reply(&writer, Reply::EncodingEnded { id, error }, &[]).await {
                    eprintln!("Native capture encoding {id} cleanup reply failed: {error:#}");
                }
            }
            Err(error) => eprintln!("Native capture encoding join failed: {error}"),
        }
    }
    let stop = capture_stop.await?;
    let error = result
        .err()
        .or_else(|| stop.err())
        .map(|error| format!("{error:#}"));
    reply(&writer, Reply::CaptureEnded { error }, &[]).await?;
    drop(receiver);
    reader
        .join()
        .map_err(|_| anyhow!("capture IPC reader panicked"))?;
    Ok(())
}

async fn encode(
    id: Uuid,
    mut encoding: super::output::Encoding,
    mut commands: mpsc::Receiver<()>,
    writer: Arc<Mutex<tokio::io::Stdout>>,
    clock: CaptureClock,
) -> (Uuid, Option<String>) {
    let mut read = false;
    let result = async {
        loop {
            tokio::select! {
                biased;
                command = commands.recv() => match command {
                    Some(()) => { ensure!(!read, "duplicate capture Read"); read = true; }
                    None => break,
                },
                frame = encoding.recv(), if read => {
                    let Some(frame) = frame else { break; }; let frame = frame?;
                    let qpc = clock.presentation_qpc(frame.presentation_time);
                    reply(&writer, Reply::Au { id, qpc, keyframe: frame.keyframe, length: frame.bytes.len() }, &frame.bytes).await?;
                    read = false;
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    let stopped = tokio::task::spawn_blocking(move || encoding.stop()).await;
    let error = result.err().or_else(|| match stopped {
        Ok(result) => result.err(),
        Err(error) => Some(error.into()),
    });
    (id, error.map(|error| format!("{error:#}")))
}
