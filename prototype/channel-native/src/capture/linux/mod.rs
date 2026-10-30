//! Portal-owned capture and independent GStreamer media workers.
mod audio;
mod encoding;
mod frames;
mod portal;
mod source;

pub use audio::{audio_capabilities, AudioCapture, AudioControl};
pub use encoding::{Encoding, EncodingControl};
pub use frames::{Clock, Frames, RawFrame};
pub use source::{targets, Capture, Control};

use gst::prelude::*;

/// Every partial initialization and terminal path releases the native pipeline.
struct Pipeline(gst::Pipeline);
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
