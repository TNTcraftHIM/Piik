use super::{checked, Decoder, Frames, Image};
use crate::capture::{FrameTiming, Settings, VideoCodec};
use crate::EncodedFrame;
use anyhow::{ensure, Context as _, Result};
use cidre::{cf, cv};
use std::time::{Duration, Instant};

fn image(index: usize) -> Result<Image> {
    let attrs = cf::Dictionary::with_keys_values(
        &[cv::pixel_buffer_keys::io_surf_props()],
        &[&*cf::Dictionary::new()],
    )
    .context("synthetic image attributes")?;
    let mut pixels = checked(cv::PixelBuf::new(
        320,
        180,
        cv::PixelFormat::_32_BGRA,
        Some(&attrs),
    ))?;
    unsafe {
        checked(
            pixels
                .lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result(),
        )?
    };
    let filled = (|| -> Result<()> {
        let stride = pixels.bytes_per_row();
        let address = unsafe { pixels.base_address_mut() }.cast::<u8>();
        ensure!(
            !address.is_null() && stride >= 320 * 4,
            "invalid BGRA buffer"
        );
        // Only this new, locked image is mutable; unlock before publishing it.
        let bytes = unsafe { std::slice::from_raw_parts_mut(address, stride * 180) };
        let left = index * 7 % 280;
        for y in 0..180 {
            for x in 0..320 {
                let moving = (left..left + 40).contains(&x);
                let pixel = [
                    x as u8,
                    if moving { 255 } else { y as u8 },
                    (x ^ y) as u8,
                    255,
                ];
                bytes[y * stride + x * 4..y * stride + x * 4 + 4].copy_from_slice(&pixel);
            }
        }
        Ok(())
    })();
    let unlocked = unsafe { pixels.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT) };
    filled?;
    checked(unlocked.result())?;
    Ok(Image::copied(pixels, (320.0, 180.0)))
}

// Actual production VT encode/decode with synthetic CoreVideo images, no SC/TCC.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synthetic_h264_roundtrip_preserves_source_time_and_stops() -> Result<()> {
    let frames = Frames::new(FrameTiming::Source)?;
    let mut encoding = frames.encode(
        Settings {
            degradation_preference: piik_channel_core::wire::DegradationPreference::Balanced,
            width: 320,
            height: 180,
            fps: 30,
            bitrate: 500_000,
        },
        VideoCodec::H264,
    )?;
    let control = encoding.control();
    let mut decoder = Decoder::new(frames.clock())?;
    // Historical source time makes replacing it with encode/arrival time visible.
    let epoch = Instant::now() - Duration::from_secs(5);
    let forced_time = epoch + Duration::from_nanos(30 * 33_333_333);
    let mut published = Vec::new();
    let (mut aus, mut decoded) = (0, 0);
    let (mut last_au, mut last_decoded) = (None, None);
    let (mut forced_idr, mut decoded_after_force) = (false, false);
    let mut observe = |frame: EncodedFrame, published: &[Instant]| -> Result<bool> {
        ensure!(
            published.contains(&frame.presentation_time),
            "AU lost source time"
        );
        ensure!(
            last_au.is_none_or(|last| frame.presentation_time > last),
            "AU PTS reversed"
        );
        last_au = Some(frame.presentation_time);
        let types: Vec<_> = crate::media::h264::nals(&frame.bytes)?
            .map(|nal| nal[0] & 31)
            .collect();
        if aus == 0 {
            ensure!(
                frame.keyframe && [7, 8, 5].iter().all(|kind| types.contains(kind)),
                "first AU lacks SPS/PPS/IDR"
            );
        }
        forced_idr |=
            frame.presentation_time >= forced_time && frame.keyframe && types.contains(&5);
        aus += 1;
        decoder.decode(&frame, &mut |_, time, format| {
            ensure!(
                (format.width, format.height) == (320, 180),
                "decoded size changed"
            );
            ensure!(published.contains(&time), "decoder lost source time");
            ensure!(
                last_decoded.is_none_or(|last| time > last),
                "decoded PTS reversed"
            );
            last_decoded = Some(time);
            decoded += 1;
            decoded_after_force |= time >= forced_time;
            Ok(())
        })?;
        Ok(forced_idr && decoded_after_force)
    };
    let mut ticks = tokio::time::interval(Duration::from_nanos(33_333_333));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut roundtrip = false;
        while published.len() < 60 || !roundtrip {
            tokio::select! {
                _ = ticks.tick(), if published.len() < 60 => {
                    let index = published.len();
                    let time = epoch + Duration::from_nanos(index as u64 * 33_333_333);
                    if index == 30 { control.force_keyframe()?; }
                    published.push(time);
                    frames.publish(image(index)?, time);
                }
                frame = encoding.recv() => {
                    roundtrip = observe(frame.context("encoding ended before roundtrip")??, &published)?;
                }
            }
        }
        Ok::<_, anyhow::Error>(())
    }).await.context("synthetic VT roundtrip timed out")??;
    frames.finish(None);
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(frame) = encoding.recv().await {
            observe(frame?, &published)?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("source finish did not end encoding")??;
    drop(observe);
    ensure!(
        aus > 1 && decoded > 1 && forced_idr && decoded_after_force,
        "no decoded progress through forced IDR"
    );
    ensure!(control.is_stopped(), "encoding control remained active");
    tokio::time::timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(move || encoding.stop()),
    )
    .await
    .context("encoding join timed out")???;
    eprintln!("synthetic VT roundtrip: aus={aus} decoded={decoded} sourcePTS=preserved forcedIDR=true joined=true");
    Ok(())
}
