//! Display-referred capture becomes owned SDR once, before preview or fanout.
use super::{Target, TargetKind};
use anyhow::{ensure, Result};
use windows::{
    core::Interface,
    Win32::{
        Devices::Display::*,
        Foundation::{ERROR_SUCCESS, HWND},
        Graphics::{
            Direct2D::{Common::*, *},
            Direct3D11::*,
            Dxgi::{Common::*, *},
            Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST},
        },
    },
};
use windows_capture::settings::ColorFormat;

#[derive(Clone, Copy, Debug)]
pub(super) struct Color {
    pub hdr: bool,
    pub white_nits: f32,
    pub peak_nits: f32,
}
impl Default for Color {
    fn default() -> Self {
        Self {
            hdr: false,
            white_nits: 80.0,
            peak_nits: 80.0,
        }
    }
}
impl Color {
    pub fn format(self) -> ColorFormat {
        if self.hdr {
            ColorFormat::Rgba16F
        } else {
            ColorFormat::Bgra8
        }
    }
    fn texture_format(self) -> DXGI_FORMAT {
        if self.hdr {
            DXGI_FORMAT_R16G16B16A16_FLOAT
        } else {
            DXGI_FORMAT_B8G8R8A8_UNORM
        }
    }
}

pub(super) struct DisplayColor {
    kind: TargetKind,
    source: usize,
    monitor: usize,
    factory: Option<IDXGIFactory1>,
    color: Color,
}
impl DisplayColor {
    pub fn new(target: &Target) -> Result<Self> {
        Ok(Self {
            kind: target.kind,
            source: target.source_id.parse()?,
            monitor: 0,
            factory: None,
            color: Color::default(),
        })
    }
    pub fn resolve(&mut self) -> Color {
        unsafe {
            let monitor = if self.kind == TargetKind::Window {
                MonitorFromWindow(HWND(self.source as _), MONITOR_DEFAULTTONEAREST)
            } else {
                HMONITOR(self.source as _)
            };
            if self.monitor == monitor.0 as usize
                && self
                    .factory
                    .as_ref()
                    .is_some_and(|f| f.IsCurrent().as_bool())
            {
                return self.color;
            }
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return if self.monitor == monitor.0 as usize {
                    self.color
                } else {
                    Color::default()
                };
            };
            let mut adapter_index = 0;
            while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
                adapter_index += 1;
                let mut output_index = 0;
                while let Ok(output) = adapter.EnumOutputs(output_index) {
                    output_index += 1;
                    let Ok(output) = output.cast::<IDXGIOutput6>() else {
                        continue;
                    };
                    let Ok(desc) = output.GetDesc1() else {
                        continue;
                    };
                    if desc.Monitor != monitor {
                        continue;
                    }
                    let mut color = Color::default();
                    color.hdr = desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
                    if color.hdr {
                        color.white_nits = white_level(&desc.DeviceName);
                        // WGC supplies no MaxCLL. Preserve the display's stable
                        // peak, or the HDR10 range when that metadata is absent.
                        let peak = if desc.MaxLuminance.is_finite() && desc.MaxLuminance > 0.0 {
                            desc.MaxLuminance
                        } else {
                            10_000.0
                        };
                        color.peak_nits = peak.max(color.white_nits);
                    }
                    self.monitor = monitor.0 as usize;
                    self.factory = Some(factory);
                    self.color = color;
                    return color;
                }
            }
            Color::default()
        }
    }
}

unsafe fn white_level(device: &[u16; 32]) -> f32 {
    let (mut path_count, mut mode_count) = (0, 0);
    if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        != ERROR_SUCCESS
    {
        return 80.0;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    if QueryDisplayConfig(
        QDC_ONLY_ACTIVE_PATHS,
        &mut path_count,
        paths.as_mut_ptr(),
        &mut mode_count,
        modes.as_mut_ptr(),
        None,
    ) != ERROR_SUCCESS
    {
        return 80.0;
    }
    for path in &paths[..path_count as usize] {
        let mut name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        name.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size: std::mem::size_of_val(&name) as u32,
            adapterId: path.sourceInfo.adapterId,
            id: path.sourceInfo.id,
        };
        if DisplayConfigGetDeviceInfo(&mut name.header) != 0
            || name.viewGdiDeviceName.split(|c| *c == 0).next() != device.split(|c| *c == 0).next()
        {
            continue;
        }
        let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL::default();
        white.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
            size: std::mem::size_of_val(&white) as u32,
            adapterId: path.targetInfo.adapterId,
            id: path.targetInfo.id,
        };
        if DisplayConfigGetDeviceInfo(&mut white.header) == 0 && white.SDRWhiteLevel > 0 {
            return white.SDRWhiteLevel as f32 * 80.0 / 1000.0;
        }
    }
    80.0
}

