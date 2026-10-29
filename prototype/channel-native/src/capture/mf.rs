//! Adapter-bound asynchronous hardware MFT. No capture/RTP policy lives here.
use super::{
    cadence::Cadence, converter::Converter, output::Shared, windows::RawFrame, CaptureClock,
    EncodedFrame, Settings,
};
use anyhow::{anyhow, ensure, Context as _, Result};
use std::{mem::ManuallyDrop, ptr, sync::Arc};
use windows::{
    core::{implement, IUnknown, Interface, Ref},
    Win32::{
        Foundation::E_NOTIMPL,
        Graphics::{
            Direct3D11::{ID3D11Device, ID3D11Texture2D},
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
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
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
        media.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media)
    }
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
                let output = media_type(&MFVideoFormat_H264, settings)?;
                output.SetUINT32(&MF_MT_AVG_BITRATE, settings.bitrate)?;
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
                transform.SetOutputType(0, &output, 0)?;
                transform.SetInputType(0, &media_type(&MFVideoFormat_NV12, settings)?, 0)?;
                let info = transform.GetOutputStreamInfo(0)?;
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
    fn input(&self, texture: &ID3D11Texture2D, pts: i64, duration: i64, force: bool) -> Result<()> {
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
            let bytes = std::slice::from_raw_parts(p, size as usize).to_vec();
            buffer.Unlock()?;
            ensure!(
                bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]),
                "hardware encoder did not emit Annex B"
            );
            Ok((bytes, pts, keyframe))
        }
    }
    pub fn run(shared: &Arc<Shared>, settings: Settings, clock: CaptureClock) -> Result<()> {
        let device = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.stop {
                    return Ok(());
                }
                if let Some(frame) = &state.latest {
                    break unsafe { frame.texture.GetDevice()? };
                }
                state = shared.changed.wait(state).unwrap();
            }
        };
        let encoder = Self::new(&device, settings, shared.clone())?;
        let mut converter = Converter::new(&device, settings)?;
        let mut need_input = 0;
        let mut last_capture = None;
        let mut origin: Option<i64> = None;
        let mut last_pts = -1;
        let duration = 10_000_000 / settings.fps as i64;
        let mut cadence = Cadence::new(settings.fps);
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
                    if need_input > 0 {
                        if let Some(raw) = &state.latest {
                            if state.force_keyframe
                                || (last_capture != Some(raw.qpc) && cadence.accept(raw.qpc))
                            {
                                let frame = raw.clone();
                                let force = std::mem::take(&mut state.force_keyframe);
                                break Work::Frame(frame, force);
                            }
                        }
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
                },
                Work::Event(event) => {
                    let kind = event?;
                    unsafe {
                        // Exactly one outstanding event request; no unbounded event queue.
                        encoder
                            .events
                            .BeginGetEvent(&encoder.callback, None::<&IUnknown>)?;
                        if kind == METransformNeedInput.0 as u32 {
                            need_input += 1;
                        } else if kind == METransformHaveOutput.0 as u32 {
                            let (bytes, pts, keyframe) = encoder.output()?;
                            let presentation_time = clock.instant(origin.unwrap() + pts);
                            if !shared.output(EncodedFrame {
                                bytes,
                                presentation_time,
                                keyframe,
                            }) {
                                break;
                            }
                        }
                    }
                }
                Work::Frame(frame, force) => {
                    let repeated = last_capture == Some(frame.qpc);
                    last_capture = Some(frame.qpc);
                    let mut qpc = frame.qpc;
                    if repeated || (force && origin.is_some_and(|first| qpc - first <= last_pts)) {
                        qpc = clock.now()?;
                    }
                    let first = *origin.get_or_insert(qpc);
                    let pts = qpc - first;
                    // A WGC frame already in flight when a static IDR was requested
                    // may precede its presentation time; raw frames are replaceable.
                    if pts <= last_pts {
                        continue;
                    }
                    let texture = converter.convert(&frame.texture)?;
                    encoder.input(&texture, pts, duration, force)?;
                    need_input -= 1;
                    last_pts = pts;
                }
            }
        }
        Ok(())
    }
}
