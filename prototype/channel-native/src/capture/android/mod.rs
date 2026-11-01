//! One authorized projection, immutable source images and independent codec workers.
mod audio;
mod encoding;
mod frames;
mod graphics;
mod platform;
mod source;

use crate::capture::{AudioCapabilities, Target, TargetKind};
use anyhow::Result;
pub use audio::{AudioCapture, AudioControl};
pub use encoding::{Encoding, EncodingControl};
pub use source::{Capture, Control};

pub fn targets() -> Result<Vec<Target>> {
    Ok(vec![Target {
        kind: TargetKind::Picker,
        source_id: "0".into(),
        title: "Screen or app".into(),
        pid: 0,
        creation_time: None,
    }])
}
pub fn audio_capabilities() -> AudioCapabilities {
    AudioCapabilities {
        process_audio: false,
        process_audio_exclusion: false,
        system_audio: true,
    }
}
pub(super) fn activation_url() -> Result<String> {
    platform::activation_url()
}
