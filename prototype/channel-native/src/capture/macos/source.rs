use super::{checked, encoding::Encoding, Control, Frames, Image};
use crate::capture::{Settings, Target, TargetKind};
use anyhow::{anyhow, ensure, Context as _, Result};
use cidre::sc::stream::{Delegate as _, Output as _};
use cidre::{arc, cf, cg, cm, cv, define_obj_type, dispatch, ns, objc, sc, vt};
use objc2_core_graphics::{CGDisplayCopyDisplayMode, CGDisplayMode};
use std::thread;

pub struct Capture {
    frames: Frames,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn start(target: Target, fps: u32) -> Result<Self> {
        ensure!(fps > 0 && fps <= i32::MAX as u32, "invalid source FPS");
        let runtime = tokio::runtime::Handle::try_current()?;
        let frames = Frames::new();
        let source = frames.clone();
        let thread = thread::Builder::new()
            .name("piik-mac-source".into())
            .spawn(move || {
                let mut result = Ok(());
                objc::ar_pool(|| result = runtime.block_on(run(target, fps, &source)));
                source.finish(result.as_ref().err().map(|e| format!("{e:#}")));
                result
            })?;
        Ok(Self {
            frames,
            thread: Some(thread),
        })
    }
    pub fn frames(&self) -> Frames {
        self.frames.clone()
    }
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        Encoding::start(self.frames(), settings)
    }
    pub fn control(&self) -> Control {
        self.frames.control()
    }
    /// Join from a blocking owner, after cancellation and outside media locks.
    pub fn stop(mut self) -> Result<()> {
        self.frames.control().stop();
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("source worker panicked"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.frames.control().stop();
        if let Some(thread) = self.thread.take() {
            if let Err(error) = thread
                .join()
                .map_err(|_| anyhow!("source worker panicked"))
                .and_then(|result| result)
            {
                eprintln!("Mac source cleanup: {error:#}");
            }
        }
    }
}
/// Called by the App's existing blocking selection task, using its Tokio handle.
pub fn targets() -> Result<Vec<Target>> {
    let runtime = tokio::runtime::Handle::try_current()?;
    let mut result = Ok(Vec::new());
    objc::ar_pool(|| {
        result = runtime.block_on(async {
            let content = checked(sc::ShareableContent::current().await)?;
            let mut targets = Vec::new();
            for window in content.windows().iter() {
                let Some(title) = window.title().map(|title| title.to_string()) else {
                    continue;
                };
                if title.trim().is_empty() || !window.is_on_screen() {
                    continue;
                }
                let Some(app) = window.owning_app() else {
                    continue;
                };
                let pid = app.process_id();
                if pid <= 0 {
                    continue;
                }
                let Some(created) = process_creation_time(pid).filter(|created| *created > 0)
                else {
                    continue;
                };
                targets.push(Target {
                    kind: TargetKind::Window,
                    source_id: window.id().to_string(),
                    title,
                    pid: pid as u32,
                    creation_time: Some(created.to_string()),
                });
            }
            for display in content.displays().iter() {
                let id = display.display_id().0;
                targets.push(Target {
                    kind: TargetKind::Display,
                    source_id: id.to_string(),
                    title: format!("Display {id}"),
                    pid: 0,
                    creation_time: None,
                });
            }
            Ok(targets)
        });
    });
    result
}

enum Selected {
    Display(arc::R<sc::Display>),
    Window(arc::R<sc::Window>),
}
impl Selected {
    fn filter(&self) -> arc::R<sc::ContentFilter> {
        match self {
            Self::Display(display) => {
                sc::ContentFilter::with_display_excluding_windows(display, &ns::Array::new())
            }
            // Apple's window filter already captures the owning application's
            // audio. Both streams use this identity without a second display.
            Self::Window(window) => sc::ContentFilter::with_desktop_independent_window(window),
        }
    }
    fn size(&self) -> Result<(usize, usize)> {
        match self {
            Self::Display(display) => {
                // Use actual Retina backing mode, not SC points. This public
                // CoreGraphics C reference stays inside the source owner.
                let mode = CGDisplayCopyDisplayMode(display.display_id().0)
                    .context("display mode unavailable")?;
                let size = (
                    CGDisplayMode::pixel_width(Some(&mode)),
                    CGDisplayMode::pixel_height(Some(&mode)),
                );
                ensure!(size.0 > 0 && size.1 > 0, "invalid display size");
                Ok(size)
            }
            Self::Window(window) => {
                let frame = window.frame();
                dimensions(frame.size.width, frame.size.height)
            }
        }
    }
}
async fn select(target: &Target) -> Result<Selected> {
    let content = checked(sc::ShareableContent::current().await)?;
    let id: u32 = target.source_id.parse()?;
    match target.kind {
        TargetKind::Picker => Err(anyhow!("system picker target unavailable")),
        TargetKind::Display => {
            let displays = content.displays();
            let display = displays
                .iter()
                .find(|d| d.display_id().0 == id)
                .context("display unavailable")?;
            Ok(Selected::Display(display.retained()))
        }
        TargetKind::Window => {
            let windows = content.windows();
            let window = windows
                .iter()
                .find(|w| w.id() == id)
                .context("window unavailable")?;
            let app = window.owning_app().context("window owner unavailable")?;
            let created = target
                .creation_time
                .as_deref()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| *n > 0)
                .context("invalid window identity")?;
            ensure!(
                app.process_id() > 0
                    && app.process_id() as u32 == target.pid
                    && process_creation_time(app.process_id()) == Some(created),
                "window identity changed"
            );
            Ok(Selected::Window(window.retained()))
        }
    }
}
/// Sound shares target identity and filtering, without depending on video size.
pub async fn audio_filter(target: &Target) -> Result<arc::R<sc::ContentFilter>> {
    Ok(select(target).await?.filter())
}
fn dimensions(width: f64, height: f64) -> Result<(usize, usize)> {
    ensure!(
        [width, height]
            .iter()
            .all(|v| v.is_finite() && *v > 0.0 && *v <= i32::MAX as f64),
        "invalid source dimensions"
    );
    Ok((width.ceil() as usize, height.ceil() as usize))
}
fn process_creation_time(pid: i32) -> Option<u64> {
    let mut process: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&process) as i32;
    (unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut process as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    } == size)
        .then_some(process.pbi_start_tvsec * 1_000_000 + process.pbi_start_tvusec)
}

