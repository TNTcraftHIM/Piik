//! ScreenCaptureKit source owners and independent VideoToolbox encodings.
mod audio;
mod encoding;
mod frames;
mod source;

pub use audio::{audio_capabilities, AudioCapture, AudioControl};
pub use encoding::{Encoding, EncodingControl};
pub use frames::{Clock, Control, Frames, Image, RawFrame};
pub use source::{targets, Capture};

fn checked<T, E: std::fmt::Debug>(result: Result<T, E>) -> anyhow::Result<T> {
    result.map_err(|error| anyhow::anyhow!("{error:?}"))
}
