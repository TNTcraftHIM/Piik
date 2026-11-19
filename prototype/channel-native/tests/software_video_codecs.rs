#![cfg(all(windows, feature = "capture"))]

#[test]
fn probe_releases_software_encoder_before_media_foundation_shutdown() -> anyhow::Result<()> {
    piik_channel_native::capture::software_video_codecs()?;
    Ok(())
}