struct OutputState {
    frames: Frames,
    transfer: Option<arc::R<vt::PixelTransferSession>>,
}
define_obj_type!(
    Output + sc::stream::OutputImpl,
    OutputState,
    PIIK_CIDRE_SOURCE_OUTPUT
);
impl sc::stream::Output for Output {}
#[objc::add_methods]
impl sc::stream::OutputImpl for Output {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        stream: &sc::Stream,
        sample: &mut cm::SampleBuf,
        kind: sc::OutputType,
    ) {
        if kind != sc::OutputType::Screen || self.inner().frames.control().is_stopped() {
            return;
        }
        if let Err(error) = self.inner_mut().receive(stream, sample) {
            self.inner().frames.finish(Some(format!("{error:#}")));
        }
    }
}
define_obj_type!(
    Delegate + sc::stream::DelegateImpl,
    Frames,
    PIIK_CIDRE_SOURCE_DELEGATE
);
impl sc::stream::Delegate for Delegate {}
#[objc::add_methods]
impl sc::stream::DelegateImpl for Delegate {
    extern "C" fn impl_stream_did_stop_with_err(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _stream: &sc::Stream,
        error: &ns::Error,
    ) {
        self.inner().finish(Some(format!("{error:?}")));
    }
}

struct Geometry {
    crop: cg::Rect,
    size: (f64, f64),
    content_scale: f64,
}
fn geometry(sample: &cm::SampleBuf) -> Result<Option<Geometry>> {
    let attaches = sample
        .attaches(false)
        .context("missing frame attachments")?;
    ensure!(!attaches.is_empty(), "missing frame metadata");
    let info = &attaches[0];
    let number = |key: &sc::FrameInfo| {
        info.get(key.as_cf())
            .and_then(|v| v.try_as_number())
            .and_then(|v| v.to_f64())
    };
    if number(sc::FrameInfo::status()) != Some(sc::FrameStatus::Complete as isize as f64) {
        return Ok(None);
    }
    let rect = info
        .get(sc::FrameInfo::content_rect().as_cf())
        .and_then(|v| v.try_as_raw_dictionary())
        .and_then(cg::Rect::from_dictionary_representation)
        .context("invalid content rect")?;
    let scale = number(sc::FrameInfo::scale_factor()).context("missing source scale")?;
    let content_scale = number(sc::FrameInfo::content_scale()).context("missing content scale")?;
    ensure!(
        [scale, content_scale]
            .iter()
            .all(|v| v.is_finite() && *v > 0.0),
        "invalid source scale"
    );
    let crop = cg::Rect::new(
        rect.origin.x * scale,
        rect.origin.y * scale,
        rect.size.width * scale,
        rect.size.height * scale,
    );
    let size = (
        crop.size.width / content_scale,
        crop.size.height / content_scale,
    );
    dimensions(size.0, size.1)?;
    Ok(Some(Geometry {
        crop,
        size,
        content_scale,
    }))
}
impl OutputState {
    fn receive(&mut self, stream: &sc::Stream, sample: &mut cm::SampleBuf) -> Result<()> {
        let Some(mut geometry) = geometry(sample)? else {
            return Ok(());
        };
        if geometry.content_scale < 1.0 {
            // Metadata reveals a larger source than the current SC surface.
            // Do not upscale already-downsampled pixels and call them native.
            self.frames
                .shared
                .resize(dimensions(geometry.size.0, geometry.size.1)?);
            return Ok(());
        }
        let clock = stream
            .synchronization_clock()
            .context("missing SC synchronization clock")?;
        let pts = clock.convert_time_to(sample.pts(), cm::Clock::host_time_clock());
        let time = self.frames.clock().project(pts)?;
        let source = sample
            .image_buf_mut()
            .context("complete frame has no image")?;
        let (x, y, w, h) = (
            geometry.crop.origin.x,
            geometry.crop.origin.y,
            geometry.crop.size.width,
            geometry.crop.size.height,
        );
        ensure!(
            [x, y, w, h].iter().all(|v| v.is_finite())
                && w > 0.0
                && h > 0.0
                && x >= -0.5
                && y >= -0.5
                && x + w <= source.width() as f64 + 0.5
                && y + h <= source.height() as f64 + 0.5,
            "invalid source crop"
        );
        let (left, top) = (x.max(0.0), y.max(0.0));
        let (width, height) = (
            (x + w).min(source.width() as f64) - left,
            (y + h).min(source.height() as f64) - top,
        );
        geometry.size = (
            width / geometry.content_scale,
            height / geometry.content_scale,
        );
        use cv::image_buf_attach::{clean_aperture_keys as aperture, keys};
        let crop = cf::Dictionary::with_keys_values(
            &[
                aperture::width(),
                aperture::height(),
                aperture::horizontal_offset(),
                aperture::vertical_offset(),
            ],
            &[
                &*cf::Number::from_f64(width),
                &*cf::Number::from_f64(height),
                &*cf::Number::from_f64(left + width / 2.0 - source.width() as f64 / 2.0),
                &*cf::Number::from_f64(top + height / 2.0 - source.height() as f64 / 2.0),
            ],
        )
        .context("crop allocation failed")?;
        source.set_attach(
            keys::clean_aperture(),
            &crop,
            cv::AttachMode::ShouldPropagate,
        );
        let attrs = cf::Dictionary::with_keys_values(
            &[cv::pixel_buffer_keys::io_surf_props()],
            &[&*cf::Dictionary::new()],
        )
        .context("image attributes failed")?;
        let owned = checked(cv::PixelBuf::new(
            width.round().max(1.0) as usize,
            height.round().max(1.0) as usize,
            cv::PixelFormat::_32_BGRA,
            Some(&attrs),
        ))?;
        if self.transfer.is_none() {
            let mut transfer = checked(vt::PixelTransferSession::new())?;
            checked(transfer.set_scaling_crop_src_to_clean_aperture())?;
            self.transfer = Some(transfer);
        }
        checked(self.transfer.as_ref().unwrap().transfer(source, &owned))?;
        self.frames
            .publish(Image::copied(owned, geometry.size), time);
        Ok(())
    }
}

