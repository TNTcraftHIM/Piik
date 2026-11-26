//! One same-build child owns one encoding worker. No WGC or output map.
use super::{gpu, output, CaptureClock, EncodingExecution, FrameTiming, Settings, VideoCodec};
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
    Start {
        settings: Settings,
        timing: FrameTiming,
        codec: VideoCodec,
        execution: EncodingExecution,
    },
    Frame {
        frame: gpu::Frame,
        keyframe: bool,
    },
    Read,
    Bitrate {
        bitrate: u32,
    },
    RefreshLatest,
    Stop,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Reply {
    NeedFrame {
        after: Option<i64>,
    },
    Au {
        codec: VideoCodec,
        qpc: i64,
        keyframe: bool,
        non_reference: bool,
        length: usize,
    },
    EncodingEnded {
        error: Option<String>,
        device_removed: Option<i32>,
        encoder_failed: bool,
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
            encoder_failed: result
                .as_ref()
                .err()
                .is_some_and(|e| e.is::<super::mf_common::HardwareEncoderFailed>()),
            device_removed: result
                .as_ref()
                .err()
                .and_then(gpu::device_lost)
                .map(|c| c.0),
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
    let (settings, timing, codec, execution) = match receiver.recv().await {
        Some(Command::Start {
            settings,
            timing,
            codec,
            execution,
        }) => (settings, timing, codec, execution),
        Some(Command::Stop) | None => return Ok(()),
        _ => bail!("expected encoding Start"),
    };
    settings.validate()?;
    let clock = CaptureClock::new()?;
    let (requests, frames) = mpsc::channel(1);
    let (encoding, ended) =
        output::Encoding::start(settings, codec, execution, clock, timing, requests)?;
    serve(receiver, stdout, frames, encoding, ended, clock, codec).await
}

async fn serve(
    receiver: &mut mpsc::Receiver<Command>,
    stdout: &mut (impl AsyncWrite + Unpin),
    mut frames: mpsc::Receiver<Option<i64>>,
    mut encoding: output::Encoding,
    mut ended: tokio::sync::oneshot::Receiver<()>,
    clock: CaptureClock,
    codec: VideoCodec,
) -> Result<()> {
    let control = encoding.control();
    let mut gpu = None;
    let mut read = false;
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = &mut ended => break,
                command = receiver.recv() => match command {
                    Some(Command::Frame { frame, keyframe }) => {
                        if gpu.is_none() {
                            gpu = Some(gpu::Receiver::new(&frame)?);
                        }
                        let frame = gpu.as_ref().unwrap().receive(frame)?;
                        encoding.shared.input(Some(frame), keyframe)?;
                    }
                    Some(Command::Read) => {
                        ensure!(!read, "duplicate AU Read");
                        read = true;
                    }
                    Some(Command::Bitrate { bitrate }) => control.set_bitrate(bitrate)?,
                    Some(Command::RefreshLatest) => encoding.shared.input(None, true)?,
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
                                codec,
                                qpc: clock.presentation_qpc(frame.presentation_time),
                                keyframe: frame.keyframe,
                                non_reference: frame.vp8.is_some_and(|metadata| metadata.non_reference),
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
    let result = joined_result(result, joined);
    result.map_err(|error| match gpu {
        Some(gpu) => gpu::failure(error, &gpu.device),
        None => error,
    })
}

fn joined_result(result: Result<()>, joined: Result<()>) -> Result<()> {
    // A command can observe the stop flag before recv exposes the worker's cause.
    match (result, joined) {
        (Err(stopped), Err(cause)) if stopped.is::<output::EncodingStopped>() => Err(cause),
        (result, joined) => result.and(joined),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn encoder_exit_wakes_idle_ipc_and_preserves_the_worker_cause() -> Result<()> {
        use super::super::mf_common::HardwareEncoderFailed;
        for unwind in [false, true] {
            let (requests, frames) = mpsc::channel(1);
            let (release, start) = std::sync::mpsc::channel();
            let (encoding, ended) = output::Encoding::spawn(requests, move |worker| {
                start.recv().unwrap();
                if unwind {
                    let _state = worker.state.lock().unwrap();
                    panic!("synthetic encoder panic");
                }
                Err(HardwareEncoderFailed.into())
            })?;
            let (_commands, mut receiver) = mpsc::channel(1);
            let mut sink = tokio::io::sink();
            let ipc = serve(
                &mut receiver,
                &mut sink,
                frames,
                encoding,
                ended,
                CaptureClock::new()?,
                VideoCodec::H264,
            );
            tokio::pin!(ipc);
            assert!(futures_util::poll!(&mut ipc).is_pending());
            release.send(())?;
            let error = tokio::time::timeout(std::time::Duration::from_secs(3), ipc)
                .await?
                .unwrap_err();
            if unwind {
                assert_eq!(error.to_string(), "encoder worker panicked");
            } else {
                assert!(error.is::<HardwareEncoderFailed>());
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn active_bitrate_command_joins_encoder_after_a_locked_panic() -> Result<()> {
        let (commands, mut receiver) = mpsc::channel(1);
        commands.try_send(Command::Bitrate { bitrate: 500_000 })?;
        let (requests, frames) = mpsc::channel(1);
        let (holding, locked) = tokio::sync::oneshot::channel();
        let (encoding, ended) = output::Encoding::spawn(requests, move |worker| {
            let _state = worker.state.lock().unwrap();
            holding.send(()).unwrap();
            // Capacity returns only after IPC has selected the bitrate command.
            commands.blocking_send(Command::Stop).unwrap();
            panic!("synthetic encoder panic with a bitrate command in flight");
        })?;
        locked.await?;
        let error = serve(
            &mut receiver,
            &mut tokio::io::sink(),
            frames,
            encoding,
            ended,
            CaptureClock::new()?,
            VideoCodec::H264,
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "encoder worker panicked");
        Ok(())
    }

    #[test]
    fn stopped_command_yields_to_joined_cause_but_ipc_failure_does_not() {
        use super::super::mf_common::HardwareEncoderFailed;
        let joined = || Err(HardwareEncoderFailed.into());
        let stopped = Err(anyhow::Error::from(output::EncodingStopped).context("bitrate command"));
        assert!(joined_result(stopped, joined())
            .unwrap_err()
            .is::<HardwareEncoderFailed>());
        assert!(joined_result(Ok(()), joined())
            .unwrap_err()
            .is::<HardwareEncoderFailed>());
        let ipc = Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe).into());
        assert!(joined_result(ipc, joined())
            .unwrap_err()
            .is::<std::io::Error>());
        let stopped = Err(output::EncodingStopped.into());
        assert!(joined_result(stopped, Ok(()))
            .unwrap_err()
            .is::<output::EncodingStopped>());
    }
}
