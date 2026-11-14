//! Synchronous CPU NV12 -> Constrained Baseline H264. No capture/thread owner.
use super::{
    mf_common::{media_type, normalize_level_1b, Com},
    Settings,
};
use anyhow::{anyhow, ensure, Context, Result};
use std::{mem::ManuallyDrop, ptr, slice};
use windows::{
    core::Interface,
    Win32::{
        Media::MediaFoundation::*,
        System::{Com::CoTaskMemFree, Variant::VARIANT},
    },
};

use super::worker::MAX_AU;

pub(super) struct AccessUnit {
    pub bytes: Vec<u8>,
    pub pts: i64,
    pub keyframe: bool,
}

struct Activation(IMFActivate);
impl Activation {
    fn find() -> Result<Option<Self>> {
        unsafe {
            let input = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_NV12,
            };
            let output = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };
            let mut list = ptr::null_mut();
            let mut count = 0;
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&input),
                Some(&output),
                &mut list,
                &mut count,
            )?;
            let chosen = if count == 0 {
                None
            } else {
                let entries = slice::from_raw_parts_mut(list, count as usize);
                let first = entries[0].take();
                for entry in entries {
                    drop(entry.take());
                }
                first
            };
            CoTaskMemFree(Some(list.cast()));
            Ok(chosen.map(Self))
        }
    }
}
impl Drop for Activation {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.ShutdownObject();
        }
    }
}

pub(super) fn available() -> Result<bool> {
    let _com = Com::start()?;
    let Some(activation) = Activation::find()? else {
        return Ok(false);
    };
    Ok(unsafe { activation.0.ActivateObject::<IMFTransform>() }
        .and_then(|transform| transform.cast::<ICodecAPI>())
        .is_ok())
}

pub(super) struct Encoder {
    _activation: Activation,
    transform: IMFTransform,
    api: ICodecAPI,
    info: MFT_OUTPUT_STREAM_INFO,
    settings: Settings,
    _com: Com,
}

impl Encoder {
    pub fn new(settings: Settings) -> Result<Self> {
        settings.validate()?;
        let com = Com::start()?;
        unsafe {
            let activation = Activation::find()?
                .ok_or_else(|| anyhow!("no synchronous software H264 encoder"))?;
            let transform: IMFTransform = activation.0.ActivateObject()?;
            let api: ICodecAPI = transform.cast()?;
            // These properties must precede output type negotiation; LowLatency is VT_BOOL.
            // https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder
            for (key, value) in [
                (
                    CODECAPI_AVEncCommonRateControlMode,
                    eAVEncCommonRateControlMode_CBR.0 as u32,
                ),
                (CODECAPI_AVEncCommonMeanBitRate, settings.bitrate),
                (CODECAPI_AVEncMPVDefaultBPictureCount, 0),
                (CODECAPI_AVEncMPVGOPSize, settings.fps.saturating_mul(2)),
                (CODECAPI_AVEncCommonQualityVsSpeed, 0),
            ] {
                api.SetValue(&key, &VARIANT::from(value))?;
            }
            api.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true))?;
            let output = media_type(&MFVideoFormat_H264, settings)?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, settings.bitrate)?;
            output.SetUINT32(
                &MF_MT_MPEG2_PROFILE,
                eAVEncH264VProfile_ConstrainedBase.0 as u32,
            )?;
            transform.SetOutputType(0, &output, 0)?;
            let input = media_type(&MFVideoFormat_NV12, settings)?;
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, settings.width)?;
            transform.SetInputType(0, &input, 0)?;
            let info = transform.GetOutputStreamInfo(0)?;
            ensure!(
                info.cbSize as usize <= MAX_AU,
                "software H264 output allocation exceeds bound"
            );
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Self {
                _activation: activation,
                transform,
                api,
                info,
                settings,
                _com: com,
            })
        }
    }

    pub fn set_bitrate(&mut self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "H264 bitrate must be positive");
        unsafe {
            self.api
                .SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate))?;
        }
        self.settings.bitrate = bitrate;
        Ok(())
    }

    pub fn encode(
        &mut self,
        nv12: &[u8],
        row_pitch: usize,
        pts: i64,
        duration: u32,
        force: bool,
    ) -> Result<AccessUnit> {
        let width = self.settings.width as usize;
        let rows = self.settings.height as usize * 3 / 2;
        ensure!(
            row_pitch >= width && row_pitch.checked_mul(rows).is_some_and(|n| n <= nv12.len()),
            "H264 NV12 input bounds"
        );
        unsafe {
            if force {
                self.api
                    .SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32))?;
            }
            let buffer = MFCreateMemoryBuffer((width * rows).try_into()?)?;
            let mut pixels = ptr::null_mut();
            buffer.Lock(&mut pixels, None, None)?;
            for row in 0..rows {
                ptr::copy_nonoverlapping(
                    nv12.as_ptr().add(row * row_pitch),
                    pixels.add(row * width),
                    width,
                );
            }
            buffer.Unlock()?;
            buffer.SetCurrentLength((width * rows) as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts)?;
            sample.SetSampleDuration(duration.into())?;
            self.transform
                .ProcessInput(0, &sample, 0)
                .context("software H264 ProcessInput")?;
            // No B frames/lookahead: require same-input output, keeping the existing
            // synchronous worker's clock and resize contract. No hidden pending queue.
            let unit = self
                .output()?
                .ok_or_else(|| anyhow!("software H264 delayed its output"))?;
            ensure!(unit.pts == pts, "software H264 changed output order");
            ensure!(
                !force || unit.keyframe,
                "software H264 independent frame request was not honored"
            );
            ensure!(
                self.output()?.is_none(),
                "software H264 returned extra output"
            );
            Ok(unit)
        }
    }

    fn output(&self) -> Result<Option<AccessUnit>> {
        unsafe {
            let sample = MFCreateSample()?;
            sample.AddBuffer(&MFCreateAlignedMemoryBuffer(
                self.info.cbSize,
                self.info.cbAlignment.saturating_sub(1),
            )?)?;
            let mut data = MFT_OUTPUT_DATA_BUFFER {
                pSample: ManuallyDrop::new(Some(sample)),
                pEvents: ManuallyDrop::new(None),
                ..Default::default()
            };
            let mut status = 0;
            let result = self
                .transform
                .ProcessOutput(0, slice::from_mut(&mut data), &mut status);
            let sample = ManuallyDrop::take(&mut data.pSample);
            drop(ManuallyDrop::take(&mut data.pEvents));
            if result
                .as_ref()
                .is_err_and(|error| error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT)
            {
                return Ok(None);
            }
            result.context("software H264 ProcessOutput")?;
            let sample = sample.ok_or_else(|| anyhow!("software H264 omitted output sample"))?;
            let pts = sample.GetSampleTime()?;
            let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
            let buffer = sample.ConvertToContiguousBuffer()?;
            let length = buffer.GetCurrentLength()? as usize;
            ensure!(
                length > 0 && length <= MAX_AU,
                "software H264 AU exceeds bound"
            );
            let mut pixels = ptr::null_mut();
            buffer.Lock(&mut pixels, None, None)?;
            let mut bytes = slice::from_raw_parts(pixels, length).to_vec();
            buffer.Unlock()?;
            ensure!(
                bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]),
                "software H264 did not emit Annex B"
            );
            normalize_level_1b(&mut bytes);
            Ok(Some(AccessUnit {
                bytes,
                pts,
                keyframe,
            }))
        }
    }
}
