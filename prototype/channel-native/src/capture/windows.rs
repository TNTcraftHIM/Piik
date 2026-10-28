//! WGC owns capture callbacks; one worker owns MF and its ordered AU output.
use super::{mf::Encoder, EncodedFrame, Settings, Target, TargetKind};
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{
    collections::VecDeque,
    mem::ManuallyDrop,
    sync::{Arc, Condvar, Mutex},
    thread,
};
use tokio::sync::Notify;
use windows::{
    core::Interface,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HWND, RECT},
        Graphics::{Direct3D11::*, Dxgi::Common::*},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    },
};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings as WgcSettings,
    },
    window::Window,
};

pub(super) struct RawFrame {
    pub texture: ID3D11Texture2D,
    pub qpc: i64,
}
impl Clone for RawFrame {
    fn clone(&self) -> Self {
        Self {
            texture: self.texture.clone(),
            qpc: self.qpc,
        }
    }
}
#[derive(Default)]
pub(super) struct State {
    pub stop: bool,
    pub done: bool,
    pub failure: Option<String>,
    pub latest: Option<RawFrame>,
    pub device: Option<ID3D11Device>,
    pub event: Option<windows::core::Result<u32>>,
    pub force_keyframe: bool,
    pub bitrate: Option<u32>,
    output: VecDeque<EncodedFrame>,
}
#[derive(Default)]
pub(super) struct Shared {
    pub state: Mutex<State>,
    pub changed: Condvar,
    available: Notify,
}
impl Shared {
    pub fn wake(&self) {
        self.changed.notify_all();
    }
    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stop = true;
        state.output.clear();
        drop(state);
        self.wake();
        self.available.notify_one();
    }
    fn failure(&self, error: &anyhow::Error) {
        let mut state = self.state.lock().unwrap();
        state.failure = Some(format!("{error:#}"));
        state.stop = true;
        drop(state);
        self.wake();
    }
    pub fn output(&self, frame: EncodedFrame) -> bool {
        let mut state = self.state.lock().unwrap();
        // AU backpressure preserves the encoded dependency chain. Only raw
        // capture's latest slot is replaceable, never an already encoded P frame.
        while state.output.len() == 2 && !state.stop {
            state = self.changed.wait(state).unwrap();
        }
        if state.stop {
            return false;
        }
        state.output.push_back(frame);
        drop(state);
        self.available.notify_one();
        true
    }
}
#[derive(Clone)]
pub struct Control(Arc<Shared>);
impl Control {
    /// Request cancellation, including an encoder blocked on AU backpressure.
    /// The Capture owner still joins the worker with Capture::stop.
    pub fn stop(&self) {
        self.0.stop();
    }
    pub fn force_keyframe(&self) -> Result<()> {
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.stop, "capture stopped");
        state.force_keyframe = true;
        drop(state);
        self.0.wake();
        Ok(())
    }
    pub fn set_bitrate(&self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "bitrate must be positive");
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.stop, "capture stopped");
        state.bitrate = Some(bitrate);
        drop(state);
        self.0.wake();
        Ok(())
    }
}
pub struct Capture {
    shared: Arc<Shared>,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn start(target: Target, settings: Settings) -> Result<Self> {
        settings.validate()?;
        let shared = Arc::new(Shared::default());
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-capture".into())
            .spawn(move || {
                let result = run(target, settings, worker.clone());
                let mut state = worker.state.lock().unwrap();
                if let Err(error) = &result {
                    state.failure = Some(format!("{error:#}"));
                }
                state.stop = true;
                state.done = true;
                state.latest = None;
                state.device = None;
                state.event = None;
                drop(state);
                worker.wake();
                worker.available.notify_one();
                result
            })?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }
    pub fn control(&self) -> Control {
        Control(self.shared.clone())
    }
    pub async fn recv(&mut self) -> Option<Result<EncodedFrame>> {
        loop {
            let notified = self.shared.available.notified();
            {
                let mut state = self.shared.state.lock().unwrap();
                if let Some(frame) = state.output.pop_front() {
                    self.shared.wake();
                    return Some(Ok(frame));
                }
                if state.done {
                    return state.failure.take().map(|error| Err(anyhow!(error)));
                }
            }
            notified.await;
        }
    }
    /// Call from a blocking owner. Drop requests stop; this additionally joins
    /// the worker, which joins WGC and shuts down the hardware MFT.
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop();
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("capture worker panicked"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

fn creation_time(pid: u32) -> Result<u64> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let result = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user);
        let _ = CloseHandle(process);
        result?;
        Ok(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }
}
pub fn targets() -> Result<Vec<Target>> {
    let mut targets = Vec::new();
    for window in Window::enumerate()? {
        // Inaccessible/protected processes are not selectable input identities.
        let Ok(pid) = window.process_id() else {
            continue;
        };
        let Ok(created) = creation_time(pid) else {
            continue;
        };
        targets.push(Target {
            kind: TargetKind::Window,
            source_id: (window.as_raw_hwnd() as usize).to_string(),
            title: window.title()?,
            pid,
            creation_time: Some(created.to_string()),
        });
    }
    for monitor in Monitor::enumerate()? {
        targets.push(Target {
            kind: TargetKind::Display,
            source_id: (monitor.as_raw_hmonitor() as usize).to_string(),
            title: monitor.name()?,
            pid: 0,
            creation_time: None,
        });
    }
    Ok(targets)
}
impl TryInto<windows_capture::settings::GraphicsCaptureItemType> for Target {
    type Error = anyhow::Error;
    fn try_into(self) -> Result<windows_capture::settings::GraphicsCaptureItemType> {
        let target = self;
        let id = target
            .source_id
            .parse::<usize>()
            .context("invalid capture sourceId")?;
        ensure!(id > 0, "invalid capture sourceId");
        match target.kind {
            TargetKind::Window => {
                unsafe {
                    ensure!(
                        IsWindow(Some(HWND(id as _))).as_bool(),
                        "capture window closed"
                    );
                    let mut pid = 0;
                    GetWindowThreadProcessId(HWND(id as _), Some(&mut pid));
                    ensure!(
                        pid == target.pid && pid > 0,
                        "capture window identity changed"
                    );
                }
                let created = target
                    .creation_time
                    .as_deref()
                    .ok_or_else(|| anyhow!("missing window creationTime"))?
                    .parse::<u64>()?;
                ensure!(
                    creation_time(target.pid)? == created,
                    "capture window process replaced"
                );
                Ok(Window::from_raw_hwnd(id as _).try_into()?)
            }
            TargetKind::Display => {
                let monitor = Monitor::enumerate()?
                    .into_iter()
                    .find(|m| m.as_raw_hmonitor() as usize == id)
                    .ok_or_else(|| anyhow!("capture display removed"))?;
                Ok(monitor.try_into()?)
            }
        }
    }
}
fn run(target: Target, settings: Settings, shared: Arc<Shared>) -> Result<()> {
    let capture = Wgc::start_free_threaded(WgcSettings::new(
        target,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (shared.clone(), settings),
    ))?;
    let result = Encoder::run(&shared, settings);
    shared.state.lock().unwrap().stop = true;
    shared.wake();
    let stopped = capture.stop().map_err(|error| anyhow!("stop WGC: {error}"));
    result.and(stopped)
}
struct Wgc {
    shared: Arc<Shared>,
    settings: Settings,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    converter: Option<Converter>,
}
struct Converter {
    input_width: u32,
    input_height: u32,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
}
impl GraphicsCaptureApiHandler for Wgc {
    type Flags = (Arc<Shared>, Settings);
    type Error = anyhow::Error;
    fn new(ctx: Context<Self::Flags>) -> Result<Self> {
        unsafe {
            let _ = ctx
                .device_context
                .cast::<ID3D11Multithread>()?
                .SetMultithreadProtected(true);
        }
        ctx.flags.0.state.lock().unwrap().device = Some(ctx.device.clone());
        Ok(Self {
            shared: ctx.flags.0,
            settings: ctx.flags.1,
            device: ctx.device,
            context: ctx.device_context,
            converter: None,
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<()> {
        {
            let state = self.shared.state.lock().unwrap();
            if state.stop {
                control.stop();
                return Ok(());
            }
            let qpc = frame.timestamp()?.Duration;
            if state
                .latest
                .as_ref()
                .is_some_and(|latest| qpc - latest.qpc < 10_000_000 / self.settings.fps as i64)
            {
                return Ok(());
            }
        }
        match self.convert(frame) {
            Ok(frame) => {
                self.shared.state.lock().unwrap().latest = Some(frame);
                self.shared.wake();
            }
            Err(error) => {
                self.shared.failure(&error);
                control.stop();
            }
        }
        Ok(())
    }
    fn on_closed(&mut self) -> Result<()> {
        self.shared.state.lock().unwrap().stop = true;
        self.shared.wake();
        Ok(())
    }
}
impl Wgc {
    fn convert(&mut self, frame: &mut Frame) -> Result<RawFrame> {
        unsafe {
            let (width, height) = (self.settings.width, self.settings.height);
            let video = self.device.cast::<ID3D11VideoDevice>()?;
            let context = self.context.cast::<ID3D11VideoContext1>()?;
            if self
                .converter
                .as_ref()
                .is_none_or(|c| c.input_width != frame.width() || c.input_height != frame.height())
            {
                let enumerator =
                    video.CreateVideoProcessorEnumerator(&D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                        InputFrameRate: DXGI_RATIONAL {
                            Numerator: self.settings.fps,
                            Denominator: 1,
                        },
                        InputWidth: frame.width(),
                        InputHeight: frame.height(),
                        OutputFrameRate: DXGI_RATIONAL {
                            Numerator: self.settings.fps,
                            Denominator: 1,
                        },
                        OutputWidth: width,
                        OutputHeight: height,
                        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                    })?;
                let processor = video.CreateVideoProcessor(&enumerator, 0)?;
                context.VideoProcessorSetStreamColorSpace1(
                    &processor,
                    0,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                context.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
                );
                let source = RECT {
                    left: 0,
                    top: 0,
                    right: frame.width() as i32,
                    bottom: frame.height() as i32,
                };
                // Fit the selected source, preserving its aspect ratio across resize.
                let scale = (width as f64 / frame.width() as f64)
                    .min(height as f64 / frame.height() as f64);
                let (w, h) = (
                    (frame.width() as f64 * scale).round() as i32,
                    (frame.height() as f64 * scale).round() as i32,
                );
                let (x, y) = ((width as i32 - w) / 2, (height as i32 - h) / 2);
                let dest = RECT {
                    left: x,
                    top: y,
                    right: x + w,
                    bottom: y + h,
                };
                let output = RECT {
                    left: 0,
                    top: 0,
                    right: width as i32,
                    bottom: height as i32,
                };
                context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&source));
                context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&dest));
                context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&output));
                let mut black = D3D11_VIDEO_COLOR::default();
                black.Anonymous.RGBA.A = 1.0;
                context.VideoProcessorSetOutputBackgroundColor(&processor, false, &black);
                context.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
                self.converter = Some(Converter {
                    input_width: frame.width(),
                    input_height: frame.height(),
                    enumerator,
                    processor,
                });
            }
            let converter = self.converter.as_ref().unwrap();
            let mut texture = None;
            self.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut texture),
            )?;
            let texture = texture.unwrap();
            let mut input = None;
            video.CreateVideoProcessorInputView(
                frame.as_raw_texture(),
                &converter.enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut input),
            )?;
            let mut output = None;
            video.CreateVideoProcessorOutputView(
                &texture,
                &converter.enumerator,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut output),
            )?;
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input),
                ..Default::default()
            };
            let result = context.VideoProcessorBlt(
                &converter.processor,
                output.as_ref().unwrap(),
                0,
                std::slice::from_ref(&stream),
            );
            drop(ManuallyDrop::take(&mut stream.pInputSurface));
            result?;
            Ok(RawFrame {
                texture,
                qpc: frame.timestamp()?.Duration,
            })
        }
    }
}
