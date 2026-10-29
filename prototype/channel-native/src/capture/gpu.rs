//! Same-adapter GPU handoff. Only the worker owns the encoder's private texture.
use super::windows::RawFrame;
use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use windows::{
    core::Interface,
    Win32::{
        Foundation::{
            DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, HMODULE, LUID, WAIT_ABANDONED,
            WAIT_TIMEOUT,
        },
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
        System::Threading::GetCurrentProcess,
    },
};
#[derive(Serialize, Deserialize)]
pub(super) struct Frame {
    pub handle: usize,
    pub low: u32,
    pub high: i32,
    pub qpc: i64,
}
fn device(luid: LUID) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    unsafe {
        let factory: IDXGIFactory4 = CreateDXGIFactory1()?;
        let adapter: IDXGIAdapter = factory.EnumAdapterByLuid(luid)?;
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        let device = device.unwrap();
        let context = context.unwrap();
        let _ = context
            .cast::<ID3D11Multithread>()?
            .SetMultithreadProtected(true);
        Ok((device, context))
    }
}

fn texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    shared: bool,
) -> Result<ID3D11Texture2D> {
    unsafe {
        let mut texture = None;
        device.CreateTexture2D(
            &D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                MiscFlags: if shared {
                    (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                        | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32
                } else {
                    0
                },
                ..Default::default()
            },
            None,
            Some(&mut texture),
        )?;
        Ok(texture.unwrap())
    }
}

fn acquire(mutex: &IDXGIKeyedMutex, key: u64) -> Result<()> {
    // windows-rs AcquireSync().ok() treats the positive WAIT_* codes as success.
    // DXGI explicitly requires testing these raw HRESULT values instead.
    let hr = unsafe { (mutex.vtable().AcquireSync)(mutex.as_raw(), key, 2000) };
    match hr.0 {
        0 => Ok(()),
        value if value == WAIT_TIMEOUT.0 as i32 => bail!("AcquireSync WAIT_TIMEOUT (no ownership)"),
        value if value == WAIT_ABANDONED.0 as i32 => {
            bail!("AcquireSync WAIT_ABANDONED (resource invalid)")
        }
        _ => Err(windows::core::Error::from_hresult(hr).into()),
    }
}

pub(super) fn send(frame: RawFrame, process: RawHandle) -> Result<Frame> {
    unsafe {
        let device: ID3D11Device = frame.texture.GetDevice()?;
        let context = device.GetImmediateContext()?;
        let adapter = device
            .cast::<IDXGIDevice>()?
            .GetAdapter()?
            .GetDesc()?
            .AdapterLuid;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        frame.texture.GetDesc(&mut desc);
        let shared = texture(&device, desc.Width, desc.Height, true)?;
        let mutex: IDXGIKeyedMutex = shared.cast()?;
        acquire(&mutex, 0)?;
        context.CopyResource(&shared, &frame.texture);
        context.Flush();
        mutex.ReleaseSync(1)?;
        let handle = shared.cast::<IDXGIResource1>()?.CreateSharedHandle(
            None,
            DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
            None,
        )?;
        let handle = OwnedHandle::from_raw_handle(handle.0);
        let mut duplicate = HANDLE::default();
        DuplicateHandle(
            GetCurrentProcess(),
            HANDLE(handle.as_raw_handle()),
            HANDLE(process),
            &mut duplicate,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )?;
        Ok(Frame {
            handle: duplicate.0 as usize,
            low: adapter.LowPart,
            high: adapter.HighPart,
            qpc: frame.qpc,
        })
    }
}
pub(super) struct Receiver {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    luid: LUID,
}
impl Receiver {
    pub fn new(frame: &Frame) -> Result<Self> {
        let luid = LUID {
            LowPart: frame.low,
            HighPart: frame.high,
        };
        let (device, context) = device(luid)?;
        Ok(Self {
            device,
            context,
            luid,
        })
    }
    pub fn receive(&self, frame: Frame) -> Result<RawFrame> {
        unsafe {
            let handle = OwnedHandle::from_raw_handle(frame.handle as _);
            ensure!(
                frame.low == self.luid.LowPart && frame.high == self.luid.HighPart,
                "capture adapter changed"
            );
            let shared: ID3D11Texture2D = self
                .device
                .cast::<ID3D11Device1>()?
                .OpenSharedResource1(HANDLE(handle.as_raw_handle()))?;
            drop(handle);
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            shared.GetDesc(&mut desc);
            let private = texture(&self.device, desc.Width, desc.Height, false)?;
            let mutex: IDXGIKeyedMutex = shared.cast()?;
            acquire(&mutex, 1)?;
            self.context.CopyResource(&private, &shared);
            self.context.Flush();
            mutex.ReleaseSync(0)?;
            Ok(RawFrame {
                texture: private,
                qpc: frame.qpc,
            })
        }
    }
}
