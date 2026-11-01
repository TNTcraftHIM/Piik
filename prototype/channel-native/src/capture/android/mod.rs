//! One authorized projection, immutable source images and independent codec workers.
mod audio;
mod encoding;
mod frames;
mod graphics;
mod platform;
mod source;

use crate::capture::{AudioCapabilities, MicrophoneDevice, Target, TargetKind};
use anyhow::Result;
pub use audio::{AudioCapture, AudioControl};
pub use encoding::{Encoding, EncodingControl};
use jni::{jni_sig, jni_str, objects::JString};
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

pub fn microphones() -> Result<Vec<MicrophoneDevice>> {
    platform::Platform::microphone(String::new())?.with(|env, object| {
        let list = env
            .call_method(
                object,
                jni_str!("devices"),
                jni_sig!(() -> java.lang.String),
                &[],
            )?
            .l()?;
        let list = JString::cast_local(env, list)?
            .mutf8_chars(env)?
            .to_string();
        Ok(serde_json::from_str(&list)?)
    })
}