pub(super) struct Sdr {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    effects: Option<Effects>,
}
struct Effects {
    drawing: ID2D1DeviceContext,
    tone: ID2D1Effect,
    white: ID2D1Effect,
    srgb: ID2D1Effect,
}
impl Sdr {
    pub fn new(device: &ID3D11Device) -> Result<Self> {
        Ok(Self {
            device: device.clone(),
            context: unsafe { device.GetImmediateContext()? },
            effects: None,
        })
    }
    pub fn convert(&mut self, source: &ID3D11Texture2D, color: Color) -> Result<ID3D11Texture2D> {
        unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            source.GetDesc(&mut desc);
            ensure!(
                desc.Format == color.texture_format(),
                "capture color format changed"
            );
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            desc.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
            let mut owned = None;
            self.device.CreateTexture2D(&desc, None, Some(&mut owned))?;
            let owned = owned.unwrap();
            self.context.CopyResource(&owned, source);
            if !color.hdr {
                return Ok(owned);
            }
            if self.effects.is_none() {
                self.effects = Some(Effects::new(&self.device)?);
            }
            let e = self.effects.as_ref().unwrap();
            let properties = |format, bitmap_options| D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format,
                    alphaMode: D2D1_ALPHA_MODE_IGNORE,
                },
                dpiX: 96.0,
                dpiY: 96.0,
                bitmapOptions: bitmap_options,
                ..Default::default()
            };
            let input = e.drawing.CreateBitmapFromDxgiSurface(
                &owned.cast::<IDXGISurface>()?,
                Some(&properties(desc.Format, D2D1_BITMAP_OPTIONS_NONE)),
            )?;
            e.tone.SetValue(
                D2D1_HDRTONEMAP_PROP_INPUT_MAX_LUMINANCE.0 as u32,
                D2D1_PROPERTY_TYPE_FLOAT,
                &color.peak_nits.to_ne_bytes(),
            )?;
            e.tone.SetValue(
                D2D1_HDRTONEMAP_PROP_OUTPUT_MAX_LUMINANCE.0 as u32,
                D2D1_PROPERTY_TYPE_FLOAT,
                &color.white_nits.to_ne_bytes(),
            )?;
            e.white.SetValue(
                D2D1_WHITELEVELADJUSTMENT_PROP_OUTPUT_WHITE_LEVEL.0 as u32,
                D2D1_PROPERTY_TYPE_FLOAT,
                &color.white_nits.to_ne_bytes(),
            )?;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
            let mut output = None;
            self.device
                .CreateTexture2D(&desc, None, Some(&mut output))?;
            let output = output.unwrap();
            let target = e.drawing.CreateBitmapFromDxgiSurface(
                &output.cast::<IDXGISurface>()?,
                Some(&properties(
                    desc.Format,
                    D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                )),
            )?;
            let image = e.srgb.GetOutput()?;
            e.tone.SetInput(0, &input, true);
            e.drawing.SetTarget(&target);
            e.drawing.BeginDraw();
            e.drawing.DrawImage(
                &image,
                None,
                None,
                D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                D2D1_COMPOSITE_MODE_SOURCE_COPY,
            );
            let result = e.drawing.EndDraw(None, None);
            e.drawing.SetTarget(None::<&ID2D1Image>);
            e.tone.SetInput(0, None::<&ID2D1Image>, true);
            result?;
            Ok(output)
        }
    }
}
impl Effects {
    unsafe fn new(device: &ID3D11Device) -> Result<Self> {
        // WGC serializes our handler, but successive callbacks may use different
        // platform threads. Let Direct2D own its factory's thread protection.
        let factory: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_MULTI_THREADED, None)?;
        let drawing = factory
            .CreateDevice(&device.cast::<IDXGIDevice>()?)?
            .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
        drawing.SetRenderingControls(&D2D1_RENDERING_CONTROLS {
            bufferPrecision: D2D1_BUFFER_PRECISION_16BPC_FLOAT,
            ..Default::default()
        });
        let tone = drawing.CreateEffect(&CLSID_D2D1HdrToneMap)?;
        tone.SetValue(
            D2D1_HDRTONEMAP_PROP_DISPLAY_MODE.0 as u32,
            D2D1_PROPERTY_TYPE_ENUM,
            &(D2D1_HDRTONEMAP_DISPLAY_MODE_SDR.0 as u32).to_ne_bytes(),
        )?;
        let white = drawing.CreateEffect(&CLSID_D2D1WhiteLevelAdjustment)?;
        white.SetValue(
            D2D1_WHITELEVELADJUSTMENT_PROP_INPUT_WHITE_LEVEL.0 as u32,
            D2D1_PROPERTY_TYPE_FLOAT,
            &80.0f32.to_ne_bytes(),
        )?;
        white.SetInput(0, &tone.GetOutput()?, true);
        let srgb = drawing.CreateEffect(&CLSID_D2D1ColorManagement)?;
        let linear = drawing.CreateColorContext(D2D1_COLOR_SPACE_SCRGB, None)?;
        let rgb = drawing.CreateColorContext(D2D1_COLOR_SPACE_SRGB, None)?;
        srgb.SetValue(
            D2D1_COLORMANAGEMENT_PROP_SOURCE_COLOR_CONTEXT.0 as u32,
            D2D1_PROPERTY_TYPE_COLOR_CONTEXT,
            &(linear.as_raw() as usize).to_ne_bytes(),
        )?;
        srgb.SetValue(
            D2D1_COLORMANAGEMENT_PROP_DESTINATION_COLOR_CONTEXT.0 as u32,
            D2D1_PROPERTY_TYPE_COLOR_CONTEXT,
            &(rgb.as_raw() as usize).to_ne_bytes(),
        )?;
        srgb.SetValue(
            D2D1_COLORMANAGEMENT_PROP_QUALITY.0 as u32,
            D2D1_PROPERTY_TYPE_ENUM,
            &(D2D1_COLORMANAGEMENT_QUALITY_BEST.0 as u32).to_ne_bytes(),
        )?;
        srgb.SetInput(0, &white.GetOutput()?, true);
        Ok(Self {
            drawing,
            tone,
            white,
            srgb,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(device: &ID3D11Device, width: u32, hdr: bool) -> Result<ID3D11Texture2D> {
        // scRGB half-floats for 0, 5, 20, 80, 200, 400, 700 and 1000 nits.
        let levels = [0u16, 0x2c00, 0x3400, 0x3c00, 0x4100, 0x4500, 0x4860, 0x4a40];
        let half: Vec<_> = (0..width * 32)
            .flat_map(|pixel| {
                let value = levels[(pixel % width * 8 / width) as usize];
                [value, value, value, 0x3c00]
            })
            .collect();
        let bgra: Vec<_> = (0..width * 32).flat_map(|_| [5u8, 11, 24, 255]).collect();
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: if hdr {
                half.as_ptr().cast()
            } else {
                bgra.as_ptr().cast()
            },
            SysMemPitch: width * if hdr { 8 } else { 4 },
            ..Default::default()
        };
        let mut texture = None;
        unsafe {
            device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: 32,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: Color {
                        hdr,
                        ..Default::default()
                    }
                    .texture_format(),
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                    ..Default::default()
                },
                Some(&data),
                Some(&mut texture),
            )?;
        }
        Ok(texture.unwrap())
    }

    fn pixels(device: &ID3D11Device, texture: &ID3D11Texture2D) -> Result<Vec<u8>> {
        unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            assert_eq!(desc.Format, DXGI_FORMAT_B8G8R8A8_UNORM);
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
            let mut pixels = Vec::new();
            for row in 0..desc.Height as usize {
                pixels.extend_from_slice(std::slice::from_raw_parts(
                    mapped
                        .pData
                        .cast::<u8>()
                        .add(row * mapped.RowPitch as usize),
                    desc.Width as usize * 4,
                ));
            }
            context.Unmap(&staging, 0);
            Ok(pixels)
        }
    }

    #[test]
    fn gpu_hdr_tone_mapping_preserves_detail_and_owned_sdr_pixels() -> Result<()> {
        let _runtime = super::super::Runtime::new()?;
        let device = super::super::decoder::device()?;
        let mut converter = Sdr::new(&device)?;
        for width in [64, 128, 64] {
            let source = upload(&device, width, false)?;
            let original = pixels(&device, &source)?;
            let copied = converter.convert(&source, Color::default())?;
            assert_eq!(pixels(&device, &copied)?, original);
            let hdr = upload(&device, width, true)?;
            for white_nits in [80.0, 240.0, 80.0] {
                let mapped = converter.convert(
                    &hdr,
                    Color {
                        hdr: true,
                        white_nits,
                        peak_nits: 1000.0,
                    },
                )?;
                let before = pixels(&device, &mapped)?;
                let mut levels = Vec::new();
                for bar in 0..8 {
                    let index = (width * (2 * bar + 1) / 16) as usize * 4;
                    assert!(before[index].abs_diff(before[index + 1]) <= 1);
                    assert!(before[index].abs_diff(before[index + 2]) <= 1);
                    levels.push(before[index]);
                }
                println!("HDR width={width} white={white_nits} levels={levels:?}");
                assert!(levels[0] <= 1 && levels[7] >= 245);
                assert!(levels.windows(2).all(|pair| pair[0] < pair[1]));
                let next = converter.convert(&source, Color::default())?;
                assert_eq!(pixels(&device, &next)?, original);
                assert_eq!(pixels(&device, &mapped)?, before);
            }
        }
        drop(converter);
        unsafe {
            device.GetDeviceRemovedReason()?;
        }
        Ok(())
    }
}
