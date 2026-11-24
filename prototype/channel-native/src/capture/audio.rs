//! Event-driven WASAPI loopback. This worker owns PCM only, not its video's lifetime.
use super::{AudioCapabilities, AudioDevice, AudioFrame, CaptureClock, Target, TargetKind};
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
use windows::core::{implement, Interface, Ref, HSTRING};
use windows::Win32::{
    Foundation::{FILETIME, HANDLE, HWND, WAIT_FAILED, WAIT_OBJECT_0},
    Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, DEVINTERFACE_AUDIO_RENDER,
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
    RenderEndpoint(String),
    Microphone(String),
}
impl AudioCapture {
    #[cfg(test)]
    pub(crate) fn fixture(
        ready_now: bool,
    ) -> Result<(Self, mpsc::Sender<AudioFrame>, oneshot::Receiver<()>)> {
        Self::fixture_with_teardown(ready_now, || {})
    }
    #[cfg(test)]
    pub(crate) fn fixture_with_teardown(
        ready_now: bool,
        teardown: impl FnOnce() + Send + 'static,
    ) -> Result<(Self, mpsc::Sender<AudioFrame>, oneshot::Receiver<()>)> {
        Self::fixture_with_completion(ready_now, move || { teardown(); Ok(()) })
    }

    #[cfg(test)]
    pub(crate) fn fixture_with_completion(
        ready_now: bool,
        completion_result: impl FnOnce() -> Result<()> + Send + 'static,
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
            let _ = complete.send(completion_result());
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
        Self::start_with_exclusion(target, None, None)
    }
    pub(crate) fn start_with_exclusion(
        target: Target,
        exclude: Option<Target>,
        render_endpoint_id: Option<String>,
    ) -> Result<Self> {
        ensure!(
            exclude
                .as_ref()
                .is_none_or(|excluded| target.kind == TargetKind::Display
                    && excluded.kind == TargetKind::Window),
            "audio exclusion requires a display and a window process"
        );
        if let Some(id) = render_endpoint_id {
            ensure!(
                target.kind == TargetKind::Display && exclude.is_none(),
                "conflicting audio source"
            );
            return Self::spawn(Input::RenderEndpoint(id));
        }
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
        // Raw PCM can be dropped under backpressure; its sample positions retain the gap.
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

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct DefaultRenderActivation(std::sync::mpsc::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for DefaultRenderActivation_Impl {
    fn ActivateCompleted(
        &self,
        _: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

fn default_render_client() -> Result<AudioClient> {
    // The render interface class opts this stream into Windows' default-device routing.
    let path = HSTRING::from(format!("{{{DEVINTERFACE_AUDIO_RENDER:?}}}"));
    let (done, activation) = std::sync::mpsc::channel();
    let callback: IActivateAudioInterfaceCompletionHandler = DefaultRenderActivation(done).into();
    let operation =
        unsafe { ActivateAudioInterfaceAsync(&path, &IAudioClient::IID, None, &callback)? };
    activation.recv()?;
    let mut result = Default::default();
    let mut interface = None;
    unsafe { operation.GetActivateResult(&mut result, &mut interface)? };
    result.ok()?;
    let client = interface
        .context("missing default render audio client")?
        .cast()?;
    Ok(AudioClient::from_iaudioclient(client, Direction::Render))
}

fn client(process: Option<(u32, bool)>) -> Result<AudioClient> {
    let client = match process {
        Some((pid, include_tree)) => {
            AudioClient::new_application_loopback_client(pid, include_tree)?
        }
        None => default_render_client()?,
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

pub fn microphones() -> Result<Vec<AudioDevice>> {
    devices(Direction::Capture)
}

pub fn render_endpoints() -> Result<Vec<AudioDevice>> {
    devices(Direction::Render)
}

fn devices(direction: Direction) -> Result<Vec<AudioDevice>> {
    let _com = Com::start()?;
    DeviceEnumerator::new()?
        .get_device_collection(&direction)?
        .into_iter()
        .map(|device| {
            let device = device?;
            Ok(AudioDevice {
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

#[derive(Default)]
struct CaptureCounts {
    stream_started: bool,
    packets: u64,
    input_frames: u64,
    silent_packets: u64,
    discontinuity_packets: u64,
    timestamp_error_packets: u64,
    assembled_frames: u64,
    queued_frames: u64,
    dropped_frames: u64,
    closed_queue_frames: u64,
}

impl CaptureCounts {
    // Enable before acquisition; no sample values or source/device identities are inspected.
    fn enabled() -> Option<Self> {
        crate::diagnostics::enabled().then(Self::default)
    }
    fn packet(&mut self, frames: u32, flags: u32) {
        self.packets += 1;
        self.input_frames += u64::from(frames);
        self.silent_packets += u64::from(flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0);
        self.discontinuity_packets +=
            u64::from(flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0);
        self.timestamp_error_packets +=
            u64::from(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0);
    }
    fn delivery(
        &mut self,
        result: &std::result::Result<(), mpsc::error::TrySendError<AudioFrame>>,
    ) {
        self.assembled_frames += 1;
        match result {
            Ok(()) => self.queued_frames += 1,
            Err(mpsc::error::TrySendError::Full(_)) => self.dropped_frames += 1,
            Err(mpsc::error::TrySendError::Closed(_)) => self.closed_queue_frames += 1,
        }
    }
    fn finish(self, mode: &str, ok: bool) {
        log::warn!(target: "piik.capture", "WASAPI capture summary: mode={mode} stream_started={} result={} packets={} input_frames={} silent_packets={} discontinuity_packets={} timestamp_error_packets={} assembled_frames={} queued_frames={} dropped_frames={} closed_queue_frames={}",
            self.stream_started, if ok { "ok" } else { "error" }, self.packets, self.input_frames,
            self.silent_packets, self.discontinuity_packets, self.timestamp_error_packets,
            self.assembled_frames, self.queued_frames, self.dropped_frames, self.closed_queue_frames);
    }
}

fn run(
    input: Input,
    control: &AudioControl,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    let mode = match &input {
        Input::System(target, _) if matches!(target.kind, TargetKind::Display) => {
            "default-endpoint"
        }
        Input::System(_, true) => "process-include",
        Input::System(_, false) => "process-exclude",
        Input::RenderEndpoint(_) => "selected-endpoint",
        Input::Microphone(_) => "microphone",
    };
    let mut counts = CaptureCounts::enabled();
    let result = run_capture(input, control, frames, ready, &mut counts);
    if let Some(counts) = counts {
        counts.finish(mode, result.is_ok());
    }
    result
}

#[derive(Default)]
struct PacketAssembly {
    samples: Vec<f32>,
    first: Option<Instant>,
    next_packet: Option<Instant>,
    position: super::AudioPosition,
}

fn sample_duration(frames: usize) -> Duration {
    Duration::from_nanos(frames as u64 * 1_000_000_000 / 48_000)
}

impl PacketAssembly {
    // The non-silent buffer must contain count stereo f32 sample pairs.
    unsafe fn packet(
        &mut self,
        clock: &CaptureClock,
        data: *const u8,
        count: u32,
        flags: u32,
        timestamp: u64,
        mut deliver: impl FnMut(AudioFrame) -> bool,
    ) -> bool {
        if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
            self.samples.clear();
            self.first = None;
            self.next_packet = None;
            self.position.discontinuity();
        }
        let count = count as usize;
        let duration = sample_duration(count);
        let packet_time = if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
            clock.instant(timestamp as i64)
        } else {
            // Continue the sample clock. For an unanchored segment, estimate
            // the first sample from the current monotonic time and packet length.
            self.next_packet
                .unwrap_or_else(|| Instant::now() - duration)
        };
        self.next_packet = Some(packet_time + duration);

        for index in 0..count {
            if self.samples.is_empty() {
                self.first = Some(packet_time + sample_duration(index));
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
            self.samples.extend_from_slice(&sample);
            if self.samples.len() == 1920 {
                let frame = self.position.frame(
                    std::mem::replace(&mut self.samples, Vec::with_capacity(1920)),
                    self.first.take().unwrap(),
                );
                if deliver(frame) {
                    return true;
                }
            }
        }
        false
    }
}

fn capture_active(control: &AudioControl, process: Option<&OwnedHandle>) -> Result<bool> {
    if control.is_stopped() {
        return Ok(false);
    }
    if let Some(process) = process {
        ensure!(
            unsafe { WaitForSingleObject(HANDLE(process.as_raw_handle()), 0) } != WAIT_OBJECT_0,
            "audio process ended"
        );
    }
    Ok(true)
}

fn capture_event(client: &AudioClient) -> Result<OwnedHandle> {
    // Own the event before registration, which can fail if the endpoint disappears.
    let raw = unsafe { CreateEventW(None, false, false, None)? };
    let event = unsafe { OwnedHandle::from_raw_handle(raw.0) };
    unsafe { client.as_iaudioclient().SetEventHandle(raw)? };
    Ok(event)
}

fn run_capture(
    input: Input,
    control: &AudioControl,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
    counts: &mut Option<CaptureCounts>,
) -> Result<()> {
    let _com = Com::start()?;
    let pinned = matches!(&input, Input::RenderEndpoint(_));
    let (process, client) = match input {
        Input::System(target, include_tree) => {
            let process = process(&target)?;
            let scope = process.as_ref().map(|_| (target.pid, include_tree));
            let client = client(scope)?;
            crate::diagnostics::system_audio_source(scope);
            (process, client)
        }
        Input::RenderEndpoint(id) => {
            let device = DeviceEnumerator::new()?
                .get_device(&id)
                .context("selected render endpoint unavailable")?;
            ensure!(
                device.get_direction() == Direction::Render,
                "selected endpoint is not a render device"
            );
            (None, initialize(device.get_iaudioclient()?)?)
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
    let disconnected = if pinned {
        let raw = unsafe { CreateEventW(None, true, false, None)? };
        let signal = AudioControl(Arc::new(unsafe { OwnedHandle::from_raw_handle(raw.0) }));
        let worker_signal = signal.clone();
        let mut callbacks = wasapi::EventCallbacks::new();
        callbacks.set_disconnected_callback(move |_| worker_signal.stop());
        let registration = client
            .get_audiosessioncontrol()?
            .register_session_notification(callbacks)?;
        Some((signal, registration))
    } else {
        None
    };
    let event = capture_event(&client)?;
    // wasapi 0.26's slice reader dereferences the buffer even when SILENT is set.
    // GetBuffer's flags and timestamp belong to the original buffer, so handle it here.
    let capture: IAudioCaptureClient = unsafe { client.as_iaudioclient().GetService()? };
    let clock = CaptureClock::new()?;
    let mut handles = vec![control.handle()];
    if let Some(process) = &process {
        handles.push(HANDLE(process.as_raw_handle()));
    }
    if let Some((signal, _)) = &disconnected {
        handles.push(signal.handle());
    }
    handles.push(HANDLE(event.as_raw_handle()));
    if !capture_active(control, process.as_ref())? {
        return Ok(());
    }
    client.start_stream()?;
    if let Some(counts) = counts {
        counts.stream_started = true;
    }
    if let Some(ready) = ready.take() {
        let _ = ready.send(Ok(()));
    }
    let result = (|| {
        let mut assembly = PacketAssembly::default();
        loop {
            let signaled = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
            if signaled == WAIT_FAILED {
                return Err(windows::core::Error::from_thread().into());
            }
            if signaled == WAIT_OBJECT_0 {
                return Ok(());
            }
            if disconnected
                .as_ref()
                .is_some_and(|(signal, _)| signal.is_stopped())
            {
                anyhow::bail!("selected render endpoint unavailable");
            }
            ensure!(
                signaled.0 == WAIT_OBJECT_0.0 + handles.len() as u32 - 1,
                "audio process ended"
            );
            while unsafe { capture.GetNextPacketSize()? } > 0 {
                if !capture_active(control, process.as_ref())? {
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
                if let Some(counts) = counts {
                    counts.packet(count, flags);
                }
                let closed = unsafe {
                    assembly.packet(&clock, data, count, flags, timestamp, |frame| {
                        let result = frames.try_send(frame);
                        if let Some(counts) = counts {
                            counts.delivery(&result);
                        }
                        matches!(result, Err(mpsc::error::TrySendError::Closed(_)))
                    })
                };
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

    #[tokio::test]
    async fn missing_pinned_output_reports_failure_without_opening_default() -> Result<()> {
        let mut capture = AudioCapture::spawn(Input::RenderEndpoint(
            "piik-fixture-missing-endpoint".into(),
        ))?;
        assert!(capture
            .ready()
            .await
            .unwrap_err()
            .to_string()
            .contains("selected render endpoint unavailable"));
        assert!(capture.recv().await.unwrap().is_err());
        Ok(())
    }

    #[test]
    fn packet_drain_observes_process_exit_and_explicit_stop() -> Result<()> {
        let event = || -> Result<OwnedHandle> {
            let handle = unsafe { CreateEventW(None, true, false, None)? };
            Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
        };
        let control = AudioControl(Arc::new(event()?));
        let process = event()?;
        assert!(capture_active(&control, Some(&process))?);
        unsafe { SetEvent(HANDLE(process.as_raw_handle()))? };
        assert_eq!(
            capture_active(&control, Some(&process))
                .unwrap_err()
                .to_string(),
            "audio process ended"
        );
        control.stop();
        assert!(!capture_active(&control, Some(&process))?);
        Ok(())
    }

    #[test]
    #[ignore = "requires a Windows default render endpoint"]
    fn default_render_interface_provides_event_driven_loopback() -> Result<()> {
        let _com = Com::start()?;
        let client = client(None)?;
        let _event = capture_event(&client)?;
        let _capture: IAudioCaptureClient = unsafe { client.as_iaudioclient().GetService()? };
        Ok(())
    }

    #[test]
    fn timestamp_errors_preserve_pcm_silence_and_sample_progression() -> Result<()> {
        let clock = CaptureClock::new()?;
        let qpc = clock.now()?;
        let timestamp_error = AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32;
        let silent = AUDCLNT_BUFFERFLAGS_SILENT.0 as u32;
        let discontinuity = AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32;
        let mut assembly = PacketAssembly::default();
        let mut output = Vec::new();
        let mut packet = |value: f32, count, flags, timestamp| {
            let pcm = vec![value; count as usize * 2];
            let data = if flags & silent != 0 {
                std::ptr::null()
            } else {
                pcm.as_ptr().cast()
            };
            assert!(!unsafe {
                assembly.packet(&clock, data, count, flags, timestamp, |frame| {
                    output.push(frame);
                    false
                })
            });
        };
        packet(0.25_f32, 480, 0, qpc as u64);
        packet(0.5, 480, timestamp_error, u64::MAX);
        packet(-0.5, 480, timestamp_error, u64::MAX);
        packet(99.0, 480, timestamp_error | silent, u64::MAX);
        packet(0.75, 960, 0, (qpc + 400_000) as u64);
        packet(-0.25, 480, 0, (qpc + 600_000) as u64);
        let earliest = Instant::now() - Duration::from_millis(20);
        packet(1.0, 960, timestamp_error | discontinuity, u64::MAX);
        let latest = Instant::now() - Duration::from_millis(20);

        assert_eq!(output.len(), 4);
        for (index, (first, second)) in [(0.25, 0.5), (-0.5, 0.0), (0.75, 0.75)]
            .into_iter()
            .enumerate()
        {
            let frame = &output[index];
            assert_eq!(frame.segment, 0);
            assert_eq!(frame.sample_position, index as u64 * 960);
            assert_eq!(
                frame.presentation_time,
                clock.instant(qpc) + sample_duration(index * 960)
            );
            assert_eq!(frame.samples[..960], [first; 960]);
            assert_eq!(frame.samples[960..], [second; 960]);
        }
        let reset = &output[3];
        assert_eq!((reset.segment, reset.sample_position), (1, 0));
        assert_eq!(reset.samples, [1.0; 1920]);
        assert!((earliest..=latest).contains(&reset.presentation_time));
        Ok(())
    }

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
