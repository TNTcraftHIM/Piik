//! Portal-owned capture and independent GStreamer media workers.
mod audio;
pub(crate) mod decoder;
mod encoding;
mod frames;
mod source;

pub use audio::{audio_capabilities, microphones, AudioCapture, AudioControl};
pub(super) use encoding::encoding_available;
pub use encoding::{Encoding, EncodingControl};
pub use frames::{Clock, Frames, RawFrame};
pub use source::{targets, Capture, Control};

use futures_util::{FutureExt, Stream, StreamExt};
use gst::prelude::*;

/// Every partial initialization and terminal path releases the native pipeline.
struct Pipeline(gst::Pipeline);
impl Pipeline {
    fn set_state(
        &self,
        state: gst::State,
        messages: &mut (impl Stream<Item = gst::Message> + Unpin),
    ) -> anyhow::Result<()> {
        self.0.set_state(state).map(|_| ()).map_err(|failure| {
            // BusStream already owns the bus messages. Inspect any queued
            // cause before dropping the failed pipeline and its stream.
            while let Some(Some(message)) = messages.next().now_or_never() {
                if matches!(message.view(), gst::MessageView::Error(_)) {
                    if let Some(error) = message_error(&message) {
                        return error.context(format!("GStreamer {state:?} initialization failed"));
                    }
                }
            }
            anyhow::Error::from(failure)
                .context(format!("GStreamer {state:?} initialization failed"))
        })
    }
}
impl Drop for Pipeline {
    fn drop(&mut self) {
        if let Err(error) = self.0.set_state(gst::State::Null) {
            eprintln!("GStreamer pipeline cleanup: {error}");
        }
    }
}

fn message_error(message: &gst::MessageRef) -> Option<anyhow::Error> {
    match message.view() {
        gst::MessageView::Error(error) => Some(anyhow::anyhow!(
            "{}: {} ({})",
            error.src().map(|s| s.path_string()).unwrap_or_default(),
            error.error(),
            error.debug().unwrap_or_default(),
        )),
        gst::MessageView::Eos(_) => Some(anyhow::anyhow!("capture stream ended")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_failure_retains_queued_source_error() -> anyhow::Result<()> {
        gst::init()?;
        let directory = tempfile::tempdir()?;
        let missing = directory.path().join("missing-media");
        let pipeline = Pipeline(gst::Pipeline::new());
        let source = gst::ElementFactory::make("filesrc")
            .name("initialization-source")
            .property("location", missing.to_str().unwrap())
            .build()?;
        let sink = gst::ElementFactory::make("fakesink").build()?;
        pipeline.0.add_many([&source, &sink])?;
        source.link(&sink)?;
        let mut messages = pipeline.0.bus().unwrap().stream();
        let error = pipeline
            .set_state(gst::State::Playing, &mut messages)
            .unwrap_err();
        let detail = format!("{error:#}");
        assert!(detail.contains("initialization-source"), "{detail}");
        assert!(
            detail.contains(missing.file_name().unwrap().to_str().unwrap()),
            "{detail}"
        );
        assert!(detail.contains("Playing"), "{detail}");
        Ok(())
    }
}
