//! One same-build child owns one existing MFT worker. No WGC or output map.
use super::{gpu, output, CaptureClock, Settings};
use anyhow::{anyhow, bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
};
pub(super) const ARG: &str = "--piik-encoder-worker";
const MAX_HEADER: usize = 64 * 1024;
pub(super) const MAX_AU: usize = 4 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Command {
    Start { settings: Settings },
    Frame { frame: gpu::Frame },
    Read,
    Bitrate { bitrate: u32 },
    Keyframe,
    Stop,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Reply {
    NeedFrame {
        after: Option<i64>,
    },
    Au {
        qpc: i64,
        keyframe: bool,
        length: usize,
    },
    EncodingEnded {
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

fn read_command(reader: &mut impl Read) -> Result<Command> {
    let mut size = [0; 4];
    reader.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    ensure!(size <= MAX_HEADER, "capture IPC header too large");
    let mut header = vec![0; size];
    reader.read_exact(&mut header)?;
    Ok(serde_json::from_slice(&header)?)
}

pub fn worker_entry() -> Result<bool> {
    if std::env::args().nth(1).as_deref() != Some(ARG) {
        return Ok(false);
    }
    let _runtime = super::Runtime::new()?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run())?;
    Ok(true)
}
async fn run() -> Result<()> {
    let (commands, mut receiver) = mpsc::channel(4);
    let reader = std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        while let Ok(command) = read_command(&mut stdin) {
            let stop = matches!(command, Command::Stop);
            if commands.blocking_send(command).is_err() || stop {
                break;
            }
        }
    });
    let mut stdout = tokio::io::stdout();
    let result = encode(&mut receiver, &mut stdout).await;
    // Deliver terminal state before waiting for stdin: the parent then closes it.
    write_json(
        &mut stdout,
        &Reply::EncodingEnded {
            error: result.as_ref().err().map(|e| format!("{e:#}")),
        },
    )
    .await?;
    stdout.flush().await?;
    drop(receiver);
    reader
        .join()
        .map_err(|_| anyhow!("encoding stdin reader panicked"))?;
    result
}

async fn encode(
    receiver: &mut mpsc::Receiver<Command>,
    stdout: &mut tokio::io::Stdout,
) -> Result<()> {
    let settings = match receiver.recv().await {
        Some(Command::Start { settings }) => settings,
        Some(Command::Stop) | None => return Ok(()),
        _ => bail!("expected encoding Start"),
    };
    settings.validate()?;
    let clock = CaptureClock::new()?;
    let (requests, mut frames) = mpsc::channel(1);
    let mut encoding = output::Encoding::start(settings, clock, requests)?;
    let control = encoding.control();
    let mut gpu = None;
    let mut read = false;
    let result = async {
        loop {
            tokio::select! {
                biased;
                command = receiver.recv() => match command {
                    Some(Command::Frame { frame }) => {
                        if gpu.is_none() {
                            gpu = Some(gpu::Receiver::new(&frame)?);
                        }
                        let frame = gpu.as_ref().unwrap().receive(frame)?;
                        ensure!(encoding.shared.input(frame), "encoding stopped before raw input");
                    }
                    Some(Command::Read) => {
                        ensure!(!read, "duplicate AU Read");
                        read = true;
                    }
                    Some(Command::Bitrate { bitrate }) => control.set_bitrate(bitrate)?,
                    Some(Command::Keyframe) => control.force_keyframe()?,
                    Some(Command::Stop) | None => break,
                    _ => bail!("duplicate encoding Start"),
                },
                Some(after) = frames.recv() => {
                    write_json(stdout, &Reply::NeedFrame { after }).await?;
                    stdout.flush().await?;
                },
                frame = encoding.recv(), if read => match frame {
                    Some(Ok(frame)) => {
                        ensure!(frame.bytes.len() <= MAX_AU, "encoding IPC AU too large");
                        write_json(
                            stdout,
                            &Reply::Au {
                                qpc: clock.presentation_qpc(frame.presentation_time),
                                keyframe: frame.keyframe,
                                length: frame.bytes.len(),
                            },
                        ).await?;
                        stdout.write_all(&frame.bytes).await?;
                        stdout.flush().await?;
                        read = false;
                    }
                    Some(Err(error)) => return Err(error),
                    None => break,
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    control.stop();
    let joined = tokio::task::spawn_blocking(move || encoding.stop()).await?;
    result.and(joined)
}
