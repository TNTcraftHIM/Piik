//! One WGC capture publishes owned BGRA textures to independent encoding workers.
use super::{
    cadence::Cadence,
    process::{self, Encoding},
    CaptureClock, Settings, Target, TargetKind,
};
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{
    sync::{Arc, Condvar, Mutex, Weak},
    thread,
};
use tokio::sync::Notify;
use windows::{
    core::Interface,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HWND},
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

#[derive(Clone)]
pub(super) struct RawFrame {
    pub texture: ID3D11Texture2D,
    pub qpc: i64,
}
#[derive(Default)]
struct State {
    stop: bool,
    failure: Option<String>,
    latest: Option<RawFrame>,
    encodings: Vec<Weak<process::Shared>>,
}
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    stopped: Notify,
}
impl Shared {
    fn stop(&self, failure: Option<String>) {
        let mut state = self.state.lock().unwrap();
        if failure.is_some() {
            state.failure = failure;
        }
        state.stop = true;
        state.latest = None;
        let failure = state.failure.clone();
        for encoding in state.encodings.drain(..).filter_map(|weak| weak.upgrade()) {
            encoding.stop(failure.as_deref());
        }
        drop(state);
        self.changed.notify_all();
        self.stopped.notify_waiters();
    }
    fn publish(&self, frame: RawFrame) {
        let mut state = self.state.lock().unwrap();
        if state.stop {
            return;
        }
        state.latest = Some(frame.clone());
        state.encodings.retain(|weak| {
            weak.upgrade()
                .is_some_and(|encoding| encoding.input(frame.clone()))
        });
    }
}
#[derive(Clone)]
pub struct Control(Arc<Shared>);
impl Control {
    pub fn is_stopped(&self) -> bool {
        self.0.state.lock().unwrap().stop
    }
    /// Stop WGC and wake every encoding, including workers blocked on AU output.
    /// Their respective Capture/Encoding owners still join the workers.
    pub fn stop(&self) {
        self.0.stop(None);
    }
    pub async fn stopped(&self) {
        loop {
            let stopped = self.0.stopped.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if self.is_stopped() {
                return;
            }
            stopped.await;
        }
    }
}
pub struct Capture {
    shared: Arc<Shared>,
    pub(super) clock: CaptureClock,
    thread: Option<thread::JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn audio(&self, target: Target) -> Result<super::AudioCapture> {
        super::AudioCapture::start(target)
    }

    pub fn start(target: Target, fps: u32) -> Result<Self> {
        ensure!(fps > 0, "capture fps must be positive");
        let clock = CaptureClock::new()?;
        let shared = Arc::new(Shared::default());
        let worker = shared.clone();
        let thread = thread::Builder::new()
            .name("piik-capture".into())
            .spawn(move || {
                let result = run(target, fps, worker.clone());
                worker.stop(result.as_ref().err().map(|error| format!("{error:#}")));
                result
            })?;
        Ok(Self {
            shared,
            clock,
            thread: Some(thread),
        })
    }
    /// Allocate one independent encoder. Initialization failures arrive through recv().
    pub fn encode(&self, settings: Settings) -> Result<Encoding> {
        settings.validate()?;
        let mut state = self.shared.state.lock().unwrap();
        ensure!(!state.stop, "capture stopped");
        state
            .encodings
            .retain(|weak| weak.upgrade().is_some_and(|encoding| !encoding.stopped()));
        let encoding = Encoding::start(settings, self.clock, state.latest.clone())?;
        state.encodings.push(Arc::downgrade(&encoding.shared));
        Ok(encoding)
    }
    pub fn control(&self) -> Control {
        Control(self.shared.clone())
    }
    /// Call from a blocking owner. Stop all outputs and join WGC; each Encoding
    /// remains responsible for joining its own converter/MFT worker.
    pub fn stop(mut self) -> Result<()> {
        self.shared.stop(None);
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| anyhow!("capture worker panicked"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.stop(None);
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
    let failure = {
        let mut state = shared.state.lock().unwrap();
        while !state.stop {
            state = shared.changed.wait(state).unwrap();
        }
        state.failure.clone()
    };
    let stopped = capture.stop().map_err(|error| anyhow!("stop WGC: {error}"));
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