async fn run(target: Target, fps: u32, frames: &Frames) -> Result<()> {
    let control = frames.control();
    let selected = tokio::select! { _ = control.stopped() => return Ok(()), selected = select(&target) => selected? };
    let (width, height) = selected.size()?;
    let mut cfg = sc::StreamCfg::new();
    cfg.set_width(width);
    cfg.set_height(height);
    cfg.set_scales_to_fit(false);
    cfg.set_minimum_frame_interval(cm::Time::new(1, fps as i32));
    cfg.set_pixel_format(cv::PixelFormat::_32_BGRA);
    cfg.set_shows_cursor(true);
    let mut output = Output::with(OutputState {
        frames: frames.clone(),
        transfer: None,
    });
    let delegate = Delegate::with(frames.clone());
    let queue = dispatch::Queue::serial_with_ar_pool();
    let stream = sc::Stream::with_delegate(&selected.filter(), &cfg, delegate.as_ref());
    checked(stream.add_stream_output(output.as_ref(), sc::OutputType::Screen, Some(&queue)))?;
    let result = async {
        checked(stream.start().await)?;
        loop {
            let changed = frames.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let size = {
                let mut state = frames.shared.state.lock().unwrap();
                if state.stop {
                    if let Some(error) = &state.error {
                        return Err(anyhow!(error.clone()));
                    }
                    break;
                }
                state.resize.take()
            };
            if let Some((width, height)) = size {
                if width != cfg.width() || height != cfg.height() {
                    cfg.set_width(width);
                    cfg.set_height(height);
                    checked(stream.update_cfg(&cfg).await)?;
                }
            } else {
                changed.await;
            }
        }
        Ok(())
    }
    .await;
    // Stop completion precedes queue drain and release. Neither call holds the
    // Frames lock. The transfer session is created/retired on this serial queue.
    let stopped = checked(stream.stop().await);
    queue.sync(|| {
        if let Some(mut transfer) = output.inner_mut().transfer.take() {
            transfer.invalidate();
        }
    });
    let removed = checked(stream.remove_stream_output(output.as_ref(), sc::OutputType::Screen));
    result.and(stopped).and(removed)
}
