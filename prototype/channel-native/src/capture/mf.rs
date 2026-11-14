//! One hardware MFT worker; capture clocks and feed lifetime retain their owners.
use super::{
    adaptation::{Input, QualityPolicy},
    cadence::{AdmissionRate, Cadence},
    converter::Converter,
    frame_dropper::FrameDropper,
    frames::RawFrame,
    mf_common::{media_type, normalize_level_1b, Com},
    output::Shared,
    qp, CaptureClock, FrameTiming, Settings, VideoCodec,
};
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{mem::ManuallyDrop, ptr, sync::Arc, time::Instant};
use windows::{
    core::{implement, IUnknown, Interface, Ref},
    Win32::{
        Foundation::E_NOTIMPL,
        Graphics::{
            Direct3D11::{ID3D11Device, ID3D11Texture2D, D3D11_TEXTURE2D_DESC},
            Dxgi::IDXGIDevice,
        },
        Media::MediaFoundation::*,
        System::{Com::CoTaskMemFree, Variant::VARIANT},
    },
};
#[implement(IMFAsyncCallback)]
struct Events {
    generator: IMFMediaEventGenerator,
    shared: Arc<Shared>,
}
impl IMFAsyncCallback_Impl for Events_Impl {
    fn GetParameters(&self, _: *mut u32, _: *mut u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Invoke(&self, result: Ref<IMFAsyncResult>) -> windows::core::Result<()> {
        let event = unsafe {
            self.generator.EndGetEvent(result.ok()?).and_then(|event| {
                event.GetStatus()?.ok()?;
                event.GetType()
            })
        };
        self.shared.state.lock().unwrap().event = Some(event);
        self.shared.wake();
        Ok(())
    }
}
pub(super) struct Encoder {
    activate: IMFActivate,
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    callback: IMFAsyncCallback,
    api: ICodecAPI,
    info: MFT_OUTPUT_STREAM_INFO,
    qp: qp::H264,
    _manager: IMFDXGIDeviceManager,
    _com: Com,
}
impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.activate.ShutdownObject();
        }
    }
}
fn set_format(transform: &IMFTransform, settings: Settings) -> Result<MFT_OUTPUT_STREAM_INFO> {
    unsafe {
        let output = media_type(&MFVideoFormat_H264, settings)?;
        output.SetUINT32(&MF_MT_AVG_BITRATE, settings.bitrate)?;
        output.SetUINT32(
            &MF_MT_MPEG2_PROFILE,
            eAVEncH264VProfile_ConstrainedBase.0 as u32,
        )?;
        transform.SetOutputType(0, &output, 0)?;
        transform.SetInputType(0, &media_type(&MFVideoFormat_NV12, settings)?, 0)?;
        Ok(transform.GetOutputStreamInfo(0)?)
    }
}

fn fitted(settings: Settings, frame: &RawFrame) -> Settings {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { frame.texture.GetDesc(&mut desc) };
    settings.fitted(desc.Width as f64, desc.Height as f64)
}

