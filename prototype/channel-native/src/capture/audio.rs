//! Event-driven WASAPI loopback. This worker owns PCM only, not its video's lifetime.
use super::{AudioCapabilities, AudioFrame, CaptureClock, MicrophoneDevice, Target, TargetKind};
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Arc,
    thread,
};
use tokio::sync::{mpsc, oneshot};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
use windows::Win32::{
    Foundation::{FILETIME, HANDLE, HWND, WAIT_FAILED, WAIT_OBJECT_0},
    Media::Audio::{
        IAudioCaptureClient, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
        AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR,
    },
    System::Threading::{
        CreateEventW, GetProcessTimes, OpenProcess, SetEvent, WaitForMultipleObjects,
        WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    },
    UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
};

#[derive(Clone)]
pub struct AudioControl(Arc<OwnedHandle>);
impl AudioControl {
    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }
    pub fn stop(&self) {
        let _ = unsafe { SetEvent(self.handle()) };
    }
    pub fn is_stopped(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle(), 0) == WAIT_OBJECT_0 }
    }
}

pub struct AudioCapture {
    control: AudioControl,
    ready: Option<oneshot::Receiver<Result<()>>>,
    frames: mpsc::Receiver<AudioFrame>,
    completion: Option<oneshot::Receiver<Result<()>>>,
    thread: Option<thread::JoinHandle<()>>,
}
enum Input {
    System(Target, bool),
    Microphone(String),
}
impl AudioCapture {
    #[cfg(test)]
    pub(crate) fn fixture(
        ready_now: bool,
    ) -> Result<(Self, mpsc::Sender<AudioFrame>, oneshot::Receiver<()>)> {
        let event = unsafe { CreateEventW(None, true, false, None)? };
        let control = AudioControl(Arc::new(unsafe { OwnedHandle::from_raw_handle(event.0) }));
        let worker = control.clone();
        let (frames, receiver) = mpsc::channel(2);
        let (ready, started) = oneshot::channel();
        let (complete, completion) = oneshot::channel();
        let (joined, finished) = oneshot::channel();
        let thread = thread::spawn(move || {
            let mut ready = Some(ready);
            if ready_now {
                let _ = ready.take().unwrap().send(Ok(()));
            }
            unsafe {
                WaitForSingleObject(worker.handle(), INFINITE);
            }
            if let Some(ready) = ready {
                let _ = ready.send(Err(anyhow!("candidate cancelled")));
            }
            let _ = complete.send(Ok(()));
            let _ = joined.send(());
        });
        Ok((
            Self {
                control,
                ready: Some(started),
                frames: receiver,
                completion: Some(completion),
                thread: Some(thread),
            },
            frames,
            finished,
        ))
    }
    pub fn start(target: Target) -> Result<Self> {
        Self::start_with_exclusion(target, None)
    }
    pub(crate) fn start_with_exclusion(target: Target, exclude: Option<Target>) -> Result<Self> {
        ensure!(
            exclude
                .as_ref()
                .is_none_or(|excluded| target.kind == TargetKind::Display
                    && excluded.kind == TargetKind::Window),
            "audio exclusion requires a display and a window process"
        );
        let include_tree = exclude.is_none();
        let target = exclude.unwrap_or(target);
        Self::spawn(Input::System(target, include_tree))
    }
    pub fn microphone(device_id: String) -> Result<Self> {
        Self::spawn(Input::Microphone(device_id))
    }
    fn spawn(input: Input) -> Result<Self> {
        let event = unsafe { CreateEventW(None, true, false, None)? };
        let control = AudioControl(Arc::new(unsafe { OwnedHandle::from_raw_handle(event.0) }));
        let worker = control.clone();
        // Raw PCM can be dropped under backpressure; its capture timestamps retain the gap.
        let (frames, receiver) = mpsc::channel(2);
        let (ready, started) = oneshot::channel();
        let (complete, completion) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("piik-audio".into())
            .spawn(move || {
                let mut ready = Some(ready);
                let result = run(input, &worker, frames, &mut ready);
                if let Some(ready) = ready {
                    let error = result
                        .as_ref()
                        .err()
                        .map(|error| format!("{error:#}"))
                        .unwrap_or_else(|| "audio capture stopped before startup".into());
                    let _ = ready.send(Err(anyhow!(error)));
                }
                worker.stop();
                let _ = complete.send(result);
            })?;
        Ok(Self {
            control,
            ready: Some(started),
            frames: receiver,
            completion: Some(completion),
            thread: Some(thread),
        })
    }
    /// Activation/Start succeeds even when the selected process is silent.
    pub async fn ready(&mut self) -> Result<()> {
        self.ready
            .take()
            .context("audio startup already observed")?
            .await
            .context("audio worker ended before startup")?
    }
    pub fn control(&self) -> AudioControl {
        self.control.clone()
    }
    pub async fn recv(&mut self) -> Option<Result<AudioFrame>> {
        if let Some(frame) = self.frames.recv().await {
            return Some(Ok(frame));
        }
        let result = self
            .completion
            .as_mut()?
            .await
            .context("audio capture worker ended without completion")
            .and_then(|result| result);
        self.completion = None;
        result.err().map(Err)
    }
    /// Call from a blocking owner. Drop requests stop; this also joins the worker.
    pub fn stop(mut self) -> Result<()> {
        self.control.stop();
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow!("audio capture worker panicked"))?;
        }
        if let Some(completion) = self.completion.take() {
            completion
                .blocking_recv()
                .context("audio capture worker ended without completion")??;
        }
        Ok(())
    }
}
impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.control.stop();
    }
}
struct Com;
impl Com {
    fn start() -> Result<Self> {
        wasapi::initialize_mta().ok()?;
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

fn client(process: Option<(u32, bool)>) -> Result<AudioClient> {
    let client = match process {
        Some((pid, include_tree)) => {
            AudioClient::new_application_loopback_client(pid, include_tree)?
        }
        None => DeviceEnumerator::new()?
            .get_default_device(&Direction::Render)?
            .get_iaudioclient()?,
    };
    initialize(client)
}

fn initialize(mut client: AudioClient) -> Result<AudioClient> {
    client.initialize_client(
        &WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None),
        &Direction::Capture,
        &StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
        },
    )?;
    Ok(client)
}

