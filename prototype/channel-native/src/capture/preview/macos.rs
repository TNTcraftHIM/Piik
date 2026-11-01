use super::{dimensions, FRAME_TIMEOUT, MAX_PREVIEW_BYTES};
use crate::capture::{
    macos::{Capture, Image},
    Target,
};
use anyhow::{anyhow, ensure, Context as _, Result};
use cidre::{cf, cg, objc, vt};
use tokio::sync::oneshot;

pub(super) fn capture(
    target: Target,
    completed: &mut oneshot::Sender<Result<Option<Vec<u8>>>>,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Option<Vec<u8>>> {
    if completed.is_closed()
        || !matches!(
            cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        )
    {
        return Ok(None);
    }
    let capture = Capture::start(target, 1, false)?;
    let frames = capture.frames();
    let result: Result<Option<Image>> = tokio::runtime::Handle::current().block_on(async {
        tokio::select! {
            _ = completed.closed() => Ok(None),
            _ = &mut cancelled => Ok(None),
            frame = tokio::time::timeout(FRAME_TIMEOUT, frames.recv_after(None)) =>
                Ok(frame??.map(|frame| frame.image)),
        }
    });
    capture.stop()?;
    result?.map(encode).transpose()
}

fn encode(image: Image) -> Result<Vec<u8>> {
    use cg::image::destination::OptKey;
    let _pool = objc::AutoreleasePoolPage::push();
    let image = vt::cg_image_from_cv_pixel_buf(image.pixels(), None)
        .map_err(|error| anyhow!("{error:?}"))?;
    let (width, height) = dimensions(image.width() as u32, image.height() as u32);
    let edge = cf::Number::from_i32(width.max(height) as i32);
    let quality = cf::Number::from_f64(0.7);
    let properties = cf::Dictionary::with_keys_values(
        &[
            OptKey::image_max_pixel_size(),
            OptKey::lossy_compression_quality(),
        ],
        &[&edge, &quality],
    )
    .context("preview properties allocation failed")?;
    let mut data = cf::DataMut::with_capacity(0);
    let mut destination =
        cg::ImageDst::with_data(&mut data, &cf::String::from_str("public.jpeg"), 1)
            .context("JPEG destination unavailable")?;
    // ImageIO's per-image options accept these documented destination keys;
    // cidre's AddOptKey wrapper lists only the newer gain-map-specific key.
    // SAFETY: DictionaryOf is transparent over this immutable CFDictionary.
    let properties = unsafe { &*(properties.as_ref() as *const cf::Dictionary).cast() };
    destination.add_image(&image, Some(properties));
    ensure!(destination.finalize(), "preview encoding failed");
    ensure!(
        data.len() <= MAX_PREVIEW_BYTES,
        "preview exceeds image limit"
    );
    Ok(data.as_slice().to_vec())
}
