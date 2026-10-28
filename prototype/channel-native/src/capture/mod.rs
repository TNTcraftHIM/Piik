//! Native video producer, independent of rooms, RTP and presentation.
#[cfg(target_os = "windows")]
mod mf;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{targets, Capture, Control};

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Window,
    Display,
}

/// The existing picker identity. Window handles are fenced by process creation.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kind: TargetKind,
    pub source_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_time: Option<String>,
}
fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}
impl Settings {
    fn validate(self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.width > 0
                && self.height > 0
                && self.width % 2 == 0
                && self.height % 2 == 0
                && self.width <= i32::MAX as u32
                && self.height <= i32::MAX as u32,
            "capture dimensions must be positive even rectangle dimensions"
        );
        anyhow::ensure!(
            self.fps > 0 && self.bitrate > 0,
            "capture fps and bitrate must be positive"
        );
        Ok(())
    }
}

#[derive(Debug)]
pub struct EncodedFrame {
    /// One complete H264 Annex B access unit, including the encoder's parameter sets.
    pub bytes: Vec<u8>,
    /// Capture presentation time, independent of encoding/delivery delay.
    /// A static-image IDR reuses the latest image at the current time.
    pub presentation_time: std::time::Instant,
    pub keyframe: bool,
}
