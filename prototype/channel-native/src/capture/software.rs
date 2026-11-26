//! One synchronous NV12/readback/adaptation owner for CPU encoders.
use super::{
    adaptation::{Input, QualityPolicy},
    cadence::{AdmissionRate, Cadence},
    converter::Converter,
    frame_dropper::FrameDropper,
    frames::RawFrame,
    mf_software,
    output::{Presentation, Shared},
    qp, vp8, CaptureClock, FrameTiming, Settings, VideoCodec,
};
use anyhow::Result;
use std::{slice, sync::Arc, time::Instant};
use windows::Win32::Graphics::Direct3D11::*;

struct AccessUnit {
    bytes: Vec<u8>,
    keyframe: bool,
    qp: Option<i32>,
    vp8: Option<crate::Vp8FrameMetadata>,
}
enum Encoder {
    Vp8(vp8::Encoder),
    H264(mf_software::Encoder, qp::H264),
}
impl Encoder {
    fn new(codec: VideoCodec, settings: Settings) -> Result<Self> {
        Ok(match codec {
            VideoCodec::Vp8 => Self::Vp8(vp8::Encoder::new(settings)?),
            VideoCodec::H264 => {
                Self::H264(mf_software::Encoder::new(settings)?, qp::H264::default())
            }
        })
    }
    fn set_bitrate(&mut self, bitrate: u32) -> Result<()> {
        match self {
            Self::Vp8(encoder) => encoder.set_bitrate(bitrate),
            Self::H264(encoder, _) => encoder.set_bitrate(bitrate),
        }
    }
    fn encode(
        &mut self,
        pixels: &[u8],
        pitch: usize,
        pts: i64,
        duration: u32,
        force: bool,
    ) -> Result<Option<AccessUnit>> {
        match self {
            Self::Vp8(encoder) => {
                Ok(encoder
                    .encode(pixels, pitch, pts, duration, force)?
                    .map(|unit| AccessUnit {
                        bytes: unit.bytes,
                        keyframe: unit.keyframe,
                        qp: unit.qp,
                        vp8: Some(crate::Vp8FrameMetadata {
                            non_reference: unit.non_reference,
                            ..Default::default()
                        }),
                    }))
            }
            Self::H264(encoder, qp) => {
                let unit = encoder.encode(pixels, pitch, pts, duration, force)?;
                let quantizer = qp.parse(&unit.bytes);
                Ok(Some(AccessUnit {
                    bytes: unit.bytes,
                    keyframe: unit.keyframe,
                    qp: quantizer,
                    vp8: None,
                }))
            }
        }
    }
}

fn fitted(settings: Settings, frame: &RawFrame) -> Settings {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { frame.texture.GetDesc(&mut desc) };
    settings.fitted(desc.Width as f64, desc.Height as f64)
}

