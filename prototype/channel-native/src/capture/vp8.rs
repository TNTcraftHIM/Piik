//! The stock libvpx encoder; source clocks and worker lifetime stay with capture.
use super::{
    cadence::{AdmissionRate, Cadence},
    converter::Converter,
    frame_dropper::FrameDropper,
    frames::RawFrame,
    output::Shared,
    CaptureClock, FrameTiming, Settings, VideoCodec,
};
use anyhow::{ensure, Result};
use std::{ffi::CStr, mem, ptr, slice, sync::Arc};
use vpx_sys::*;
use windows::Win32::Graphics::Direct3D11::*;

pub(super) struct AccessUnit {
    pub codec: VideoCodec,
    pub bytes: Vec<u8>,
    pub keyframe: bool,
    pub non_reference: bool,
}

pub(super) struct Encoder {
    context: vpx_codec_ctx_t,
    config: vpx_codec_enc_cfg_t,
}

fn check(result: vpx_codec_err_t) -> Result<()> {
    if result != vpx_codec_err_t::VPX_CODEC_OK {
        let reason = unsafe { CStr::from_ptr(vpx_codec_err_to_string(result)) };
        anyhow::bail!("libvpx VP8: {}", reason.to_string_lossy());
    }
    Ok(())
}

impl Encoder {
    pub fn new(settings: Settings) -> Result<Self> {
        settings.validate()?;
        unsafe {
            let interface = vpx_codec_vp8_cx();
            let mut config = mem::MaybeUninit::<vpx_codec_enc_cfg_t>::uninit();
            check(vpx_codec_enc_config_default(
                interface,
                config.as_mut_ptr(),
                0,
            ))?;
            let mut config = config.assume_init();
            config.g_w = settings.width;
            config.g_h = settings.height;
            config.g_timebase = vpx_rational_t {
                num: 1,
                den: 10_000_000,
            };
            config.g_threads =
                std::thread::available_parallelism().map_or(1, |n| n.get().min(4)) as u32;
            config.g_lag_in_frames = 0;
            config.rc_end_usage = vpx_rc_mode::VPX_CBR;
            config.rc_target_bitrate = settings.bitrate.div_ceil(1000);
            config.rc_dropframe_thresh = 0;
            // Stock WebRTC's low-latency VP8 CBR buffer configuration.
            config.rc_undershoot_pct = 100;
            config.rc_overshoot_pct = 15;
            config.rc_buf_initial_sz = 500;
            config.rc_buf_optimal_sz = 600;
            config.rc_buf_sz = 1000;
            config.kf_max_dist = settings.fps.saturating_mul(2);
            let mut context = mem::MaybeUninit::<vpx_codec_ctx_t>::zeroed();
            check(vpx_codec_enc_init_ver(
                context.as_mut_ptr(),
                interface,
                &config,
                0,
                VPX_ENCODER_ABI_VERSION as i32,
            ))?;
            let context = context.assume_init();
            let mut encoder = Self { context, config };
            check(vpx_codec_control_(
                &mut encoder.context,
                vp8e_enc_control_id::VP8E_SET_CPUUSED as i32,
                8i32,
            ))?;
            Ok(encoder)
        }
    }

    pub fn set_bitrate(&mut self, bitrate: u32) -> Result<()> {
        ensure!(bitrate > 0, "VP8 bitrate must be positive");
        let mut config = self.config;
        config.rc_target_bitrate = bitrate.div_ceil(1000);
        unsafe {
            check(vpx_codec_enc_config_set(&mut self.context, &config))?;
        }
        self.config = config;
        Ok(())
    }

    pub fn encode(
        &mut self,
        nv12: &[u8],
        row_pitch: usize,
        pts: i64,
        duration: u32,
        force_keyframe: bool,
    ) -> Result<Option<AccessUnit>> {
        let height = self.config.g_h as usize;
        let length = row_pitch
            .checked_mul(height)
            .and_then(|n| n.checked_add(n / 2));
        ensure!(
            row_pitch >= self.config.g_w as usize
                && row_pitch <= i32::MAX as usize
                && length.is_some_and(|n| nv12.len() >= n),
            "VP8 NV12 input bounds"
        );
        unsafe {
            let mut image: vpx_image_t = mem::zeroed();
            ensure!(
                !vpx_img_wrap(
                    &mut image,
                    vpx_img_fmt::VPX_IMG_FMT_NV12,
                    self.config.g_w,
                    self.config.g_h,
                    1,
                    nv12.as_ptr().cast_mut()
                )
                .is_null(),
                "VP8 NV12 image wrapping failed"
            );
            image.stride.fill(row_pitch as i32);
            image.planes[1] = nv12.as_ptr().add(row_pitch * height).cast_mut();
            image.planes[2] = image.planes[1].add(1);
            check(vpx_codec_encode(
                &mut self.context,
                &image,
                pts,
                duration.into(),
                if force_keyframe {
                    VPX_EFLAG_FORCE_KF as _
                } else {
                    0
                },
                VPX_DL_REALTIME.into(),
            ))?;
            let mut iterator = ptr::null();
            let mut output = None;
            loop {
                let packet = vpx_codec_get_cx_data(&mut self.context, &mut iterator);
                let Some(packet) = packet.as_ref() else {
                    break;
                };
                if packet.kind != vpx_codec_cx_pkt_kind::VPX_CODEC_CX_FRAME_PKT {
                    continue;
                }
                let frame = &packet.data.frame;
                ensure!(
                    output.is_none() && frame.pts == pts,
                    "VP8 output order changed"
                );
                ensure!(
                    !frame.buf.is_null() && frame.sz > 0 && frame.sz <= super::worker::MAX_AU,
                    "VP8 encoded access unit exceeds its bound"
                );
                let keyframe = frame.flags & VPX_FRAME_IS_KEY != 0;
                ensure!(
                    !force_keyframe || keyframe,
                    "VP8 independent frame request was not honored"
                );
                output = Some(AccessUnit {
                    codec: VideoCodec::Vp8,
                    bytes: slice::from_raw_parts(frame.buf.cast(), frame.sz).to_vec(),
                    keyframe,
                    non_reference: frame.flags & VPX_FRAME_IS_DROPPABLE != 0,
                });
            }
            Ok(output)
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            vpx_codec_destroy(&mut self.context);
        }
    }
}

