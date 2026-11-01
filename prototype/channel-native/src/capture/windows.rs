//! One WGC capture publishes owned BGRA textures to independent encoding workers.
use super::{
    cadence::Cadence,
    frames::{RawFrame, Shared},
    process::Encoding,
    Control, FrameTiming, Frames, Settings, Target, TargetKind,
};
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{os::windows::io::AsRawHandle, sync::Arc, thread};
use windows::{
    core::Interface,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, HWND},
        Graphics::{Direct3D11::*, Dxgi::Common::*},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    },
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings as WgcSettings,
    },
    window::Window,
};

pub struct Capture {
    frames: Frames,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn audio(&self, target: Target) -> Result<super::AudioCapture> {
        super::AudioCapture::start(target)
    }

    pub fn start(target: Target, fps: u32, _audio: bool) -> Result<Self> {
        ensure!(fps > 0, "capture fps must be positive");
        let frames = Frames::new(FrameTiming::Capture)?;
        let worker = frames.shared.clone();
        let thread = thread::Builder::new()
            .name("piik-capture".into())
            .spawn(move || {
                let result = run(target, fps, worker.clone());
                worker.stop(result.as_ref().err().map(|error| format!("{error:#}")));
                result
            })?;
        Ok(Self {
            frames,
            thread: Some(thread),
        })
    }
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        self.frames.encode(settings)
    }
    pub fn control(&self) -> Control {
        self.frames.control()
    }
    /// Call from a blocking owner. Stop all outputs and join WGC; each Encoding
    /// remains responsible for joining its own converter/MFT worker.
    pub fn stop(mut self) -> Result<()> {
        self.frames.finish(None);
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("capture worker panicked"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.frames.finish(None);
        if let Some(thread) = self.thread.take() {
            match thread.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("Native WGC cleanup failed: {error:#}"),
                Err(_) => eprintln!("Native WGC worker panicked"),
            }
        }
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
        let title = window.title()?;
        if title.trim().is_empty() {
            continue;
        }
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
            title,
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
            TargetKind::Picker => Err(anyhow!("system picker target unavailable")),
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
fn run(target: Target, fps: u32, shared: Arc<Shared>) -> Result<()> {
    let capture = Wgc::start_free_threaded(WgcSettings::new(
        target,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (shared.clone(), fps),
    ))?;
    let halt = capture.halt_handle();
    let callback = capture.callback();
    let thread = capture.into_thread_handle();
    // A handler error ends the library thread without setting our Stop flag.
    // Observe both lifetimes, then let the library stop and join its own worker.
    let waited = shared.wait_for_stop_or(HANDLE(thread.as_raw_handle()));
    let capture = CaptureControl::new(thread, halt, callback);
    let stopped = capture.stop().map_err(|error| anyhow!("stop WGC: {error}"));
    waited?;
    let failure = shared.state.lock().unwrap().failure.clone();
    if let Some(failure) = failure {
        return Err(anyhow!(failure));
    }
    stopped
}
struct Wgc {
    shared: Arc<Shared>,
    cadence: Cadence,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}
impl GraphicsCaptureApiHandler for Wgc {
    type Flags = (Arc<Shared>, u32);
    type Error = anyhow::Error;
    fn new(ctx: Context<Self::Flags>) -> Result<Self> {
        unsafe {
            let _ = ctx
                .device_context
                .cast::<ID3D11Multithread>()?
                .SetMultithreadProtected(true);
        }
        Ok(Self {
            shared: ctx.flags.0,
            cadence: Cadence::new(ctx.flags.1),
            device: ctx.device,
            context: ctx.device_context,
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<()> {
        let qpc = frame.timestamp()?.Duration;
        {
            let state = self.shared.state.lock().unwrap();
            if state.stop {
                control.stop();
                return Ok(());
            }
        }
        if !self.cadence.accept(qpc) {
            return Ok(());
        }
        match self.copy(frame, qpc) {
            Ok(frame) => self.shared.publish(frame),
            Err(error) => {
                self.shared.stop(Some(format!("{error:#}")));
                control.stop();
            }
        }
        Ok(())
    }
    fn on_closed(&mut self) -> Result<()> {
        self.shared.stop(None);
        Ok(())
    }
}
impl Wgc {
    fn copy(&self, frame: &Frame, qpc: i64) -> Result<RawFrame> {
        unsafe {
            // WGC reuses its frame-pool surfaces. Copy once before returning the
            // callback; every encoder may then retain this immutable GPU texture.
            let mut texture = None;
            self.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: frame.width(),
                    Height: frame.height(),
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    ..Default::default()
                },
                None,
                Some(&mut texture),
            )?;
            let texture = texture.unwrap();
            self.context.CopySubresourceRegion(
                &texture,
                0,
                0,
                0,
                0,
                frame.as_raw_texture(),
                0,
                Some(&D3D11_BOX {
                    right: frame.width(),
                    bottom: frame.height(),
                    back: 1,
                    ..Default::default()
                }),
            );
            Ok(RawFrame { texture, qpc })
        }
    }
}