/// CPU encoders share scheduling, adaptation and NV12 readback.
pub(super) fn run(
    shared: &Arc<Shared>,
    settings: Settings,
    codec: VideoCodec,
    clock: CaptureClock,
    timing: FrameTiming,
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
    let context = unsafe { device.GetImmediateContext()? };
    let mut encoder = Encoder::new(codec, current)?;
    let mut converter = Converter::new(&device, current)?;
    let mut staging = None;
    let mut last_capture = None;
    let mut presentation = Presentation::default();
    let started = Instant::now();
    let mut policy = QualityPolicy::new(codec, settings.degradation_preference, 0);
    let requested_max = (timing == FrameTiming::Capture).then_some(settings.fps);
    let mut usage = super::software_usage::SoftwareUsage::new(requested_max.unwrap_or(30), 0);
    let mut frame_limit = requested_max;
    let mut cadence = Cadence::new(settings.fps);
    let mut admission_rate = AdmissionRate::default();
    let mut dropper = FrameDropper::new();
    dropper.set_rates(current.bitrate as f32 / 1000.0, 0.0);
    enum Work {
        Stop,
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
                if let Some(bitrate) = state.bitrate.take() {
                    break Work::Bitrate(bitrate);
                }
                if let Some((frame, force)) = state.admit_frame(
                    timing,
                    last_capture,
                    &presentation,
                    frame_limit,
                    &mut cadence,
                ) {
                    break Work::Frame(frame, force);
                }
                shared.request_frame(&mut state);
                state = shared.changed.wait(state).unwrap();
            }
        };
        let (frame, mut force) = match work {
            Work::Stop => break,
            Work::Bitrate(bitrate) => {
                encoder.set_bitrate(bitrate)?;
                current.bitrate = bitrate;
                dropper.set_rates(bitrate as f32 / 1000.0, admission_rate.fps.unwrap_or(0.0));
                continue;
            }
            Work::Frame(frame, force) => (frame, force),
        };
        let repeated = last_capture == Some(frame.qpc);
        last_capture = Some(frame.qpc);
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
            usage.target_frame_rate(frame_limit.unwrap_or(30));
            cadence = Cadence::new(frame_limit.unwrap_or(settings.fps));
            if frame_limit.is_some() && !repeated {
                cadence.accept(frame.qpc);
            }
            admission_rate = AdmissionRate::default();
        }
        if !repeated {
            if let Some(fps) = admission_rate.observe(frame.qpc) {
                if dropper.should_drop_at_rate(current.bitrate as f32 / 1000.0, fps) && !force {
                    policy.report_drop();
                    continue;
                }
            }
        }
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
        if (next.width, next.height, next.fps) != (current.width, current.height, current.fps) {
            current = next;
            encoder = Encoder::new(codec, current)?;
            converter = Converter::new(&device, current)?;
            staging = None;
            force = true;
        }
        let qpc = presentation.next_qpc(clock, timing, frame.qpc)?;
        let texture = converter.convert(&frame.texture, frame.color_space)?;
        if staging.is_none() {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe {
                texture.GetDesc(&mut desc);
            }
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            desc.MiscFlags = 0;
            unsafe {
                device.CreateTexture2D(&desc, None, Some(&mut staging))?;
            }
        }
        let staging = staging.as_ref().unwrap();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        let unit = unsafe {
            context.CopyResource(staging, &texture);
            context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let length = mapped.RowPitch as usize * current.height as usize * 3 / 2;
            let pixels = slice::from_raw_parts(mapped.pData.cast(), length);
            let input = Input {
                pixels: current.width * current.height,
                fps: admission_rate.fps.unwrap_or(0.0).round() as u32,
            };
            let usage_id = usage.started(input, started.elapsed().as_micros() as i64, &mut policy);
            let unit = encoder.encode(
                pixels,
                mapped.RowPitch as usize,
                qpc,
                (10_000_000.0 / admission_rate.fps.unwrap_or(current.fps as f32))
                    .round()
                    .max(1.0) as u32,
                force,
            );
            if unit.as_ref().is_ok_and(|unit| unit.is_some()) {
                usage.completed(
                    usage_id,
                    input,
                    started.elapsed().as_micros() as i64,
                    &mut policy,
                );
            }
            context.Unmap(staging, 0);
            unit?
        };
        presentation.submitted(frame.qpc, qpc);
        if let Some(unit) = unit {
            policy.report_encoded(unit.qp, started.elapsed().as_micros() as u64);
            dropper.fill(unit.bytes.len(), !unit.keyframe);
            if !shared.output(crate::EncodedFrame {
                bytes: unit.bytes,
                presentation_time: clock.instant(qpc),
                keyframe: unit.keyframe,
                vp8: unit.vp8,
            }) {
                break;
            }
        } else {
            policy.report_drop();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A timer-driven keyframe re-sends a static screen and resets its quality.
    #[test]
    fn cpu_codecs_emit_keyframes_only_on_request() -> Result<()> {
        for codec in [VideoCodec::H264, VideoCodec::Vp8] {
            let settings = Settings {
                width: 160,
                height: 110,
                fps: 10,
                bitrate: 300_000,
                degradation_preference: super::super::DegradationPreference::Balanced,
            };
            let mut encoder = Encoder::new(codec, settings)?;
            let pixels = vec![128; 192 * 110 * 3 / 2];
            // Three seconds, past the two-second period these encoders once forced.
            for index in 0..30 {
                let unit = encoder
                    .encode(&pixels, 192, index * 1_000_000, 1_000_000, index == 0)?
                    .unwrap();
                assert_eq!(unit.keyframe, index == 0, "{codec:?} frame {index}");
            }
        }
        Ok(())
    }

    #[test]
    fn cpu_codecs_keep_controls_metadata_and_quality_feedback() -> Result<()> {
        for codec in [VideoCodec::H264, VideoCodec::Vp8] {
            for (width, height, pitch) in [(160, 110, 192), (320, 180, 384)] {
                let settings = Settings {
                    width,
                    height,
                    fps: 30,
                    bitrate: 300_000,
                    degradation_preference: super::super::DegradationPreference::Balanced,
                };
                let mut encoder = Encoder::new(codec, settings)?;
                let mut pixels = vec![128; pitch * height as usize * 3 / 2];
                let epoch = Instant::now();
                let mut usage = super::super::software_usage::SoftwareUsage::new(30, 0);
                let mut policy = QualityPolicy::new(codec, settings.degradation_preference, 0);
                let input = Input {
                    pixels: width * height,
                    fps: 30,
                };
                for index in 0..12 {
                    if index == 6 {
                        encoder.set_bitrate(150_000)?;
                    }
                    for y in 0..height as usize {
                        for x in 0..width as usize {
                            pixels[y * pitch + x] = (32 + (x + y + index * 11) % 190) as u8;
                        }
                    }
                    let id = usage.started(input, epoch.elapsed().as_micros() as i64, &mut policy);
                    let unit = encoder
                        .encode(
                            &pixels,
                            pitch,
                            index as i64 * 333333,
                            333333,
                            index == 0 || index == 6,
                        )?
                        .unwrap();
                    usage.completed(id, input, epoch.elapsed().as_micros() as i64, &mut policy);
                    assert_eq!(unit.keyframe, index == 0 || index == 6);
                    assert_eq!(unit.vp8.is_some(), codec == VideoCodec::Vp8);
                    if codec == VideoCodec::H264 && unit.keyframe {
                        use h264_reader::nal::{sps::SeqParameterSet, Nal, RefNal};
                        let nal = crate::media::h264::nals(&unit.bytes)?
                            .find(|nal| nal[0] & 31 == 7)
                            .expect("software H264 keyframe SPS");
                        let sps =
                            SeqParameterSet::from_bits(RefNal::new(nal, &[], true).rbsp_bits())
                                .expect("software H264 SPS");
                        let signal = sps.vui_parameters.unwrap().video_signal_type.unwrap();
                        let color = signal.colour_description.unwrap();
                        assert!(!signal.video_full_range_flag);
                        assert_eq!(
                            (
                                color.colour_primaries,
                                color.transfer_characteristics,
                                color.matrix_coefficients
                            ),
                            (6, 1, 6)
                        );
                    }
                    assert!(unit.qp.is_some(), "{codec:?} lacks quality feedback");
                }
            }
        }
        Ok(())
    }
}
