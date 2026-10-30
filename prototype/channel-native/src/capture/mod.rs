//! Native capture producers, independent of rooms and RTP.
#[cfg(all(feature = "capture", target_os = "windows"))]
mod audio;
#[cfg(any(feature = "capture", test))]
mod cadence;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod converter;
#[cfg(any(all(feature = "capture", target_os = "windows"), test))]
mod frame_dropper;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod gpu;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod job;
#[cfg(all(feature = "capture", target_os = "linux"))]
mod linux;
#[cfg(all(feature = "capture", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod mf;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod output;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod process;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod windows;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod worker;
#[cfg(all(feature = "capture", target_os = "windows"))]
pub use audio::{audio_capabilities, AudioCapture, AudioControl};
#[cfg(all(feature = "capture", target_os = "linux"))]
pub use linux::{
    audio_capabilities, targets, AudioCapture, AudioControl, Capture, Control, Encoding,
    EncodingControl,
};
#[cfg(all(feature = "capture", target_os = "macos"))]
pub use macos::{
    audio_capabilities, targets, AudioCapture, AudioControl, Capture, Control, Encoding,
    EncodingControl,
};
#[cfg(all(feature = "capture", target_os = "windows"))]
pub use process::{Encoding, EncodingControl};
#[cfg(all(feature = "capture", target_os = "windows"))]
pub use windows::targets;
#[cfg(all(feature = "capture", target_os = "windows"))]
pub use windows::{Capture, Control};
#[cfg(all(feature = "capture", target_os = "windows"))]
pub use worker::worker_entry;

/// Keep this guard at the process entry point, outside the async runtime.
/// WinRT caches agile factories across captures; their MTA must outlive every
/// worker, including the idle gaps between captures and capability probes.
pub struct Runtime {
    #[cfg(all(feature = "capture", target_os = "windows"))]
    mta: ::windows::Win32::System::Com::CO_MTA_USAGE_COOKIE,
}
impl Runtime {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            #[cfg(all(feature = "capture", target_os = "windows"))]
            mta: unsafe { ::windows::Win32::System::Com::CoIncrementMTAUsage()? },
        })
    }
}
#[cfg(all(feature = "capture", target_os = "windows"))]
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = unsafe { ::windows::Win32::System::Com::CoDecrementMTAUsage(self.mta) };
    }
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCapabilities {
    pub process_audio: bool,
    pub system_audio: bool,
}

#[cfg(not(feature = "capture"))]
pub fn audio_capabilities() -> AudioCapabilities {
    AudioCapabilities::default()
}

#[derive(Debug)]
pub struct AudioFrame {
    /// 960 interleaved stereo sample frames (20 ms at 48 kHz).
    pub samples: Vec<f32>,
    /// The first sample's capture time, never buffer delivery time.
    pub presentation_time: std::time::Instant,
}

/// WGC and WASAPI both timestamp capture in QPC units of 100 ns.
#[cfg(all(feature = "capture", target_os = "windows"))]
#[derive(Clone, Copy)]
struct CaptureClock {
    frequency: i64,
    qpc: i64,
    instant: std::time::Instant,
}
#[cfg(all(feature = "capture", target_os = "windows"))]
impl CaptureClock {
    fn new() -> anyhow::Result<Self> {
        let mut frequency = 0;
        let mut ticks = 0;
        unsafe {
            ::windows::Win32::System::Performance::QueryPerformanceFrequency(&mut frequency)?;
            ::windows::Win32::System::Performance::QueryPerformanceCounter(&mut ticks)?;
        }
        Ok(Self {
            frequency,
            qpc: ((ticks as i128) * 10_000_000 / frequency as i128) as i64,
            instant: std::time::Instant::now(),
        })
    }
    fn now(&self) -> anyhow::Result<i64> {
        let mut ticks = 0;
        unsafe { ::windows::Win32::System::Performance::QueryPerformanceCounter(&mut ticks)? };
        Ok(((ticks as i128) * 10_000_000 / self.frequency as i128) as i64)
    }
    fn instant(&self, qpc: i64) -> std::time::Instant {
        let delta = qpc - self.qpc;
        let duration = std::time::Duration::from_nanos(delta.unsigned_abs() * 100);
        if delta >= 0 {
            self.instant + duration
        } else {
            self.instant - duration
        }
    }
    // Invert this exact capture anchor, not an encoding/IPC delivery timestamp.
    fn presentation_qpc(&self, time: std::time::Instant) -> i64 {
        if time >= self.instant {
            self.qpc + (time.duration_since(self.instant).as_nanos() / 100) as i64
        } else {
            self.qpc - (self.instant.duration_since(time).as_nanos() / 100) as i64
        }
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Window,
    Display,
    Picker,
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

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}
impl Settings {
    /// Fit within the source's natural pixel size and this encoding's ceiling.
    pub fn fitted(self, width: f64, height: f64) -> Self {
        let scale = (self.width as f64 / width)
            .min(self.height as f64 / height)
            .min(1.0);
        Self {
            width: ((width * scale) as u32 & !1).max(2),
            height: ((height * scale) as u32 & !1).max(2),
            ..self
        }
    }

    #[cfg(feature = "capture")]
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

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn encoding_ceiling_fits_the_source_without_enlarging_it() {
        let ceiling = Settings {
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 600_000,
        };
        for (source, expected) in [
            ((640.0, 360.0), (640, 360)),
            ((360.0, 640.0), (360, 640)),
            ((3840.0, 2160.0), (1920, 1080)),
            ((1080.0, 1920.0), (606, 1080)),
            ((641.0, 481.0), (640, 480)),
            ((200.5, 300.5), (200, 300)),
        ] {
            let fitted = ceiling.fitted(source.0, source.1);
            assert_eq!((fitted.width, fitted.height), expected);
            assert_eq!((fitted.fps, fitted.bitrate), (ceiling.fps, ceiling.bitrate));
        }
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