pub fn microphones() -> Result<Vec<MicrophoneDevice>> {
    let _com = Com::start()?;
    DeviceEnumerator::new()?
        .get_device_collection(&Direction::Capture)?
        .into_iter()
        .map(|device| {
            let device = device?;
            Ok(MicrophoneDevice {
                id: device.get_id()?,
                label: device.get_friendlyname()?,
            })
        })
        .collect()
}

/// Probe the actual APIs without starting a stream or reading any audio.
/// The caller should run this blocking refresh away from its signaling actor.
pub fn audio_capabilities() -> AudioCapabilities {
    thread::spawn(|| {
        let Ok(_com) = Com::start() else {
            return AudioCapabilities::default();
        };
        AudioCapabilities {
            process_audio: client(Some((std::process::id(), true))).is_ok(),
            process_audio_exclusion: client(Some((std::process::id(), false))).is_ok(),
            system_audio: client(None).is_ok(),
        }
    })
    .join()
    .unwrap_or_default()
}

/// Hold the selected process itself, so process exit ends this capture rather
/// than allowing a recycled PID to acquire the sound grant.
fn process(target: &Target) -> Result<Option<OwnedHandle>> {
    if matches!(target.kind, TargetKind::Display) {
        return Ok(None);
    }
    let hwnd = HWND(target.source_id.parse::<usize>()? as _);
    unsafe {
        ensure!(IsWindow(Some(hwnd)).as_bool(), "audio window closed");
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        ensure!(
            pid > 0 && pid == target.pid,
            "audio window identity changed"
        );
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )?;
        let owned = OwnedHandle::from_raw_handle(handle.0);
        let (mut created, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user)?;
        let expected = target
            .creation_time
            .as_deref()
            .context("missing window creationTime")?
            .parse::<u64>()?;
        ensure!(
            ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64 == expected,
            "audio window process replaced"
        );
        ensure!(
            WaitForSingleObject(handle, 0) != WAIT_OBJECT_0,
            "audio process ended"
        );
        Ok(Some(owned))
    }
}

