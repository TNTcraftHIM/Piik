use super::{frames::Clock, platform::Platform};
use crate::capture::AudioFrame;
use anyhow::{anyhow, ensure, Context as _, Result};
use jni::{jni_sig, jni_str};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
pub struct AudioControl {
    stopped: Arc<AtomicBool>,
    platform: Platform,
}
impl AudioControl {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Err(error) = self.platform.with(|env, object| {
            env.call_method(object, jni_str!("stopAudio"), jni_sig!(() -> void), &[])?;
            Ok(())
        }) {
            eprintln!("Android audio stop: {error:#}");
        }
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
}
pub struct AudioCapture {
    control: AudioControl,
    ready: Option<oneshot::Receiver<Result<()>>>,
    frames: mpsc::Receiver<AudioFrame>,
    completion: Option<oneshot::Receiver<Result<()>>>,
    thread: Option<thread::JoinHandle<()>>,
}
impl AudioCapture {
    pub(super) fn start(platform: Platform, clock: Clock) -> Result<Self> {
        let control = AudioControl {
            stopped: Arc::new(AtomicBool::new(false)),
            platform,
        };
        let worker = control.clone();
        let (frames, receiver) = mpsc::channel(2);
        let (ready, started) = oneshot::channel();
        let (complete, completion) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("piik-android-audio".into())
            .spawn(move || {
                let mut ready = Some(ready);
                let result = run(&worker, clock, frames, &mut ready);
                if let Some(ready) = ready {
                    let _ = ready.send(Err(anyhow!(result
                        .as_ref()
                        .err()
                        .map(|e| format!("{e:#}"))
                        .unwrap_or_else(|| "audio stopped before startup".into()))));
                }
                worker.stopped.store(true, Ordering::Release);
                let released = worker.platform.with(|env, object| {
                    env.call_method(object, jni_str!("releaseAudio"), jni_sig!(() -> void), &[])?;
                    Ok(())
                });
                let _ = complete.send(result.and(released));
            })?;
        Ok(Self {
            control,
            ready: Some(started),
            frames: receiver,
            completion: Some(completion),
            thread: Some(thread),
        })
    }
    pub fn control(&self) -> AudioControl {
        self.control.clone()
    }
    pub async fn ready(&mut self) -> Result<()> {
        self.ready
            .take()
            .context("audio startup already observed")?
            .await
            .context("audio stopped during startup")?
    }
    pub async fn recv(&mut self) -> Option<Result<AudioFrame>> {
        match self.frames.recv().await {
            Some(frame) => Some(Ok(frame)),
            None => self.completion.take()?.await.ok()?.err().map(Err),
        }
    }
    pub fn stop(mut self) -> Result<()> {
        self.control.stop();
        self.join()
    }
    fn join(&mut self) -> Result<()> {
        self.thread.take().map_or(Ok(()), |thread| {
            thread.join().map_err(|_| anyhow!("audio worker panicked"))
        })
    }
}
impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.control.stop();
        if let Err(error) = self.join() {
            eprintln!("Android audio cleanup: {error:#}");
        }
    }
}

fn run(
    control: &AudioControl,
    clock: Clock,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    control.platform.with(|env, object| {
        let record = env
            .call_method(
                object,
                jni_str!("audio"),
                jni_sig!(() -> android.media.AudioRecord),
                &[],
            )?
            .l()?;
        let timestamp = env.new_object(
            jni_str!("android/media/AudioTimestamp"),
            jni_sig!(() -> void),
            &[],
        )?;
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(()));
        }
        let mut samples = vec![0.0f32; 960 * 2];
        let mut filled = 0usize;
        let mut position = 0i64;
        while !control.is_stopped() {
            // Java uses this direct view only during the synchronous read call.
            let count = env.with_local_frame(8, |env| -> Result<i32> {
                let bytes = unsafe {
                    env.new_direct_byte_buffer(
                        samples.as_mut_ptr().add(filled).cast(),
                        (samples.len() - filled) * 4,
                    )
                }?;
                Ok(env
                    .call_method(
                        &record,
                        jni_str!("read"),
                        jni_sig!((java.nio.ByteBuffer,int,int) -> int),
                        &[
                            (&bytes).into(),
                            (((samples.len() - filled) * 4) as i32).into(),
                            0.into(),
                        ],
                    )?
                    .i()?)
            })?;
            if control.is_stopped() {
                break;
            }
            ensure!(
                count > 0 && count % 8 == 0,
                "AudioRecord read failed: {count}"
            );
            filled += count as usize / 4;
            position += i64::from(count) / 8;
            if filled < samples.len() {
                continue;
            }
            let status = env
                .call_method(
                    &record,
                    jni_str!("getTimestamp"),
                    jni_sig!((android.media.AudioTimestamp,int) -> int),
                    &[(&timestamp).into(), 0.into()],
                )?
                .i()?;
            if status == 0 {
                let capture_position = env
                    .get_field(&timestamp, jni_str!("framePosition"), jni_sig!(long))?
                    .j()?;
                let nanos = env
                    .get_field(&timestamp, jni_str!("nanoTime"), jni_sig!(long))?
                    .j()?;
                let first = nanos + (position - 960 - capture_position) * 1_000_000_000 / 48_000;
                // Source timestamps advance even when the existing bounded PCM queue is full.
                let _ = frames.try_send(AudioFrame {
                    samples: samples.clone(),
                    presentation_time: clock.project(first),
                });
            }
            filled = 0;
        }
        Ok(())
    })
}
