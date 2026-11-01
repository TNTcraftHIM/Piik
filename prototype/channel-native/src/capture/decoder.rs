//! One MF H264 decoder. AU assembly, selection and source time belong to media.
use super::Format;
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Context, Result};
use std::{
    mem::ManuallyDrop,
    time::{Duration, Instant},
};
use windows::{
    core::Interface,
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D10::ID3D10Multithread, Direct3D11::*,
            Dxgi::Common::*,
        },
        Media::MediaFoundation::*,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
            Variant::VARIANT,
        },
    },
};

struct Com;
impl Com {
    fn start() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(e.into());
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
pub(crate) struct Decoder {
    transform: IMFTransform,
    _manager: IMFDXGIDeviceManager,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    coded: (u32, u32),
    area: MFVideoArea,
    configured: bool,
    _com: Com,
    nominal_fps: u32,
    epoch: Instant,
}
impl Decoder {
    pub fn new(epoch: Instant) -> Result<Self> {
        unsafe {
            let com = Com::start()?;
            let mut device = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )?;
            let device = device.unwrap();
            let _ = device
                .cast::<ID3D10Multithread>()?
                .SetMultithreadProtected(true);
            let context = device.GetImmediateContext()?;
            let mut token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.unwrap();
            manager.ResetDevice(&device, token)?;
            let transform: IMFTransform =
                CoCreateInstance(&CMSH264DecoderMFT, None, CLSCTX_INPROC_SERVER)?;
            ensure!(
                transform.GetAttributes()?.GetUINT32(&MF_SA_D3D11_AWARE)? != 0,
                "MF decoder does not support D3D11"
            );
            transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
            let codec: ICodecAPI = transform.cast()?;
            codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(1u32))?;
            Ok(Self {
                transform,
                _manager: manager,
                device,
                context,
                coded: (0, 0),
                area: MFVideoArea::default(),
                configured: false,
                _com: com,
                nominal_fps: 30,
                epoch,
            })
        }
    }
    fn configure(&mut self) -> Result<()> {
        unsafe {
            let media = MFCreateMediaType()?;
            media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            // The decoder reads actual SPS dimensions and reports STREAM_CHANGE.
            media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            self.transform.SetInputType(0, &media, 0)?;
            self.select_output()?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            self.configured = true;
            Ok(())
        }
    }
    fn select_output(&mut self) -> Result<()> {
        unsafe {
            for index in 0..64 {
                let media = match self.transform.GetOutputAvailableType(0, index) {
                    Ok(m) => m,
                    Err(e) if e.code() == MF_E_NO_MORE_TYPES => break,
                    Err(e) => return Err(e.into()),
                };
                if media.GetGUID(&MF_MT_SUBTYPE)? != MFVideoFormat_NV12 {
                    continue;
                }
                let size = media.GetUINT64(&MF_MT_FRAME_SIZE)?;
                if let Ok(rate) = media.GetUINT64(&MF_MT_FRAME_RATE) {
                    let (n, d) = ((rate >> 32) as u32, rate as u32);
                    if n > 0 && d > 0 {
                        self.nominal_fps = n.div_ceil(d);
                    }
                }
                self.coded = ((size >> 32) as u32, size as u32);
                let mut area = MFVideoArea::default();
                let mut count = 0;
                let bytes = std::slice::from_raw_parts_mut(
                    (&mut area as *mut MFVideoArea).cast::<u8>(),
                    std::mem::size_of::<MFVideoArea>(),
                );
                let aperture = media
                    .GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, bytes, Some(&mut count))
                    .or_else(|e| {
                        if e.code() == MF_E_ATTRIBUTENOTFOUND {
                            media.GetBlob(&MF_MT_GEOMETRIC_APERTURE, bytes, Some(&mut count))
                        } else {
                            Err(e)
                        }
                    });
                match aperture {
                    Ok(()) => ensure!(
                        count as usize == std::mem::size_of::<MFVideoArea>(),
                        "partial aperture"
                    ),
                    Err(e) if e.code() == MF_E_ATTRIBUTENOTFOUND => {
                        area.Area.cx = self.coded.0 as i32;
                        area.Area.cy = self.coded.1 as i32;
                    }
                    Err(e) => return Err(e.into()),
                }
                ensure!(
                    area.OffsetX.fract == 0
                        && area.OffsetY.fract == 0
                        && area.OffsetX.value >= 0
                        && area.OffsetY.value >= 0,
                    "non-integral MF clean aperture"
                );
                ensure!(
                    area.Area.cx > 0
                        && area.Area.cy > 0
                        && area.Area.cx % 2 == 0
                        && area.Area.cy % 2 == 0
                        && area.OffsetX.value as u32 + area.Area.cx as u32 <= self.coded.0
                        && area.OffsetY.value as u32 + area.Area.cy as u32 <= self.coded.1,
                    "invalid NV12 clean aperture"
                );
                self.area = area;
                self.transform.SetOutputType(0, &media, 0)?;
                return Ok(());
            }
            Err(anyhow!("no NV12 decoder output"))
        }
    }
    pub fn decode(
        &mut self,
        frame: &EncodedFrame,
        consume: &mut impl FnMut(ID3D11Texture2D, Instant, Format) -> Result<()>,
    ) -> Result<()> {
        let bytes = &frame.bytes;
        let pts = (frame
            .presentation_time
            .duration_since(self.epoch)
            .as_nanos()
            / 100) as i64;
        unsafe {
            if !self.configured {
                self.configure()?;
            }
            let buffer = MFCreateMemoryBuffer(bytes.len() as u32)?;
            let mut target = std::ptr::null_mut();
            buffer.Lock(&mut target, None, None)?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts)?;
            let result = self.transform.ProcessInput(0, &sample, 0);
            if result
                .as_ref()
                .is_err_and(|e| e.code() == MF_E_NOTACCEPTING)
            {
                self.drain(consume)?;
                self.transform.ProcessInput(0, &sample, 0)?;
            } else {
                result?;
            }
            self.drain(consume)
        }
    }
    fn drain(
        &mut self,
        consume: &mut impl FnMut(ID3D11Texture2D, Instant, Format) -> Result<()>,
    ) -> Result<()> {
        unsafe {
            for _ in 0..64 {
                let info = self.transform.GetOutputStreamInfo(0)?;
                ensure!(
                    info.dwFlags
                        & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                            | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
                        != 0,
                    "GPU decoder did not provide its DXGI sample"
                );
                let mut output = MFT_OUTPUT_DATA_BUFFER::default();
                let mut status = 0;
                let result =
                    self.transform
                        .ProcessOutput(0, std::slice::from_mut(&mut output), &mut status);
                drop(ManuallyDrop::take(&mut output.pEvents));
                let sample = ManuallyDrop::take(&mut output.pSample);
                match result {
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                    Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                        self.select_output()?;
                        continue;
                    }
                    Err(e) => return Err(e.into()),
                    Ok(()) => {}
                }
                let Some(sample) = sample else {
                    continue;
                };
                let pts = sample.GetSampleTime()?;
                let dxgi: IMFDXGIBuffer = sample
                    .GetBufferByIndex(0)?
                    .cast()
                    .context("decoder output is not a DXGI surface")?;
                let mut raw = std::ptr::null_mut();
                dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)?;
                let texture = ID3D11Texture2D::from_raw(raw);
                let subresource = dxgi.GetSubresourceIndex()?;
                let mut actual = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut actual);
                ensure!(
                    actual.Format == DXGI_FORMAT_NV12,
                    "decoded texture is not NV12"
                );
                let mut owned = None;
                self.device.CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: self.area.Area.cx as u32,
                        Height: self.area.Area.cy as u32,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_NV12,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0)
                            as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut owned),
                )?;
                let owned = owned.unwrap();
                let x = self.area.OffsetX.value as u32;
                let y = self.area.OffsetY.value as u32;
                self.context.CopySubresourceRegion(
                    &owned,
                    0,
                    0,
                    0,
                    0,
                    &texture,
                    subresource,
                    Some(&D3D11_BOX {
                        left: x,
                        top: y,
                        front: 0,
                        right: x + self.area.Area.cx as u32,
                        bottom: y + self.area.Area.cy as u32,
                        back: 1,
                    }),
                );
                consume(
                    owned,
                    self.epoch + Duration::from_nanos(pts as u64 * 100),
                    Format {
                        width: self.area.Area.cx as u32,
                        height: self.area.Area.cy as u32,
                        fps: self.nominal_fps,
                    },
                )?;
            }
            Err(anyhow!("MF decoder output pump did not quiesce"))
        }
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        }
    }
}