fn run(
    input: Input,
    control: &AudioControl,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    let _com = Com::start()?;
    let (process, client) = match input {
        Input::System(target, include_tree) => {
            let process = process(&target)?;
            let client = client(process.as_ref().map(|_| (target.pid, include_tree)))?;
            (process, client)
        }
        Input::Microphone(id) => {
            let devices = DeviceEnumerator::new()?;
            let device = if id.is_empty() {
                devices.get_default_device(&Direction::Capture)?
            } else {
                devices.get_device(&id)?
            };
            (None, initialize(device.get_iaudioclient()?)?)
        }
    };
    let event = client.set_get_eventhandle()?;
    // wasapi 0.26's slice reader dereferences the buffer even when SILENT is set.
    // GetBuffer's flags and timestamp belong to the original buffer, so handle it here.
    let capture: IAudioCaptureClient = unsafe { client.as_iaudioclient().GetService()? };
    let clock = CaptureClock::new()?;
    let mut handles = vec![control.handle(), event.as_handle()];
    if let Some(process) = &process {
        handles.push(HANDLE(process.as_raw_handle()));
    }
    if control.is_stopped() {
        return Ok(());
    }
    client.start_stream()?;
    if let Some(ready) = ready.take() {
        let _ = ready.send(Ok(()));
    }
    let result = (|| {
        let mut samples = Vec::with_capacity(1920);
        let mut first = None;
        loop {
            let signaled = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
            if signaled == WAIT_FAILED {
                return Err(windows::core::Error::from_thread().into());
            }
            if signaled == WAIT_OBJECT_0 {
                return Ok(());
            }
            ensure!(signaled.0 == WAIT_OBJECT_0.0 + 1, "audio process ended");
            while unsafe { capture.GetNextPacketSize()? } > 0 {
                if control.is_stopped() {
                    return Ok(());
                }
                let (mut data, mut count, mut flags, mut timestamp) =
                    (std::ptr::null_mut(), 0, 0, 0);
                unsafe {
                    capture.GetBuffer(
                        &mut data,
                        &mut count,
                        &mut flags,
                        None,
                        Some(&mut timestamp),
                    )?
                };
                if flags
                    & (AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0
                        | AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0) as u32
                    != 0
                {
                    samples.clear();
                    first = None;
                }
                let mut closed = false;
                if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                    for index in 0..count as usize {
                        if samples.is_empty() {
                            first = Some(
                                clock.instant(timestamp as i64)
                                    + std::time::Duration::from_nanos(
                                        index as u64 * 1_000_000_000 / 48_000,
                                    ),
                            );
                        }
                        let sample = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                            [0.0, 0.0]
                        } else {
                            unsafe {
                                [
                                    data.cast::<f32>().add(index * 2).read_unaligned(),
                                    data.cast::<f32>().add(index * 2 + 1).read_unaligned(),
                                ]
                            }
                        };
                        samples.extend_from_slice(&sample);
                        if samples.len() == 1920 {
                            let frame = AudioFrame {
                                samples: std::mem::replace(&mut samples, Vec::with_capacity(1920)),
                                presentation_time: first.take().unwrap(),
                            };
                            match frames.try_send(frame) {
                                Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    closed = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                unsafe { capture.ReleaseBuffer(count)? };
                if closed {
                    return Ok(());
                }
            }
        }
    })();
    result.and(client.stop_stream().map_err(Into::into))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a running Windows audio service"]
    fn actual_process_loopback_supports_include_and_exclude_modes() -> Result<()> {
        let _com = Com::start()?;
        let pid = std::process::id();
        client(Some((pid, true)))?;
        client(Some((pid, false)))?;
        let capability = audio_capabilities();
        ensure!(
            capability.process_audio && capability.process_audio_exclusion,
            "independent process-loopback activation probes disagree"
        );
        eprintln!(
            "WASAPI process loopback: include=true exclude=true; no stream started or PCM read"
        );
        Ok(())
    }
}
