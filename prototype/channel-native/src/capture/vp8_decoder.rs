//! Stock VP8 decoding; copy each borrowed I420 picture into an owned NV12 surface.
use super::{decoder::device, vp8::check, Format};
use crate::EncodedFrame;
use anyhow::{ensure, Result};
use std::{mem, ptr, slice, time::Instant};
use vpx_sys::*;
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

pub(crate) struct Decoder {
    context: vpx_codec_ctx_t,
    device: ID3D11Device,
    pixels: Vec<u8>,
}
impl Decoder {
    pub fn new() -> Result<Self> {
        let device = device()?;
        let mut context = unsafe { mem::zeroed() };
        unsafe {
            check(vpx_codec_dec_init_ver(
                &mut context,
                vpx_codec_vp8_dx(),
                ptr::null(),
                0,
                VPX_DECODER_ABI_VERSION as i32,
            ))?;
        }
        Ok(Self {
            context,
            device,
            pixels: Vec::new(),
        })
    }

    pub fn decode(
        &mut self,
        frame: &EncodedFrame,
        consume: &mut impl FnMut(
            (ID3D11Texture2D, DXGI_COLOR_SPACE_TYPE),
            Instant,
            Format,
        ) -> Result<()>,
    ) -> Result<()> {
        unsafe {
            check(vpx_codec_decode(
                &mut self.context,
                frame.bytes.as_ptr(),
                frame.bytes.len().try_into()?,
                ptr::null_mut(),
                0,
            ))?;
            let mut iterator = ptr::null();
            while let Some(image) = vpx_codec_get_frame(&mut self.context, &mut iterator).as_ref() {
                ensure!(
                    image.fmt == vpx_img_fmt::VPX_IMG_FMT_I420,
                    "VP8 output is not I420"
                );
                // The encoder's existing source-size contract uses an inner even
                // rectangle. NV12 cannot represent an odd last row or column.
                let (width, height) = (image.d_w & !1, image.d_h & !1);
                ensure!(
                    width > 0
                        && height > 0
                        && width <= D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION
                        && height <= D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION,
                    "VP8 picture exceeds D3D11 dimensions"
                );
                let (w, h) = (width as usize, height as usize);
                for (plane, row) in [(0, w), (1, w / 2), (2, w / 2)] {
                    ensure!(
                        !image.planes[plane].is_null() && image.stride[plane] >= row as i32,
                        "VP8 picture has invalid planes"
                    );
                }
                self.pixels.resize(w * h * 3 / 2, 0);
                for row in 0..h {
                    let y = slice::from_raw_parts(
                        image.planes[0].add(row * image.stride[0] as usize),
                        w,
                    );
                    self.pixels[row * w..(row + 1) * w].copy_from_slice(y);
                }
                for row in 0..h / 2 {
                    let u = slice::from_raw_parts(
                        image.planes[1].add(row * image.stride[1] as usize),
                        w / 2,
                    );
                    let v = slice::from_raw_parts(
                        image.planes[2].add(row * image.stride[2] as usize),
                        w / 2,
                    );
                    for (column, (&u, &v)) in u.iter().zip(v).enumerate() {
                        let offset = w * h + row * w + column * 2;
                        self.pixels[offset] = u;
                        self.pixels[offset + 1] = v;
                    }
                }
                let mut texture = None;
                self.device.CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: width,
                        Height: height,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_NV12,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0)
                            as u32,
                        ..Default::default()
                    },
                    Some(&D3D11_SUBRESOURCE_DATA {
                        pSysMem: self.pixels.as_ptr().cast(),
                        SysMemPitch: width,
                        SysMemSlicePitch: 0,
                    }),
                    Some(&mut texture),
                )?;
                consume(
                    (texture.unwrap(), super::converter::SDR_VIDEO_COLOR),
                    frame.presentation_time,
                    Format {
                        width,
                        height,
                        // Initialization hint only: Source timing admits original
                        // PTS, and libvpx derives its rate from those timestamps.
                        fps: 30,
                    },
                )?;
            }
        }
        Ok(())
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            vpx_codec_destroy(&mut self.context);
        }
    }
}
