//! One synchronous VT decoder; media owns complete AUs, selection and source time.
use super::{checked, Clock, Image, ImageCopy};
use crate::capture::Format;
use crate::EncodedFrame;
use anyhow::{anyhow, ensure, Context as _, Result};
use cidre::{arc, cf, cm, cv, os, vt};
use rtc_media::io::h26x_reader::H264NalUnitType;
use rtc_media::io::h26x_reader::H26xNAL;
use rtc_media::io::h26x_reader::H26xReader;
use rtc_shared::error::Error as RtcError;
use std::time::Instant;

struct Output {
    copy: ImageCopy,
    result: Result<Option<(Image, cm::Time)>>,
}
extern "C" fn output(
    context: *mut Output,
    _frame: *mut (),
    status: os::Status,
    flags: vt::DecodeInfoFlags,
    pixels: Option<&cv::ImageBuf>,
    pts: cm::Time,
    _duration: cm::Time,
) {
    // The Box stays at this address until Session::drop invalidates VT. With
    // neither async nor temporal flag, VT completes this callback before decode
    // returns; the decoder thread is its sole caller and owner.
    let context = unsafe { &mut *context };
    context.result = (|| {
        checked(status.result())?;
        if flags.contains(vt::DecodeInfoFlags::FRAME_DROPPED) {
            return Ok(None);
        }
        let pixels = pixels.context("VT returned no decoded image")?;
        let clean = pixels.clean_rect();
        let display = pixels.display_size();
        ensure!(
            [
                clean.size.width,
                clean.size.height,
                display.width,
                display.height
            ]
            .iter()
            .all(|v| v.is_finite() && *v > 0.0),
            "invalid decoded image geometry"
        );
        let image = context.copy.copy(
            pixels,
            (
                clean.size.width.round() as usize,
                clean.size.height.round() as usize,
            ),
            (display.width, display.height),
        )?;
        Ok(Some((image, pts)))
    })();
}

struct Session {
    session: arc::R<vt::DecompressionSession>,
    format: arc::R<cm::VideoFormatDesc>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.session.invalidate();
    }
}

pub(crate) struct Decoder {
    session: Option<Session>,
    parameters: [Vec<u8>; 2],
    clock: Clock,
    output: Box<Output>,
}
impl Decoder {
    pub fn new(clock: Clock) -> Result<Self> {
        Ok(Self {
            session: None,
            parameters: Default::default(),
            clock,
            output: Box::new(Output {
                copy: ImageCopy::default(),
                result: Ok(None),
            }),
        })
    }
    pub fn decode(
        &mut self,
        frame: &EncodedFrame,
        publish: &mut impl FnMut(Image, Instant, Format) -> Result<()>,
    ) -> Result<()> {
        let mut reader = H26xReader::new(&frame.bytes[..], 4096, false);
        let mut avcc = Vec::with_capacity(frame.bytes.len());
        let mut changed = false;
        let mut picture = false;
        loop {
            let nal = match reader.next_nal() {
                Ok(H26xNAL::H264(nal)) => nal,
                Err(RtcError::ErrIoEOF) => break,
                Err(error) => return Err(error.into()),
                _ => return Err(anyhow!("unexpected HEVC NAL")),
            };
            let parameter = match nal.unit_type {
                H264NalUnitType::SPS => Some(0),
                H264NalUnitType::PPS => Some(1),
                _ => None,
            };
            if let Some(index) = parameter {
                if self.parameters[index] != nal.data {
                    self.parameters[index] = nal.data.to_vec();
                    changed = true;
                }
            }
            picture |= matches!(
                nal.unit_type,
                H264NalUnitType::CodedSliceNonIdr | H264NalUnitType::CodedSliceIdr
            );
            avcc.extend_from_slice(&u32::try_from(nal.data.len())?.to_be_bytes());
            avcc.extend_from_slice(&nal.data);
        }
        if !picture && self.parameters.iter().any(|p| p.is_empty()) {
            return Ok(());
        }
        if changed || self.session.is_none() {
            ensure!(
                self.parameters.iter().all(|p| !p.is_empty()),
                "missing H264 parameter sets"
            );
            let format = checked(cm::VideoFormatDesc::with_h264_param_sets(
                &[self.parameters[0].as_ptr(), self.parameters[1].as_ptr()],
                &[self.parameters[0].len(), self.parameters[1].len()],
                4,
            ))?;
            if let Some(session) = self
                .session
                .as_mut()
                .filter(|session| session.session.can_accept_format_desc(&format))
            {
                session.format = format;
            } else {
                // All callbacks are complete. Retire only the incompatible
                // decoder; Frames, clock, encoders and RTP identities stay put.
                drop(self.session.take());
                let attrs = cf::Dictionary::with_keys_values(
                    &[
                        cv::pixel_buffer_keys::pixel_format(),
                        cv::pixel_buffer_keys::io_surf_props(),
                    ],
                    &[
                        cv::PixelFormat::_32_BGRA.to_cf_number(),
                        &*cf::Dictionary::new(),
                    ],
                )
                .context("decoder image attributes failed")?;
                let record = vt::DecompressionOutputCbRecord::new(&mut *self.output, Some(output));
                let session = checked(vt::DecompressionSession::new(
                    &format,
                    None,
                    Some(&attrs),
                    Some(&record),
                ))?;
                self.session = Some(Session { session, format });
            }
        }
        // Parameter-only AUs update the format but do not fabricate an image.
        if !picture {
            return Ok(());
        }
        let session = self.session.as_ref().unwrap();
        let mut block = checked(cm::ContiguousBlockBuf::new(avcc.len()))?;
        block.as_mut().copy_from_slice(&avcc);
        let timing = cm::SampleTimingInfo {
            duration: cm::Time::invalid(),
            pts: self.clock.timestamp(frame.presentation_time),
            dts: cm::Time::invalid(),
        };
        let length = avcc.len();
        let mut sample = None;
        // One owned AVCC block, one sample, one timing/size entry. CoreMedia
        // retains the block and copies these arrays during this call.
        unsafe {
            checked(cm::SampleBuf::create_in(
                None,
                Some(&block),
                true,
                None,
                std::ptr::null(),
                Some(&session.format),
                1,
                1,
                &timing,
                1,
                &length,
                &mut sample,
            ))?;
        }
        let sample = sample.context("H264 sample allocation returned no buffer")?;
        checked(
            session
                .session
                .decode(&sample, vt::DecodeFrameFlags::default()),
        )?;
        if let Some((image, pts)) = std::mem::replace(&mut self.output.result, Ok(None))? {
            let (width, height) = image.size();
            publish(
                image,
                self.clock.project(pts)?,
                Format {
                    width: width.round() as u32,
                    height: height.round() as u32,
                    fps: 30,
                },
            )?;
        }
        Ok(())
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        // Invalidate while the callback context and its transfer session live.
        drop(self.session.take());
    }
}
