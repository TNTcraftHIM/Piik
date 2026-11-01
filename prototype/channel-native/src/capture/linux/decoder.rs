//! One incoming AU stream owns one decoder pipeline and its raw-frame output.
use super::{message_error, Frames, Pipeline};
use crate::capture::Format;
use crate::EncodedFrame;
use anyhow::{anyhow, Context as _, Result};
use futures_util::{SinkExt, Stream, StreamExt};
use gst::prelude::*;
use std::sync::Arc;
use tokio::sync::watch;

/// Assembly, source identity and keyframe requests remain with the media owner.
pub(crate) async fn run(
    access_units: impl Stream<Item = Arc<EncodedFrame>> + Send,
    frames: Frames,
    format: watch::Sender<Option<Format>>,
) -> Result<()> {
    let result = async {
        let clock = frames.clock();
        let control = frames.control();
        let pipeline = Pipeline(gst::Pipeline::new());
        clock.pipeline(&pipeline.0);
        let caps = gst::Caps::builder("video/x-h264")
            .field("stream-format", "byte-stream")
            .field("alignment", "au")
            .build();
        let source = gst_app::AppSrc::builder()
            .caps(&caps)
            .is_live(true)
            .format(gst::Format::Time)
            .do_timestamp(false)
            .block(false)
            .max_bytes(1)
            .build();
        let parser = gst::ElementFactory::make("h264parse").build()?;
        let decoder = gst::ElementFactory::make("decodebin3").build()?;
        let sink = gst_app::AppSink::builder()
            .caps(&gst::Caps::builder("video/x-raw").build())
            .max_buffers(1)
            .drop(false)
            .sync(false)
            .async_(false)
            .wait_on_eos(false)
            .build();
        let sink_pad = sink.static_pad("sink").context("decoder sink pad missing")?;
        decoder.connect_pad_added(move |decoder, pad| {
            if let Err(error) = pad.link(&sink_pad) {
                gst::element_error!(decoder, gst::StreamError::Failed, ("decoder output link failed: {error}"));
            }
        });
        pipeline.0.add_many([
            source.upcast_ref(),
            &parser,
            &decoder,
            sink.upcast_ref(),
        ])?;
        gst::Element::link_many([source.upcast_ref(), &parser, &decoder])?;
        let mut messages = pipeline
            .0
            .bus()
            .context("decoder bus missing")?
            .stream_filtered(&[gst::MessageType::Error, gst::MessageType::Eos]);
        pipeline.0.set_state(gst::State::Playing)?;
        let mut samples = sink.stream();
        let mut input = source.sink();
        let mut access_units = Box::pin(access_units);
        let mut pending = None::<gst::Sample>;
        loop {
            tokio::select! {
                biased;
                _ = control.stopped() => return Ok(()),
                message = messages.next() => {
                    return Err(message.as_deref().and_then(message_error)
                        .unwrap_or_else(|| anyhow!("decoder bus closed")));
                },
                sample = samples.next() => {
                    let sample = sample.context("decoder output ended")?;
                    let raw = frames.frame(&sample)?;
                    let fps = raw.info.fps();
                    let current = Format {
                        width: raw.info.width(),
                        height: raw.info.height(),
                        fps: if fps.numer() > 0 && fps.denom() > 0 {
                            (fps.numer() as u32).div_ceil(fps.denom() as u32)
                        } else {
                            30
                        },
                    };
                    frames.publish_frame(raw);
                    format.send_if_modified(|previous| {
                        if *previous == Some(current) {
                            false
                        } else {
                            *previous = Some(current);
                            true
                        }
                    });
                },
                sent = async { input.send(pending.as_ref().unwrap().clone()).await }, if pending.is_some() => {
                    sent?;
                    pending = None;
                },
                frame = access_units.next(), if pending.is_none() => {
                    let Some(frame) = frame else {
                        return Ok(());
                    };
                    let mut buffer = gst::Buffer::from_mut_slice(frame.bytes.clone());
                    let writable = buffer.make_mut();
                    writable.set_pts(clock.timestamp(frame.presentation_time)?);
                    writable.set_dts(gst::ClockTime::NONE);
                    if !frame.keyframe {
                        writable.set_flags(gst::BufferFlags::DELTA_UNIT);
                    }
                    pending = Some(gst::Sample::builder().buffer(&buffer).caps(&caps).build());
                },
            }
        }
    }.await;
    frames.finish(result.as_ref().err().map(|error| format!("{error:#}")));
    result
}

