//! Adapter-bound asynchronous hardware MFT. No capture/RTP policy lives here.
use super::{
    cadence::{AdmissionRate, Cadence},
    converter::Converter,
    frame_dropper::FrameDropper,
    frames::RawFrame,
    output::Shared,
    CaptureClock, Settings,
};
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{mem::ManuallyDrop, ptr, sync::Arc};
use windows::{
    core::{implement, IUnknown, Interface, Ref},
    Win32::{
        Foundation::E_NOTIMPL,
        Graphics::{
            Direct3D11::{ID3D11Device, ID3D11Texture2D, D3D11_TEXTURE2D_DESC},
            Dxgi::IDXGIDevice,
        },
        Media::MediaFoundation::*,
        System::{
            Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED},
            Variant::VARIANT,
        },
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
struct Com;
impl Com {
    fn start() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error.into());
            }
        }
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
pub(super) struct Encoder {
    activate: IMFActivate,
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    callback: IMFAsyncCallback,
    api: ICodecAPI,
    info: MFT_OUTPUT_STREAM_INFO,
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
fn media_type(subtype: &windows::core::GUID, settings: Settings) -> Result<IMFMediaType> {
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media.SetUINT64(
            &MF_MT_FRAME_SIZE,
            ((settings.width as u64) << 32) | settings.height as u64,
        )?;
        media.SetUINT64(&MF_MT_FRAME_RATE, ((settings.fps as u64) << 32) | 1)?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_SMPTE170M.0 as u32)?;
        media.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media)
    }
}

fn set_format(transform: &IMFTransform, settings: Settings) -> Result<MFT_OUTPUT_STREAM_INFO> {
    unsafe {
        let output = media_type(&MFVideoFormat_H264, settings)?;
        output.SetUINT32(&MF_MT_AVG_BITRATE, settings.bitrate)?;
        output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
        transform.SetOutputType(0, &output, 0)?;
        transform.SetInputType(0, &media_type(&MFVideoFormat_NV12, settings)?, 0)?;
        Ok(transform.GetOutputStreamInfo(0)?)
    }
}

fn normalize_level_1b(bytes: &mut [u8]) {
    // Some MFTs use level_idc 9 for Baseline Level 1b. RFC 6184 requires
    // constraint_set3_flag and level_idc 11; MF decoding otherwise yields no frames.
    for index in 0..bytes.len().saturating_sub(6) {
        let prefix = &mut bytes[index..index + 7];
        if prefix[..3] == [0, 0, 1] && prefix[3] & 0x1f == 7 && prefix[4] == 0x42 && prefix[6] == 9
        {
            prefix[5] |= 0x10;
            prefix[6] = 11;
        }
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
    /// Called only after DrainComplete has delivered every old-format output.
    fn resize(&mut self, settings: Settings) -> Result<()> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
            self.transform.SetInputType(0, None::<&IMFMediaType>, 0)?;
            self.transform.SetOutputType(0, None::<&IMFMediaType>, 0)?;
            self.info = set_format(&self.transform, settings)?;
            self.api.SetValue(
                &CODECAPI_AVEncCommonMeanBitRate,
                &VARIANT::from(settings.bitrate),
            )?;
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
        let duration = 10_000_000 / settings.fps as i64;
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
            match work {
                Work::Stop => break,
                Work::Bitrate(bitrate) => unsafe {
                    encoder
                        .api
                        .SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate))
                        .context("hardware H264 live bitrate")?;
                    target_kbps = bitrate as f32 / 1000.0;
                    current.bitrate = bitrate;
                    dropper.set_rates(target_kbps, admission_rate.fps.unwrap_or(0.0));
                },
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
                                let next = fitted(settings, frame);
                                state.force_keyframe = true;
                                next
                            };
                            current.width = next.width;
                            current.height = next.height;
                            encoder.resize(current).context("hardware H264 resize")?;
                            converter = Converter::new(&device, current)?;
                            resizing = false;
                            discontinuity = true;
                        }
                    }
                }
                Work::Frame(frame, force) => {
                    let next = fitted(settings, &frame);
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
                            dropper.set_rates(target_kbps, fps);
                            dropper.leak(fps.round() as u32);
                            let dropped = dropper.drop_frame() && !force;
                            if dropped {
                                continue;
                            }
                        }
                    }
                    let texture = converter.convert(&frame.texture, frame.color_space)?;
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
