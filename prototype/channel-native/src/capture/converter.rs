//! Each encoding owns its GPU scaling and BGRA-to-NV12 conversion.
use super::Settings;
use anyhow::Result;
use std::mem::ManuallyDrop;
use windows::{
    core::Interface,
    Win32::{
        Foundation::RECT,
        Graphics::{Direct3D11::*, Dxgi::Common::*},
    },
};

// Both VP8 and H264 share the WebRTC SDR representation. VP8 has no VUI.
pub(super) const SDR_VIDEO_COLOR: DXGI_COLOR_SPACE_TYPE =
    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601;
const DESKTOP_COLOR: DXGI_COLOR_SPACE_TYPE = DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709;

pub(super) struct Converter {
    device: ID3D11Device,
    video: ID3D11VideoDevice,
    context: ID3D11VideoContext1,
    settings: Settings,
    output_format: DXGI_FORMAT,
    processor: Option<Processor>,
    rgb: Option<Box<Self>>,
}
struct Processor {
    input_width: u32,
    input_height: u32,
    input_format: DXGI_FORMAT,
    input_color_space: DXGI_COLOR_SPACE_TYPE,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
}
impl Converter {
    pub fn new(device: &ID3D11Device, settings: Settings) -> Result<Self> {
        Self::with_format(device, settings, DXGI_FORMAT_NV12)
    }
    fn with_format(
        device: &ID3D11Device,
        settings: Settings,
        output_format: DXGI_FORMAT,
    ) -> Result<Self> {
        Ok(Self {
            device: device.clone(),
            video: device.cast()?,
            context: unsafe { device.GetImmediateContext()? }.cast()?,
            settings,
            output_format,
            processor: None,
            rgb: None,
        })
    }
    pub fn convert(
        &mut self,
        source_texture: &ID3D11Texture2D,
        color_space: DXGI_COLOR_SPACE_TYPE,
    ) -> Result<ID3D11Texture2D> {
        unsafe {
            let mut source_desc = D3D11_TEXTURE2D_DESC::default();
            source_texture.GetDesc(&mut source_desc);
            if self.output_format == DXGI_FORMAT_NV12
                && source_desc.Format == DXGI_FORMAT_NV12
                && color_space != SDR_VIDEO_COLOR
            {
                // Some NVIDIA/AMD drivers leave matrix/range unchanged in a
                // direct YUV-to-YUV blit. Normalize through RGB on the GPU.
                if self.rgb.is_none() {
                    self.rgb = Some(Box::new(Self::with_format(
                        &self.device,
                        self.settings,
                        DXGI_FORMAT_B8G8R8A8_UNORM,
                    )?));
                }
                let rgb = self
                    .rgb
                    .as_mut()
                    .unwrap()
                    .convert(source_texture, color_space)?;
                return self.convert(&rgb, DESKTOP_COLOR);
            }
            let (input_width, input_height) = (source_desc.Width, source_desc.Height);
            let (width, height) = (self.settings.width, self.settings.height);
            if self.processor.as_ref().is_none_or(|p| {
                p.input_width != input_width
                    || p.input_height != input_height
                    || p.input_format != source_desc.Format
                    || p.input_color_space != color_space
            }) {
                let enumerator = self.video.CreateVideoProcessorEnumerator(
                    &D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                        InputFrameRate: DXGI_RATIONAL {
                            Numerator: self.settings.fps,
                            Denominator: 1,
                        },
                        InputWidth: input_width,
                        InputHeight: input_height,
                        OutputFrameRate: DXGI_RATIONAL {
                            Numerator: self.settings.fps,
                            Denominator: 1,
                        },
                        OutputWidth: width,
                        OutputHeight: height,
                        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                    },
                )?;
                let processor = self.video.CreateVideoProcessor(&enumerator, 0)?;
                self.context
                    .VideoProcessorSetStreamColorSpace1(&processor, 0, color_space);
                self.context.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    if self.output_format == DXGI_FORMAT_NV12 {
                        SDR_VIDEO_COLOR
                    } else {
                        DESKTOP_COLOR
                    },
                );
                let source = RECT {
                    left: 0,
                    top: 0,
                    right: input_width as i32,
                    bottom: input_height as i32,
                };
                let output = RECT {
                    left: 0,
                    top: 0,
                    right: width as i32,
                    bottom: height as i32,
                };
                self.context
                    .VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&source));
                self.context
                    .VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&output));
                self.context
                    .VideoProcessorSetOutputTargetRect(&processor, true, Some(&output));
                self.context.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                self.context
                    .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
                self.processor = Some(Processor {
                    input_width,
                    input_height,
                    input_format: source_desc.Format,
                    input_color_space: color_space,
                    enumerator,
                    processor,
                });
            }
            let converter = self.processor.as_ref().unwrap();
            let mut texture = None;
            self.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: self.output_format,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut texture),
            )?;
            let texture = texture.unwrap();
            let mut input = None;
            self.video.CreateVideoProcessorInputView(
                source_texture,
                &converter.enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut input),
            )?;
            let mut output = None;
            self.video.CreateVideoProcessorOutputView(
                &texture,
                &converter.enumerator,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut output),
            )?;
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input),
                ..Default::default()
            };
            let result = self.context.VideoProcessorBlt(
                &converter.processor,
                output.as_ref().unwrap(),
                0,
                std::slice::from_ref(&stream),
            );
            drop(ManuallyDrop::take(&mut stream.pInputSurface));
            result?;
            Ok(texture)
        }
    }
}
