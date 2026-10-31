//! EGL contexts never leave their workers. Only completed immutable pixels do.
use anyhow::{anyhow, ensure, Context as _, Result};
use glow::HasContext;
use khronos_egl as egl;
use ndk::{
    hardware_buffer::{HardwareBuffer, HardwareBufferDesc, HardwareBufferRef, HardwareBufferUsage},
    hardware_buffer_format::HardwareBufferFormat,
    native_window::NativeWindow,
};
use std::{ffi::c_void, sync::Arc};

#[link(name = "EGL")]
extern "C" {}

const EGL: egl::Instance<egl::Static> = egl::Instance::new(egl::Static);
const EXTERNAL: u32 = 0x8D65;
const IDENTITY: [f32; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

pub(super) struct Display(egl::Display);
// EGLDisplay is a process connection, not a current context. EGL permits concurrent
// contexts on one display; the last Arc terminates it after all workers have joined.
unsafe impl Send for Display {}
unsafe impl Sync for Display {}
impl Display {
    pub fn new() -> Result<Arc<Self>> {
        let display =
            unsafe { EGL.get_display(egl::DEFAULT_DISPLAY) }.context("EGL display unavailable")?;
        EGL.initialize(display)?;
        Ok(Arc::new(Self(display)))
    }
}
impl Drop for Display {
    fn drop(&mut self) {
        let _ = EGL.terminate(self.0);
    }
}

#[derive(Clone)]
pub(super) struct Image(Arc<HardwareBufferRef>);
// Allocation is exclusively written by the source context, glFinish completes
// that copy before publication. No mutable image API escapes; AHB retain/release
// is thread-safe. This does not assert Send for any EGL context or MediaCodec.
unsafe impl Send for Image {}
unsafe impl Sync for Image {}
impl Image {
    pub fn size(&self) -> (u32, u32) {
        let d = self.0.describe();
        (d.width, d.height)
    }
}

pub(super) struct Graphics {
    display: Arc<Display>,
    context: egl::Context,
    surface: egl::Surface,
    gl: glow::Context,
    program: glow::Program,
    external: bool,
    vao: glow::VertexArray,
}
impl Graphics {
    pub fn new(
        display: Arc<Display>,
        window: Option<&NativeWindow>,
        external: bool,
    ) -> Result<Self> {
        EGL.bind_api(egl::OPENGL_ES_API)?;
        let config = EGL
            .choose_first_config(
                display.0,
                &[
                    egl::SURFACE_TYPE,
                    egl::PBUFFER_BIT | egl::WINDOW_BIT,
                    egl::RENDERABLE_TYPE,
                    egl::OPENGL_ES3_BIT,
                    egl::RED_SIZE,
                    8,
                    egl::GREEN_SIZE,
                    8,
                    egl::BLUE_SIZE,
                    8,
                    0x3142,
                    1, // EGL_RECORDABLE_ANDROID: codec input Surface.
                    egl::NONE,
                ],
            )?
            .context("recordable EGL config unavailable")?;
        let context = EGL.create_context(
            display.0,
            config,
            None,
            &[egl::CONTEXT_CLIENT_VERSION, 3, egl::NONE],
        )?;
        let surface = match window {
            Some(window) => unsafe {
                EGL.create_window_surface(display.0, config, window.ptr().as_ptr().cast(), None)
            },
            None => EGL.create_pbuffer_surface(
                display.0,
                config,
                &[egl::WIDTH, 1, egl::HEIGHT, 1, egl::NONE],
            ),
        };
        let surface = match surface {
            Ok(value) => value,
            Err(error) => {
                let _ = EGL.destroy_context(display.0, context);
                return Err(error.into());
            }
        };
        if let Err(error) = EGL.make_current(display.0, Some(surface), Some(surface), Some(context))
        {
            let _ = EGL.destroy_surface(display.0, surface);
            let _ = EGL.destroy_context(display.0, context);
            return Err(error.into());
        }
        let gl = unsafe {
            glow::Context::from_loader_function(|name| {
                EGL.get_proc_address(name)
                    .map_or(std::ptr::null(), |f| f as *const c_void)
            })
        };
        let resources = (|| {
            let program = unsafe { gl.create_program().map_err(|e| anyhow!(e))? };
            match unsafe { gl.create_vertex_array() } {
                Ok(vao) => Ok((program, vao)),
                Err(error) => {
                    unsafe {
                        gl.delete_program(program);
                    }
                    Err(anyhow!(error))
                }
            }
        })();
        let (program, vao) = match resources {
            Ok(value) => value,
            Err(error) => {
                let _ = EGL.make_current(display.0, None, None, None);
                let _ = EGL.destroy_surface(display.0, surface);
                let _ = EGL.destroy_context(display.0, context);
                return Err(error);
            }
        };
        let value = Self {
            display,
            context,
            surface,
            gl,
            program,
            external,
            vao,
        };
        value.compile()?;
        Ok(value)
    }
    fn compile(&self) -> Result<()> {
        let vertex = "#version 300 es\nuniform mat4 transform; out vec2 uv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); uv=(transform*vec4(p,0,1)).xy; gl_Position=vec4(p*2.0-1.0,0,1); }";
        let fragment = if self.external {
            "#version 300 es\n#extension GL_OES_EGL_image_external_essl3 : require\nprecision mediump float; uniform samplerExternalOES pixels; in vec2 uv; out vec4 color; void main(){color=texture(pixels,uv);}"
        } else {
            "#version 300 es\nprecision mediump float; uniform sampler2D pixels; in vec2 uv; out vec4 color; void main(){color=texture(pixels,uv);}"
        };
        unsafe {
            for (kind, text) in [
                (glow::VERTEX_SHADER, vertex),
                (glow::FRAGMENT_SHADER, fragment),
            ] {
                let shader = self.gl.create_shader(kind).map_err(|e| anyhow!(e))?;
                self.gl.shader_source(shader, text);
                self.gl.compile_shader(shader);
                let compiled = self.gl.get_shader_compile_status(shader);
                let error = self.gl.get_shader_info_log(shader);
                if compiled {
                    self.gl.attach_shader(self.program, shader);
                }
                self.gl.delete_shader(shader);
                ensure!(compiled, "GL shader: {error}");
            }
            self.gl.link_program(self.program);
            ensure!(
                self.gl.get_program_link_status(self.program),
                "GL link: {}",
                self.gl.get_program_info_log(self.program)
            );
        }
        Ok(())
    }
    pub fn external_texture(&self) -> Result<glow::Texture> {
        let texture = unsafe { self.gl.create_texture().map_err(|e| anyhow!(e))? };
        Ok(texture)
    }
    fn import(&self, image: &Image) -> Result<(egl::Image, glow::Texture)> {
        type GetBuffer = unsafe extern "system" fn(*const c_void) -> *mut c_void;
        type BindImage = unsafe extern "system" fn(u32, *mut c_void);
        let get: GetBuffer = unsafe {
            std::mem::transmute(
                EGL.get_proc_address("eglGetNativeClientBufferANDROID")
                    .context("EGL native buffer unavailable")?,
            )
        };
        let bind: BindImage = unsafe {
            std::mem::transmute(
                EGL.get_proc_address("glEGLImageTargetTexture2DOES")
                    .context("GL image import unavailable")?,
            )
        };
        let buffer = unsafe { egl::ClientBuffer::from_ptr(get(image.0.as_ptr().cast())) };
        let egl_image = EGL.create_image(
            self.display.0,
            unsafe { egl::Context::from_ptr(egl::NO_CONTEXT) },
            0x3140,
            buffer,
            &[
                egl::IMAGE_PRESERVED as usize,
                egl::TRUE as usize,
                egl::ATTRIB_NONE,
            ],
        )?;
        let texture = match unsafe { self.gl.create_texture() } {
            Ok(texture) => texture,
            Err(error) => {
                let _ = EGL.destroy_image(self.display.0, egl_image);
                return Err(anyhow!(error));
            }
        };
        unsafe {
            self.gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            bind(glow::TEXTURE_2D, egl_image.as_ptr());
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_S,
                glow::CLAMP_TO_EDGE as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_T,
                glow::CLAMP_TO_EDGE as i32,
            );
        }
        Ok((egl_image, texture))
    }
    fn draw(&self, texture: glow::Texture, size: (u32, u32), transform: &[f32; 16]) {
        unsafe {
            self.gl.viewport(0, 0, size.0 as i32, size.1 as i32);
            self.gl.use_program(Some(self.program));
            self.gl.active_texture(glow::TEXTURE0);
            self.gl.bind_texture(
                if self.external {
                    EXTERNAL
                } else {
                    glow::TEXTURE_2D
                },
                Some(texture),
            );
            self.gl.uniform_1_i32(
                self.gl
                    .get_uniform_location(self.program, "pixels")
                    .as_ref(),
                0,
            );
            self.gl.uniform_matrix_4_f32_slice(
                self.gl
                    .get_uniform_location(self.program, "transform")
                    .as_ref(),
                false,
                transform,
            );
            self.gl.bind_vertex_array(Some(self.vao));
            self.gl.draw_arrays(glow::TRIANGLES, 0, 3);
        }
    }
    pub fn snapshot(
        &self,
        texture: glow::Texture,
        size: (u32, u32),
        transform: &[f32; 16],
    ) -> Result<Image> {
        let image = Image(Arc::new(HardwareBuffer::allocate(HardwareBufferDesc {
            width: size.0,
            height: size.1,
            layers: 1,
            format: HardwareBufferFormat::R8G8B8A8_UNORM,
            usage: HardwareBufferUsage::GPU_COLOR_OUTPUT | HardwareBufferUsage::GPU_SAMPLED_IMAGE,
            stride: 0,
        })?));
        let (import, destination) = self.import(&image)?;
        let framebuffer = match unsafe { self.gl.create_framebuffer() } {
            Ok(value) => value,
            Err(error) => {
                unsafe {
                    self.gl.delete_texture(destination);
                }
                let _ = EGL.destroy_image(self.display.0, import);
                return Err(anyhow!(error));
            }
        };
        let result = (|| {
            unsafe {
                self.gl
                    .bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
                self.gl.framebuffer_texture_2d(
                    glow::FRAMEBUFFER,
                    glow::COLOR_ATTACHMENT0,
                    glow::TEXTURE_2D,
                    Some(destination),
                    0,
                );
                ensure!(
                    self.gl.check_framebuffer_status(glow::FRAMEBUFFER)
                        == glow::FRAMEBUFFER_COMPLETE,
                    "incomplete source framebuffer"
                );
            }
            self.draw(texture, size, transform);
            unsafe {
                self.gl.finish();
                ensure!(
                    self.gl.get_error() == glow::NO_ERROR,
                    "source image copy failed"
                );
            }
            Ok(())
        })();
        unsafe {
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            self.gl.delete_framebuffer(framebuffer);
            self.gl.delete_texture(destination);
        }
        EGL.destroy_image(self.display.0, import)?;
        result?;
        Ok(image)
    }
    pub fn submit(&self, image: &Image, size: (u32, u32), nanos: i64) -> Result<()> {
        let (import, texture) = self.import(image)?;
        self.draw(texture, size, &IDENTITY);
        type Presentation = unsafe extern "system" fn(*mut c_void, *mut c_void, i64) -> u32;
        let result = (|| {
            ensure!(
                unsafe { self.gl.get_error() } == glow::NO_ERROR,
                "encoder image render failed"
            );
            let present: Presentation = unsafe {
                std::mem::transmute(
                    EGL.get_proc_address("eglPresentationTimeANDROID")
                        .context("EGL presentation time unavailable")?,
                )
            };
            ensure!(
                unsafe { present(self.display.0.as_ptr(), self.surface.as_ptr(), nanos) } != 0,
                "presentation time failed"
            );
            EGL.swap_buffers(self.display.0, self.surface)?;
            Ok(())
        })();
        unsafe {
            self.gl.finish();
            self.gl.delete_texture(texture);
        }
        EGL.destroy_image(self.display.0, import)?;
        result
    }
}
impl Drop for Graphics {
    fn drop(&mut self) {
        unsafe {
            self.gl.delete_vertex_array(self.vao);
            self.gl.delete_program(self.program);
        }
        let _ = EGL.make_current(self.display.0, None, None, None);
        let _ = EGL.destroy_surface(self.display.0, self.surface);
        let _ = EGL.destroy_context(self.display.0, self.context);
    }
}
