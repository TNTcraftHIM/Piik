#pragma once

#include "capture_error.h"

#include <dxgicommon.h>
#include <mfapi.h>
#include <mfobjects.h>

namespace piik::capture::windows {

// Untagged WebRTC SDR uses BT.601. Keep the converter's pixels and the H264
// encoder's range/matrix declaration in agreement; VP8 has no equivalent VUI.
inline constexpr auto kSdrVideoColor = DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601;
inline constexpr auto kDesktopColor = DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709;

inline void SetSdrVideoColor(IMFAttributes* type) {
  Check(type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601), "video-type-matrix");
  Check(type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235), "video-type-range");
  Check(type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_SMPTE170M), "video-type-primaries");
  Check(type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709), "video-type-transfer");
}

// The decoder owns the incoming stream's declaration. Preserve it through the
// relay's local scale/re-encode boundary instead of guessing from resolution.
inline DXGI_COLOR_SPACE_TYPE DecodedVideoColor(IMFAttributes* type) {
  const auto matrix = MFGetAttributeUINT32(type, MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601);
  const bool full = MFGetAttributeUINT32(type, MF_MT_VIDEO_NOMINAL_RANGE,
                                       MFNominalRange_16_235) == MFNominalRange_0_255;
  if (matrix == MFVideoTransferMatrix_BT709)
    return full ? DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709 : DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709;
  return full ? DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P601 : kSdrVideoColor;
}

}  // namespace piik::capture::windows
