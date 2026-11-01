use super::{dimensions, FRAME_TIMEOUT, MAX_PREVIEW_BYTES};
use crate::capture::{
    sdr::{DisplayColor, Sdr},
    Target,
};
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
    Win32::Graphics::Direct3D11::*,
};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    settings::{
        CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

type Pixels = (Vec<u8>, u32, u32);
struct Still {
    sender: Option<oneshot::Sender<Result<Pixels>>>,
    display: DisplayColor,
    sdr: Sdr,
    device: ID3D11Device,
}
impl GraphicsCaptureApiHandler for Still {
    type Flags = (oneshot::Sender<Result<Pixels>>, DisplayColor);
    type Error = anyhow::Error;
    fn new(context: Context<Self::Flags>) -> Result<Self> {
        Ok(Self {
            sender: Some(context.flags.0),
            display: context.flags.1,
            sdr: Sdr::new(&context.device)?,
            device: context.device,
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<()> {
        if let Some(sender) = self.sender.take() {
            let pixels = (|| {
                let (width, height) = (frame.width(), frame.height());
                let color = self.display.resolve();
                ensure!(
                    color.format() == frame.color_format(),
                    "preview color format changed"
                );
                if color.hdr {
                    let texture = self.sdr.convert(frame.as_raw_texture(), color)?;
                    return Ok((read_pixels(&self.device, &texture)?, width, height));
                }
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

fn read_pixels(device: &ID3D11Device, texture: &ID3D11Texture2D) -> Result<Vec<u8>> {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging = None;
        device.CreateTexture2D(&desc, None, Some(&mut staging))?;
        let staging = staging.unwrap();
        let context = device.GetImmediateContext()?;
        context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let mut bytes = Vec::with_capacity(desc.Width as usize * desc.Height as usize * 4);
        for row in 0..desc.Height as usize {
            bytes.extend_from_slice(std::slice::from_raw_parts(
                mapped
                    .pData
                    .cast::<u8>()
                    .add(row * mapped.RowPitch as usize),
                desc.Width as usize * 4,
            ));
        }
        context.Unmap(&staging, 0);
        Ok(bytes)
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
    let mut display = DisplayColor::new(&target)?;
    let color = display.resolve();
    let capture = Still::start_free_threaded(Settings::new(
        target,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        color.format(),
        (first, display),
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
