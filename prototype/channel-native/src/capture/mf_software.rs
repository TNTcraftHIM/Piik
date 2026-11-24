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
    // Drop the codec interface before its activation and COM apartment.
    let codec_api = unsafe { activation.0.ActivateObject::<IMFTransform>() }
        .and_then(|transform| transform.cast::<ICodecAPI>());
    Ok(codec_api.is_ok())
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
                (CODECAPI_AVEncMPVGOPSize, super::KEYFRAME_INTERVAL_FRAMES),
                (CODECAPI_AVEncCommonQualityVsSpeed, 0),
            ] {
                api.SetValue(&key, &VARIANT::from(value))?;
            }
            api.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true))?;
            let output = super::mf_common::h264_output(settings)?;
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
            let mut submitted_after_change = false;
            let unit = loop {
                if force {
                    self.api
                        .SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32))?;
                }
                self.transform
                    .ProcessInput(0, &sample, 0)
                    .context("software H264 ProcessInput")?;
                let (unit, changed) = self.output()?;
                if let Some(unit) = unit {
                    break unit;
                }
                // A synchronous MFT may discard its pending input when SetOutputType succeeds.
                ensure!(
                    changed && !submitted_after_change,
                    "software H264 delayed its output"
                );
                submitted_after_change = true;
            };
            ensure!(unit.pts == pts, "software H264 changed output order");
            ensure!(
                !force || unit.keyframe,
                "software H264 independent frame request was not honored"
            );
            ensure!(
                self.output()?.0.is_none(),
                "software H264 returned extra output"
            );
            Ok(unit)
        }
    }

    fn output(&mut self) -> Result<(Option<AccessUnit>, bool)> {
        unsafe {
            let mut changed = false;
            let sample = loop {
                let sample = if self.info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0
                {
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&MFCreateAlignedMemoryBuffer(
                        self.info.cbSize,
                        self.info.cbAlignment.saturating_sub(1),
                    )?)?;
                    Some(sample)
                } else {
                    None
                };
                let mut data = MFT_OUTPUT_DATA_BUFFER {
                    pSample: ManuallyDrop::new(sample),
                    pEvents: ManuallyDrop::new(None),
                    ..Default::default()
                };
                let mut status = 0;
                let result =
                    self.transform
                        .ProcessOutput(0, slice::from_mut(&mut data), &mut status);
                let sample = ManuallyDrop::take(&mut data.pSample);
                drop(ManuallyDrop::take(&mut data.pEvents));
                if result
                    .as_ref()
                    .is_err_and(|e| e.code() == MF_E_TRANSFORM_STREAM_CHANGE)
                    && status & MFT_PROCESS_OUTPUT_STATUS_NEW_STREAMS.0 as u32 == 0
                {
                    drop(sample);
                    ensure!(
                        !changed,
                        "software H264 repeated output format change without progress"
                    );
                    self.info =
                        super::mf_common::renegotiate_h264_output(&self.transform, self.settings)?;
                    ensure!(
                        self.info.cbSize as usize <= MAX_AU,
                        "software H264 output allocation exceeds bound"
                    );
                    changed = true;
                    continue;
                }
                if result
                    .as_ref()
                    .is_err_and(|error| error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT)
                {
                    return Ok((None, changed));
                }
                result.context("software H264 ProcessOutput")?;
                break sample;
            };
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
            declare_sdr_color(&mut bytes)?;
            Ok((
                Some(AccessUnit {
                    bytes,
                    pts,
                    keyframe,
                }),
                changed,
            ))
        }
    }
}

// The synchronous MFT can omit colour information from the SPS despite both
// negotiated media types declaring the converter's limited-range BT.601.
fn declare_sdr_color(bytes: &mut Vec<u8>) -> Result<()> {
    use h264_reader::nal::{
        sps::{ColourDescription, SeqParameterSet, VideoFormat, VideoSignalType},
        Nal, RefNal, WritableNal,
    };

    let mut replacements = Vec::new();
    for nal in crate::media::h264::nals(bytes)?.filter(|nal| nal[0] & 31 == 7) {
        let source = RefNal::new(nal, &[], true);
        let mut sps = SeqParameterSet::from_bits(source.rbsp_bits())
            .map_err(|error| anyhow!("invalid software H264 SPS: {error:?}"))?;
        let vui = sps.vui_parameters.get_or_insert_default();
        let color = vui
            .video_signal_type
            .get_or_insert_with(|| VideoSignalType {
                video_format: VideoFormat::Unspecified,
                ..Default::default()
            });
        let description = ColourDescription {
            colour_primaries: 6,         // SMPTE 170M
            transfer_characteristics: 1, // BT.709
            matrix_coefficients: 6,      // BT.601
        };
        if !color.video_full_range_flag && color.colour_description.as_ref() == Some(&description) {
            continue;
        }
        color.video_full_range_flag = false;
        color.colour_description = Some(description);
        let start = nal.as_ptr() as usize - bytes.as_ptr() as usize;
        let header = source
            .header()
            .map_err(|error| anyhow!("invalid software H264 NAL header: {error:?}"))?;
        replacements.push((start..start + nal.len(), sps.to_vec_with_header(header)));
    }
    for (range, sps) in replacements.into_iter().rev() {
        bytes.splice(range, sps);
    }
    ensure!(bytes.len() <= MAX_AU, "software H264 AU exceeds bound");
    Ok(())
}