fn fitted(settings: Settings, frame: &RawFrame) -> Settings {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { frame.texture.GetDesc(&mut desc) };
    settings.fitted(desc.Width as f64, desc.Height as f64)
}

/// Same raw-slot/ordered-AU owner as MF; only encoding and its readback differ.
pub(super) fn run(
    shared: &Arc<Shared>,
    settings: Settings,
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
    let mut encoder = Encoder::new(current)?;
    let mut converter = Converter::new(&device, current)?;
    let mut staging = None;
    let mut last_capture = None;
    let mut last_pts = None;
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
                if let Some(raw) = &state.latest {
                    let accept = match timing {
                        FrameTiming::Capture => {
                            state.force_keyframe
                                || (last_capture != Some(raw.qpc) && cadence.accept(raw.qpc))
                        }
                        FrameTiming::Source => {
                            last_capture != Some(raw.qpc)
                                && last_pts.is_none_or(|last| raw.qpc > last)
                        }
                    };
                    if accept {
                        let frame = raw.clone();
                        let (next, deferred) =
                            shared.defer_force(state, clock, timing, frame.qpc, last_pts)?;
                        state = next;
                        if deferred {
                            continue;
                        }
                        break Work::Frame(frame, mem::take(&mut state.force_keyframe));
                    }
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
        let qpc = if timing == FrameTiming::Capture
            && (repeated || (force && last_pts.is_some_and(|last| frame.qpc <= last)))
        {
            clock.now()?
        } else {
            frame.qpc
        };
        if last_pts.is_some_and(|last| qpc <= last) {
            continue;
        }
        if !repeated {
            if let Some(fps) = admission_rate.observe(frame.qpc) {
                dropper.set_rates(current.bitrate as f32 / 1000.0, fps);
                dropper.leak(fps.round() as u32);
                if dropper.drop_frame() && !force {
                    continue;
                }
            }
        }
        let next = fitted(
            Settings {
                bitrate: current.bitrate,
                ..settings
            },
            &frame,
        );
        if (next.width, next.height) != (current.width, current.height) {
            current = next;
            encoder = Encoder::new(current)?;
            converter = Converter::new(&device, current)?;
            staging = None;
            force = true;
        }
        let texture = converter.convert(&frame.texture)?;
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
            let unit = encoder.encode(
                pixels,
                mapped.RowPitch as usize,
                qpc,
                10_000_000 / settings.fps,
                force,
            );
            context.Unmap(staging, 0);
            unit?
        };
        last_pts = Some(qpc);
        if let Some(unit) = unit {
            ensure!(unit.codec == VideoCodec::Vp8, "VP8 encoder changed codec");
            dropper.fill(unit.bytes.len(), !unit.keyframe);
            if !shared.output(crate::EncodedFrame {
                bytes: unit.bytes,
                presentation_time: clock.instant(qpc),
                keyframe: unit.keyframe,
                vp8: Some(crate::Vp8FrameMetadata {
                    non_reference: unit.non_reference,
                    ..Default::default()
                }),
            }) {
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_bitrate_updates_keep_a_decodable_vp8_encoder() -> Result<()> {
        let settings = Settings {
            width: 160,
            height: 110,
            fps: 10,
            bitrate: 150_000,
        };
        let pixels = vec![128; 160 * 110 * 3 / 2];
        let mut encoder = Encoder::new(settings)?;
        let mut decoder: vpx_codec_ctx_t = unsafe { mem::zeroed() };
        unsafe {
            check(vpx_codec_dec_init_ver(
                &mut decoder,
                vpx_codec_vp8_dx(),
                ptr::null(),
                0,
                VPX_DECODER_ABI_VERSION as i32,
            ))?;
        }
        let result = (|| {
            for (index, bitrate) in [150_000, 64_000, 500_000].into_iter().enumerate() {
                encoder.set_bitrate(bitrate)?;
                let unit = encoder
                    .encode(
                        &pixels,
                        160,
                        index as i64 * 1_000_000,
                        1_000_000,
                        index != 1,
                    )?
                    .unwrap();
                assert_eq!(unit.codec, VideoCodec::Vp8);
                assert_eq!(unit.keyframe, index != 1);
                unsafe {
                    check(vpx_codec_decode(
                        &mut decoder,
                        unit.bytes.as_ptr(),
                        unit.bytes.len() as u32,
                        ptr::null_mut(),
                        0,
                    ))?;
                    let mut iterator = ptr::null();
                    let image = vpx_codec_get_frame(&mut decoder, &mut iterator)
                        .as_ref()
                        .unwrap();
                    assert_eq!((image.d_w, image.d_h), (160, 110));
                }
            }
            Ok(())
        })();
        unsafe {
            vpx_codec_destroy(&mut decoder);
        }
        result
    }
}