impl Encoder {
    fn new(device: &ID3D11Device, settings: Settings, shared: Arc<Shared>) -> Result<Self> {
        unsafe {
            let com = Com::start()?;
            let adapter = device.cast::<IDXGIDevice>()?.GetAdapter()?.GetDesc()?;
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1)?;
            let attributes = attributes.unwrap();
            attributes.SetBlob(
                &MFT_ENUM_ADAPTER_LUID,
                std::slice::from_raw_parts(
                    (&adapter.AdapterLuid as *const _) as *const u8,
                    std::mem::size_of_val(&adapter.AdapterLuid),
                ),
            )?;
            let input = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_NV12,
            };
            let output = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };
            let mut list: *mut Option<IMFActivate> = ptr::null_mut();
            let mut count = 0;
            MFTEnum2(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&input),
                Some(&output),
                &attributes,
                &mut list,
                &mut count,
            )?;
            if count == 0 {
                CoTaskMemFree(Some(list as _));
                return Err(anyhow!("capture adapter has no hardware H264 encoder"));
            }
            let entries = std::slice::from_raw_parts_mut(list, count as usize);
            let activate = entries[0].take().unwrap();
            for entry in entries {
                drop(entry.take());
            }
            CoTaskMemFree(Some(list as _));
            let transform: IMFTransform = activate.ActivateObject()?;
            // Until the Encoder owner is complete, every failed initialization still
            // shuts down the activated asynchronous MFT before MF/COM are released.
            let result = (|| -> Result<_> {
                transform
                    .GetAttributes()?
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                let mut token = 0;
                let mut manager = None;
                MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                let manager = manager.unwrap();
                manager.ResetDevice(device, token)?;
                transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
                let api = transform.cast::<ICodecAPI>()?;
                api.SetValue(
                    &CODECAPI_AVEncCommonRateControlMode,
                    &VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
                )?;
                api.SetValue(
                    &CODECAPI_AVEncCommonMeanBitRate,
                    &VARIANT::from(settings.bitrate),
                )?;
                let info = set_format(&transform, settings)?;
                let events = transform.cast::<IMFMediaEventGenerator>()?;
                let callback: IMFAsyncCallback = Events {
                    generator: events.clone(),
                    shared,
                }
                .into();
                events.BeginGetEvent(&callback, None::<&IUnknown>)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                Ok((api, manager, info, events, callback))
            })();
            match result {
                Ok((api, manager, info, events, callback)) => Ok(Self {
                    activate,
                    transform,
                    api,
                    info,
                    events,
                    callback,
                    qp: qp::H264::default(),
                    _manager: manager,
                    _com: com,
                }),
                Err(error) => {
                    let _ = activate.ShutdownObject();
                    Err(error)
                }
            }
        }
    }
    // Chromium MFVEA keeps media-type FPS fixed and compensates the hardware
    // bitrate in both directions instead of restarting for cadence changes:
    // https://chromium.googlesource.com/chromium/src/+/6ffa76bb4156526eb14d582183f2bd725e3cd262/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc#119
    fn bitrate(&self, bitrate: u32, configured_fps: u32, input_fps: u32) -> Result<()> {
        let adjusted = (u64::from(bitrate) * u64::from(configured_fps) / u64::from(input_fps))
            .clamp(1, u64::from(u32::MAX)) as u32;
        unsafe {
            self.api
                .SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(adjusted))
                .context("hardware H264 live bitrate")
        }
    }

    /// Called only after DrainComplete has delivered every old-format output.
    fn resize(&mut self, settings: Settings, input_fps: u32) -> Result<()> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
            self.transform.SetInputType(0, None::<&IMFMediaType>, 0)?;
            self.transform.SetOutputType(0, None::<&IMFMediaType>, 0)?;
            self.info = set_format(&self.transform, settings)?;
            self.bitrate(settings.bitrate, settings.fps, input_fps)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        }
        Ok(())
    }

    fn input(
        &self,
        texture: &ID3D11Texture2D,
        pts: i64,
        duration: i64,
        force: bool,
        discontinuity: bool,
    ) -> Result<()> {
        unsafe {
            if force {
                self.api
                    .SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32))?;
            }
            let sample = MFCreateSample()?;
            sample.AddBuffer(&MFCreateDXGISurfaceBuffer(
                &ID3D11Texture2D::IID,
                texture,
                0,
                false,
            )?)?;
            sample.SetSampleTime(pts)?;
            sample.SetSampleDuration(duration)?;
            if discontinuity {
                sample.SetUINT32(&MFSampleExtension_Discontinuity, 1)?;
            }
            self.transform
                .ProcessInput(0, &sample, 0)
                .context("hardware H264 ProcessInput")?;
            Ok(())
        }
    }
    fn output(&self) -> Result<(Vec<u8>, i64, bool)> {
        unsafe {
            let mut buffer = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(None),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            };
            if self.info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                let sample = MFCreateSample()?;
                sample.AddBuffer(&MFCreateMemoryBuffer(self.info.cbSize)?)?;
                buffer.pSample = ManuallyDrop::new(Some(sample));
            }
            let mut status = 0;
            let result =
                self.transform
                    .ProcessOutput(0, std::slice::from_mut(&mut buffer), &mut status);
            let sample = ManuallyDrop::take(&mut buffer.pSample);
            drop(ManuallyDrop::take(&mut buffer.pEvents));
            result.context("hardware H264 ProcessOutput")?;
            let sample = sample.ok_or_else(|| anyhow!("hardware H264 omitted output sample"))?;
            let pts = sample.GetSampleTime()?;
            let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut p = ptr::null_mut();
            let mut size = 0;
            buffer.Lock(&mut p, None, Some(&mut size))?;
            let mut bytes = std::slice::from_raw_parts(p, size as usize).to_vec();
            buffer.Unlock()?;
            ensure!(
                bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]),
                "hardware encoder did not emit Annex B"
            );
            normalize_level_1b(&mut bytes);
            Ok((bytes, pts, keyframe))
        }
    }
    pub fn run(
        shared: &Arc<Shared>,
        settings: Settings,
        clock: CaptureClock,
        timing: super::FrameTiming,
    ) -> Result<()> {
        let (device, mut current) = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.stop {
                    return Ok(());
                }
                if let Some(frame) = &state.latest {
                    break (
                        unsafe { frame.texture.GetDevice()? },
                        fitted(settings, frame),
                    );
                }
                shared.request_frame(&mut state);
                state = shared.changed.wait(state).unwrap();
            }
        };
        let mut encoder = Self::new(&device, current, shared.clone())?;
        let mut converter = Converter::new(&device, current)?;
        let mut need_input = 0;
        let mut resizing = false;
        let mut discontinuity = false;
        let mut last_capture = None;
        let mut origin: Option<i64> = None;
        let mut last_pts = -1;
        let started = Instant::now();
        let mut rate_control_fps = current.fps;
        let mut last_rate_update_ms = 0;
        let mut policy = QualityPolicy::new(VideoCodec::H264, settings.degradation_preference, 0);
        let requested_max = (timing == FrameTiming::Capture).then_some(settings.fps);
        let mut frame_limit = requested_max;
        let mut cadence = Cadence::new(settings.fps);
        let mut dropper = FrameDropper::new();
        let mut admission_rate = AdmissionRate::default();
        let mut target_kbps = settings.bitrate as f32 / 1000.0;
        dropper.set_rates(target_kbps, 0.0);
        enum Work {
            Stop,
            Event(windows::core::Result<u32>),
            Bitrate(u32),
            Frame(RawFrame, bool),
        }
        loop {
            let work = {
                let mut state = shared.state.lock().unwrap();
                loop {
                    if state.stop {
                        break Work::Stop;
                    }
                    if let Some(event) = state.event.take() {
                        break Work::Event(event);
                    }
                    if let Some(bitrate) = state.bitrate.take() {
                        break Work::Bitrate(bitrate);
                    }
                    if !resizing && need_input > 0 {
                        if let Some(raw) = &state.latest {
                            if match timing {
                                super::FrameTiming::Capture => {
                                    state.force_keyframe
                                        || (last_capture != Some(raw.qpc)
                                            && cadence.accept(raw.qpc))
                                }
                                super::FrameTiming::Source => {
                                    last_capture != Some(raw.qpc)
                                        && origin.is_none_or(|first| raw.qpc - first > last_pts)
                                        && (state.force_keyframe
                                            || frame_limit.is_none_or(|_| cadence.accept(raw.qpc)))
                                }
                            } {
                                let frame = raw.clone();
                                let (next, deferred) = shared.defer_force(
                                    state,
                                    clock,
                                    timing,
                                    frame.qpc,
                                    origin.map(|first| first + last_pts),
                                )?;
                                state = next;
                                if deferred {
                                    continue;
                                }
                                let force = std::mem::take(&mut state.force_keyframe);
                                break Work::Frame(frame, force);
                            }
                        }
                        shared.request_frame(&mut state);
                    }
                    state = shared.changed.wait(state).unwrap();
                }
            };
            policy.tick(
                started.elapsed().as_millis() as u64,
                Input {
                    pixels: current.width * current.height,
                    fps: admission_rate.fps.unwrap_or(0.0).round() as u32,
                },
            );
            let next_limit = policy.restrictions().frame_rate_limit(requested_max);
            if next_limit != frame_limit {
                frame_limit = next_limit;
                cadence = Cadence::new(frame_limit.unwrap_or(settings.fps));
                admission_rate = AdmissionRate::default();
            }
            match work {
                Work::Stop => break,
                Work::Bitrate(bitrate) => {
                    encoder.bitrate(bitrate, current.fps, rate_control_fps)?;
                    target_kbps = bitrate as f32 / 1000.0;
                    current.bitrate = bitrate;
                    dropper.set_rates(target_kbps, admission_rate.fps.unwrap_or(0.0));
                }
                Work::Event(event) => {
                    let kind = event?;
                    unsafe {
                        // Exactly one outstanding event request; no unbounded event queue.
                        encoder
                            .events
                            .BeginGetEvent(&encoder.callback, None::<&IUnknown>)?;
                        if kind == METransformNeedInput.0 as u32 {
                            if !resizing {
                                need_input += 1;
                            }
                        } else if kind == METransformHaveOutput.0 as u32 {
                            let (bytes, pts, keyframe) = encoder.output()?;
                            let qp = encoder.qp.parse(&bytes);
                            policy.report_encoded(qp, started.elapsed().as_micros() as u64);
                            dropper.fill(bytes.len(), !keyframe);
                            let presentation_time = clock.instant(origin.unwrap() + pts);
                            if !shared.output(EncodedFrame {
                                vp8: None,
                                bytes,
                                presentation_time,
                                keyframe,
                            }) {
                                break;
                            }
                        } else if kind == METransformDrainComplete.0 as u32 && resizing {
                            let next = {
                                let mut state = shared.state.lock().unwrap();
                                let Some(frame) = &state.latest else { break };
                                let next = policy.restrictions().apply(
                                    fitted(
                                        Settings {
                                            bitrate: current.bitrate,
                                            ..settings
                                        },
                                        frame,
                                    ),
                                    requested_max,
                                );
                                state.force_keyframe = true;
                                next
                            };
                            current.width = next.width;
                            current.height = next.height;
                            encoder
                                .resize(current, rate_control_fps)
                                .context("hardware H264 resize")?;
                            converter = Converter::new(&device, current)?;
                            resizing = false;
                            discontinuity = true;
                        }
                    }
                }
                Work::Frame(frame, force) => {
                    let next = policy.restrictions().apply(
                        fitted(
                            Settings {
                                bitrate: current.bitrate,
                                ..settings
                            },
                            &frame,
                        ),
                        requested_max,
                    );
                    if (next.width, next.height) != (current.width, current.height) {
                        // The raw slot retains the latest source during the drain;
                        // old access units keep their order and the same clock.
                        resizing = true;
                        need_input = 0;
                        unsafe {
                            encoder
                                .transform
                                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?
                        };
                        continue;
                    }
                    let repeated = last_capture == Some(frame.qpc);
                    last_capture = Some(frame.qpc);
                    let mut qpc = frame.qpc;
                    if timing == super::FrameTiming::Capture
                        && (repeated
                            || (force && origin.is_some_and(|first| qpc - first <= last_pts)))
                    {
                        qpc = clock.now()?;
                    }
                    let first = *origin.get_or_insert(qpc);
                    let pts = qpc - first;
                    // A WGC frame already in flight when a static IDR was requested
                    // may precede its presentation time; raw frames are replaceable.
                    if pts <= last_pts {
                        continue;
                    }
                    // Cadence has already admitted this raw frame. A skipped
                    // candidate still counts as input, never as encoded output.
                    if !repeated {
                        if let Some(fps) = admission_rate.observe(frame.qpc) {
                            let now_ms = started.elapsed().as_millis() as u64;
                            if now_ms - last_rate_update_ms >= 1_000 {
                                last_rate_update_ms = now_ms;
                                let measured_fps = fps.round() as u32;
                                if measured_fps > 0 && measured_fps != rate_control_fps {
                                    encoder.bitrate(current.bitrate, current.fps, measured_fps)?;
                                    rate_control_fps = measured_fps;
                                }
                            }
                            dropper.set_rates(target_kbps, fps);
                            dropper.leak(fps.round() as u32);
                            let dropped = dropper.drop_frame() && !force;
                            if dropped {
                                policy.report_drop();
                                continue;
                            }
                        }
                    }
                    let texture = converter.convert(&frame.texture, frame.color_space)?;
                    let duration = (10_000_000.0 / admission_rate.fps.unwrap_or(current.fps as f32))
                        .round()
                        .max(1.0) as i64;
                    encoder.input(&texture, pts, duration, force, discontinuity)?;
                    discontinuity = false;
                    need_input -= 1;
                    last_pts = pts;
                }
            }
        }
        Ok(())
    }
}
