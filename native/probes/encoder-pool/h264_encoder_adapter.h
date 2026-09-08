#pragma once

#include <memory>

#include "api/video_codecs/video_encoder_factory.h"

namespace screener::probe {

// CPU I420 input only. InitEncode and Release own COM/MF on the encoder queue.
std::unique_ptr<webrtc::VideoEncoderFactory> CreateHardwareEncoderFactory(
    unsigned adapter_index = 0, unsigned encoder_index = 0);

}  // namespace screener::probe
