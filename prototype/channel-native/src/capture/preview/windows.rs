use super::{dimensions, FRAME_TIMEOUT, MAX_PREVIEW_BYTES};
use crate::capture::Target;
use anyhow::{anyhow, ensure, Result};
use tokio::sync::oneshot;
use windows::{
    core::h,
    Foundation::{PropertyType, PropertyValue},
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapEncoder, BitmapInterpolationMode, BitmapPixelFormat,
        BitmapPropertySet, BitmapTypedValue,
    },
    Storage::Streams::{DataReader, InMemoryRandomAccessStream},
};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

type Pixels = (Vec<u8>, u32, u32);
struct Still(Option<oneshot::Sender<Result<Pixels>>>);
impl GraphicsCaptureApiHandler for Still {
    type Flags = oneshot::Sender<Result<Pixels>>;
    type Error = anyhow::Error;
    fn new(context: Context<Self::Flags>) -> Result<Self> {
        Ok(Self(Some(context.flags)))
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<()> {
        if let Some(sender) = self.0.take() {
            let pixels = (|| {
                let (width, height) = (frame.width(), frame.height());
                let buffer = frame.buffer()?;
                Ok((
                    buffer.as_nopadding_buffer(&mut Vec::new()).to_vec(),
                    width,
                    height,
                ))
            })();
            let _ = sender.send(pixels);
        }
        control.stop();
        Ok(())
    }
}

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
    let (first, image) = oneshot::channel();
    let capture = Still::start_free_threaded(Settings::new(
        target,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        first,
    ))?;
    let result: Result<Option<Pixels>> = tokio::runtime::Handle::current().block_on(async {
        tokio::select! {
            _ = completed.closed() => Ok(None),
            _ = &mut cancelled => Ok(None),
            image = tokio::time::timeout(FRAME_TIMEOUT, image) => Ok(Some(image???)),
        }
    });
    capture
        .stop()
        .map_err(|error| anyhow!("stop preview: {error}"))?;
    result?
        .map(|(bytes, width, height)| encode(&bytes, width, height))
        .transpose()
}

fn encode(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let stream = InMemoryRandomAccessStream::new()?;
    let options = BitmapPropertySet::new()?;
    options.Insert(
        h!("ImageQuality"),
        &BitmapTypedValue::Create(&PropertyValue::CreateSingle(0.7)?, PropertyType::Single)?,
    )?;
    let encoder = BitmapEncoder::CreateWithEncodingOptionsAsync(
        BitmapEncoder::JpegEncoderId()?,
        &stream,
        &options,
    )?
    .join()?;
    encoder.SetPixelData(
        BitmapPixelFormat::Bgra8,
        BitmapAlphaMode::Ignore,
        width,
        height,
        96.0,
        96.0,
        bytes,
    )?;
    let (width, height) = dimensions(width, height);
    let transform = encoder.BitmapTransform()?;
    transform.SetScaledWidth(width)?;
    transform.SetScaledHeight(height)?;
    transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    encoder.FlushAsync()?.join()?;
    let size = stream.Size()?;
    ensure!(
        size <= MAX_PREVIEW_BYTES as u64,
        "preview exceeds image limit"
    );
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    reader.LoadAsync(size as u32)?.join()?;
    let mut result = vec![0; size as usize];
    reader.ReadBytes(&mut result)?;
    Ok(result)
}
