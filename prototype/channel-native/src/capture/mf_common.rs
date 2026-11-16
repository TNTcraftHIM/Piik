use super::Settings;
use anyhow::Result;
use windows::Win32::{
    Media::MediaFoundation::*,
    System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
};
pub(super) struct Com;
impl Com {
    pub(super) fn start() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error.into());
            }
        }
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

pub(super) fn media_type(
    subtype: &windows::core::GUID,
    settings: Settings,
) -> Result<IMFMediaType> {
    unsafe {
        let media = MFCreateMediaType()?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        media.SetUINT64(
            &MF_MT_FRAME_SIZE,
            ((settings.width as u64) << 32) | settings.height as u64,
        )?;
        media.SetUINT64(&MF_MT_FRAME_RATE, ((settings.fps as u64) << 32) | 1)?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_SMPTE170M.0 as u32)?;
        media.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601.0 as u32)?;
        media.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        Ok(media)
    }
}

pub(super) fn normalize_level_1b(bytes: &mut [u8]) {
    // Some MFTs use level_idc 9 for Baseline Level 1b. RFC 6184 requires
    // constraint_set3_flag and level_idc 11; MF decoding otherwise yields no frames.
    for index in 0..bytes.len().saturating_sub(6) {
        let prefix = &mut bytes[index..index + 7];
        if prefix[..3] == [0, 0, 1] && prefix[3] & 0x1f == 7 && prefix[4] == 0x42 && prefix[6] == 9
        {
            prefix[5] |= 0x10;
            prefix[6] = 11;
        }
    }
}

/// Only an explicit unexpected MFT encode-operation failure permits software retry.
#[derive(Debug)]
pub(super) struct HardwareEncoderFailed;
impl std::fmt::Display for HardwareEncoderFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("hardware H264 encode operation failed")
    }
}
impl std::error::Error for HardwareEncoderFailed {}
pub(super) fn encode_failure(error: windows::core::Error) -> anyhow::Error {
    if error.code() == windows::Win32::Foundation::E_FAIL {
        anyhow::Error::from(error).context(HardwareEncoderFailed)
    } else {
        error.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::{
        Foundation::{E_FAIL, E_INVALIDARG},
        Graphics::Dxgi::DXGI_ERROR_DEVICE_REMOVED,
    };

    #[test]
    fn only_unexpected_encode_failure_gets_the_replacement_marker() {
        let error = encode_failure(windows::core::Error::from_hresult(E_FAIL));
        assert!(error.is::<HardwareEncoderFailed>());
        assert_eq!(
            error.downcast_ref::<windows::core::Error>().unwrap().code(),
            E_FAIL
        );
        for code in [
            E_INVALIDARG,
            DXGI_ERROR_DEVICE_REMOVED,
            MF_E_NOTACCEPTING,
            MF_E_TRANSFORM_NEED_MORE_INPUT,
            MF_E_TRANSFORM_STREAM_CHANGE,
        ] {
            let error = encode_failure(windows::core::Error::from_hresult(code));
            assert!(!error.is::<HardwareEncoderFailed>());
            assert_eq!(
                error.downcast_ref::<windows::core::Error>().unwrap().code(),
                code
            );
        }
    }
}