#[cfg(test)]
mod tests {
    use super::super::{Encoding, RawFrame};
    use super::*;
    use crate::capture::{FrameTiming, Settings};
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;

    fn software_encoder() -> Result<gst::Element> {
        Ok(gst::ElementFactory::make("x264enc")
            .property_from_str("tune", "zerolatency")
            .property_from_str("speed-preset", "ultrafast")
            .build()?)
    }
    fn publish(frames: &Frames, time: Instant, color: u8) -> Result<()> {
        let info = gst_video::VideoInfo::builder(gst_video::VideoFormat::Bgra, 96, 64)
            .fps(gst::Fraction::new(30, 1))
            .build()?;
        frames.publish_frame(RawFrame {
            buffer: gst::Buffer::from_mut_slice(vec![color; info.size()]),
            info,
            time,
        });
        Ok(())
    }
    async fn next(encoding: &mut Encoding) -> Result<EncodedFrame> {
        tokio::time::timeout(Duration::from_secs(3), encoding.recv())
            .await?
            .context("encoding ended")?
    }
    async fn stop(encoding: Encoding) -> Result<()> {
        tokio::time::timeout(
            Duration::from_secs(3),
            tokio::task::spawn_blocking(move || encoding.stop()),
        )
        .await???;
        Ok(())
    }

    /// Actual Gst AU -> decoder -> owned Frames -> independent software test
    /// encoders. Hardware selection and portal capture are outside this test.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn incoming_source_time_static_pli_and_independent_encoding_stop() -> Result<()> {
        let upstream = Frames::new(FrameTiming::Source)?;
        let settings = Settings {
            width: 96,
            height: 64,
            fps: 1,
            bitrate: 200_000,
        };
        let mut original =
            Encoding::start_with_encoder(upstream.clone(), settings, software_encoder()?)?;
        let frames = Frames::new(FrameTiming::Source)?;
        let mut slow = Encoding::start_with_encoder(frames.clone(), settings, software_encoder()?)?;
        let mut healthy =
            Encoding::start_with_encoder(frames.clone(), settings, software_encoder()?)?;
        let (send, receive) = mpsc::channel(1);
        let access_units = futures_util::stream::unfold(receive, |mut receive| async move {
            receive.recv().await.map(|frame| (frame, receive))
        });
        let (format, formats) = watch::channel(None);
        let decoded = tokio::spawn(run(access_units, frames.clone(), format));
        let first_time = Instant::now() - Duration::from_secs(5);
        publish(&upstream, first_time, 32)?;
        let first = next(&mut original).await?;
        assert_eq!(first.presentation_time, first_time);
        send.send(Arc::new(first)).await?;
        let first = next(&mut healthy).await?;
        assert_eq!(first.presentation_time, first_time);
        assert!(first.keyframe && first.presentation_time.elapsed() >= Duration::from_secs(5));
        assert_eq!(next(&mut slow).await?.presentation_time, first_time);
        assert_eq!(
            formats.borrow().as_ref().map(|f| (f.width, f.height)),
            Some((96, 64))
        );

        healthy.control().force_keyframe()?;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), healthy.recv())
                .await
                .is_err(),
            "source PLI must not manufacture a cached wall-now AU"
        );
        original.control().force_keyframe()?;
        let second_time = first_time + Duration::from_millis(33);
        publish(&upstream, second_time, 128)?;
        let second = next(&mut original).await?;
        assert!(second.keyframe);
        send.send(Arc::new(second)).await?;
        let second = next(&mut healthy).await?;
        assert!(second.keyframe);
        assert_eq!(second.presentation_time, second_time);

        // Retire one actual pipeline; the other keeps the same source clock.
        stop(slow).await?;
        let third_time = second_time + Duration::from_millis(33);
        publish(&upstream, third_time, 220)?;
        send.send(Arc::new(next(&mut original).await?)).await?;
        assert_eq!(next(&mut healthy).await?.presentation_time, third_time);
        frames.control().stop();
        drop(send);
        tokio::time::timeout(Duration::from_secs(3), decoded).await???;
        assert!(tokio::time::timeout(Duration::from_secs(3), healthy.recv())
            .await?
            .is_none());
        stop(healthy).await?;
        upstream.finish(None);
        stop(original).await?;
        Ok(())
    }
}
