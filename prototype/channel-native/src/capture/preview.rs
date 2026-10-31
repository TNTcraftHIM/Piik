//! A picker-owned still image; never a publication or a retained asset.
use super::{Target, TargetKind};
use anyhow::Result;
use tokio::sync::oneshot;

#[cfg(all(feature = "capture", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "capture", target_os = "windows"))]
mod windows;

pub const MAX_PREVIEW_BYTES: usize = 64 * 1024;

#[cfg(all(feature = "capture", any(target_os = "windows", target_os = "macos")))]
const FRAME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(all(feature = "capture", any(target_os = "windows", target_os = "macos")))]
fn dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = (320.0 / width as f64).min(180.0 / height as f64).min(1.0);
    (
        (width as f64 * scale).max(1.0) as u32,
        (height as f64 * scale).max(1.0) as u32,
    )
}

/// Cancellation is acknowledged only after the independent capture is joined.
/// Dropping this future also wakes its worker; no image survives its picker.
pub async fn preview(target: Target, cancelled: oneshot::Receiver<()>) -> Result<Option<String>> {
    if matches!(target.kind, TargetKind::Picker) {
        return Ok(None);
    }
    #[cfg(all(feature = "capture", any(target_os = "windows", target_os = "macos")))]
    {
        use base64::Engine;
        let (mut completed, image) = oneshot::channel();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            let result = windows::capture(target, &mut completed, cancelled);
            #[cfg(target_os = "macos")]
            let result = macos::capture(target, &mut completed, cancelled);
            let _ = completed.send(result);
        });
        let Some(bytes) = image.await?? else {
            return Ok(None);
        };
        anyhow::ensure!(
            bytes.len() <= MAX_PREVIEW_BYTES,
            "preview exceeds image limit"
        );
        Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }
    #[cfg(not(all(feature = "capture", any(target_os = "windows", target_os = "macos"))))]
    {
        let _ = cancelled;
        Ok(None)
    }
}
