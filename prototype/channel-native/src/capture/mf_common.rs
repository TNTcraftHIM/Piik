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
