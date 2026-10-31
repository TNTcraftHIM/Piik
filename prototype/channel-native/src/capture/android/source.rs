use super::{
    audio::AudioCapture,
    encoding::Encoding,
    frames::{Frames, RawFrame},
    graphics::Graphics,
    platform::Platform,
};
use crate::capture::{cadence::Cadence, Settings, Target, TargetKind};
use anyhow::{anyhow, ensure, Context as _, Result};
use jni::{jni_sig, jni_str};
use ndk::surface_texture::SurfaceTexture;
use std::thread;

#[derive(Clone)]
pub struct Control {
    frames: Frames,
    platform: Platform,
}
impl Control {
    pub fn stop(&self) {
        self.frames.stop(None);
        self.platform.stop();
    }
    pub fn is_stopped(&self) -> bool {
        self.frames.is_stopped()
    }
    pub async fn stopped(&self) {
        self.frames.stopped().await;
    }
}
pub struct Capture {
    frames: Frames,
    platform: Platform,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn start(target: Target, fps: u32, audio: bool) -> Result<Self> {
        ensure!(
            matches!(target.kind, TargetKind::Picker),
            "Android capture uses the system picker"
        );
        ensure!(fps > 0, "invalid source FPS");
        let frames = Frames::new()?;
        let platform = Platform::new(audio)?;
        let worker = frames.clone();
        let projection = platform.clone();
        let thread = thread::Builder::new()
            .name("piik-android-source".into())
            .spawn(move || {
                let result = run(&projection, &worker, fps);
                worker.stop(result.as_ref().err().map(|e| format!("{e:#}")));
                projection.stop();
                let disposed = projection.with(|env, object| {
                    env.call_method(object, jni_str!("dispose"), jni_sig!(() -> void), &[])?;
                    Ok(())
                });
                result.and(disposed)
            })?;
        Ok(Self {
            frames,
            platform,
            thread: Some(thread),
        })
    }
    pub fn audio(&self, _target: Target) -> Result<AudioCapture> {
        AudioCapture::start(self.platform.clone(), self.frames.clock)
    }
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        Encoding::start(self.frames.clone(), settings)
    }
    pub fn control(&self) -> Control {
        Control {
            frames: self.frames.clone(),
            platform: self.platform.clone(),
        }
    }
    pub fn stop(mut self) -> Result<()> {
        self.control().stop();
        self.join()
    }
    fn join(&mut self) -> Result<()> {
        self.thread.take().map_or(Ok(()), |t| {
            t.join()
                .map_err(|_| anyhow!("Android capture worker panicked"))?
        })
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.control().stop();
        if let Err(e) = self.join() {
            eprintln!("Android capture cleanup: {e:#}");
        }
    }
}

fn run(platform: &Platform, frames: &Frames, fps: u32) -> Result<()> {
    let mut cadence = Cadence::new(fps);
    let graphics = Graphics::new(frames.display.clone(), None, true)?;
    let (texture, java_texture) = platform.with(|env, object| {
        let texture = env
            .call_method(
                object,
                jni_str!("texture"),
                jni_sig!(() -> android.graphics.SurfaceTexture),
                &[],
            )?
            .l()?;
        let native = unsafe {
            SurfaceTexture::from_surface_texture(env.get_raw().cast(), texture.as_raw().cast())
        }
        .context("missing SurfaceTexture")?;
        Ok((native, env.new_global_ref(texture)?))
    })?;
    let external = graphics.external_texture()?;
    texture.attach_to_gl_context(external.0.get())?;
    let result = (|| {
        platform.with(|env, object| {
            env.call_method(object, jni_str!("start"), jni_sig!(() -> void), &[])?;
            Ok(())
        })?;
        loop {
            let size = platform.with(|env, object| {
                Ok(env
                    .call_method(object, jni_str!("nextFrame"), jni_sig!(() -> long), &[])?
                    .j()?)
            })?;
            if size == 0 || frames.is_stopped() {
                break;
            }
            texture.update_tex_image()?;
            let nanos: i64 = texture.timestamp().as_nanos().try_into()?;
            if !cadence.accept(nanos / 100) {
                continue;
            }
            let image = graphics.snapshot(
                external,
                ((size >> 32) as u32, size as u32),
                &texture.transform_matrix(),
            )?;
            frames.publish(RawFrame { image, nanos });
        }
        Ok(())
    })();
    let detached = texture.detach_from_gl_context();
    drop(texture);
    drop(java_texture);
    result.and(detached.map_err(Into::into))
}
