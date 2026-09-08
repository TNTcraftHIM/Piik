#include "h264_encoder_adapter.h"

#include "../../capture/windows/h264_encoder.h"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <limits>
#include <utility>
#include <vector>

#include "api/video_codecs/h264_profile_level_id.h"
#include "libyuv/convert_from.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "system_wrappers/include/clock.h"

namespace screener::probe {
namespace {
namespace native = screener::capture::windows;

bool ValidDimensions(int width, int height) {
  return width >= 2 && width <= 2560 && height >= 2 && height <= 1440 &&
         width % 2 == 0 && height % 2 == 0;
}

webrtc::SdpVideoFormat HardwareFormat() {
  return {"H264", {{"profile-level-id", "42c033"},
                   {"level-asymmetry-allowed", "1"},
                   {"packetization-mode", "1"}},
          {webrtc::ScalabilityMode::kL1T1}};
}

class HardwareEncoder final : public webrtc::VideoEncoder {
 public:
  HardwareEncoder(const webrtc::Environment& env, unsigned adapter_index,
                  unsigned encoder_index, webrtc::H264Level maximum_level)
      : env_(env), adapter_index_(adapter_index), encoder_index_(encoder_index),
        maximum_level_(maximum_level) {}
  ~HardwareEncoder() override { Release(); }

  int InitEncode(const webrtc::VideoCodec* config, const Settings&) override {
    Release();
    if (!config || config->codecType != webrtc::kVideoCodecH264 ||
        !ValidDimensions(config->width, config->height) ||
        config->maxFramerate == 0 || config->maxFramerate > 60 ||
        config->startBitrate == 0 ||
        config->startBitrate > std::numeric_limits<UINT32>::max() / 1000) {
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    if (config->numberOfSimulcastStreams > 1 ||
        config->H264().numberOfTemporalLayers > 1 ||
        (config->GetScalabilityMode() &&
         config->GetScalabilityMode() != webrtc::ScalabilityMode::kL1T1)) {
      return WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED;
    }
    profile_.width = config->width;
    profile_.height = config->height;
    profile_.frame_rate = config->maxFramerate;
    profile_.bit_rate = config->startBitrate * 1000;
    if (profile_.h264_level() > static_cast<UINT32>(maximum_level_)) {
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    try {
      runtime_ = std::make_unique<native::Runtime>();
      auto adapters = native::EnumerateAdapters();
      const auto& adapter = native::SelectAdapter(adapters, adapter_index_);
      device_ = native::CreateDevice(adapter);
      auto activations = native::EnumerateHardwareEncoders(adapter);
      encoder_ = std::make_unique<native::LiveEncoder>(
          native::ActivateTransform(activations, encoder_index_, device_.manager.Get()),
          profile_);
      nv12_.resize(static_cast<size_t>(profile_.width) * profile_.height * 3 / 2);
      implementation_name_ = encoder_->name + " (" + encoder_->identity + ")";
      applied_bitrate_ = profile_.bit_rate;
      content_type_ = config->mode == webrtc::VideoCodecMode::kScreensharing
          ? webrtc::VideoContentType::SCREENSHARE
          : webrtc::VideoContentType::UNSPECIFIED;
      return WEBRTC_VIDEO_CODEC_OK;
    } catch (const std::exception& error) {
      ReportFailure("initialize", error);
      Release();
      return WEBRTC_VIDEO_CODEC_ENCODER_FAILURE;
    }
  }

  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) override {
    callback_ = callback;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    encoder_.reset();
    device_ = {};
    runtime_.reset();
    nv12_.clear();
    applied_bitrate_ = 0;
    paused_ = false;
    key_frame_pending_ = true;
    error_ = WEBRTC_VIDEO_CODEC_OK;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  void SetRates(const RateControlParameters& rates) override {
    if (!encoder_ || error_ != WEBRTC_VIDEO_CODEC_OK) return;
    const UINT32 bitrate = rates.bitrate.get_sum_bps();
    if (bitrate != rates.bitrate.GetBitrate(0, 0) ||
        !std::isfinite(rates.framerate_fps)) {
      error_ = WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
      return;
    }
    if (bitrate == 0) {
      paused_ = true;
      return;
    }
    const double fps = rates.framerate_fps > 0
        ? rates.framerate_fps : profile_.frame_rate;
    // Chromium M152 MF keeps the configured FPS and compensates its bitrate:
    // media/gpu/windows/media_foundation_video_encode_accelerator_win.cc,
    // AdjustBitrateToFrameRate (152.0.7977.82).
    const double adjusted = static_cast<double>(bitrate) * profile_.frame_rate / fps;
    if (!std::isfinite(adjusted) || adjusted < 1 ||
        adjusted > std::numeric_limits<UINT32>::max()) {
      error_ = WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
      return;
    }
    const auto next_bitrate = static_cast<UINT32>(adjusted);
    try {
      if (next_bitrate != applied_bitrate_) encoder_->SetBitrate(next_bitrate);
      applied_bitrate_ = next_bitrate;
      key_frame_pending_ = key_frame_pending_ || paused_;
      paused_ = false;
    } catch (const std::exception& error) {
      ReportFailure("rates", error);
      error_ = WEBRTC_VIDEO_CODEC_ENCODER_FAILURE;
    }
  }

  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* requested) override {
    if (!encoder_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    if (error_ != WEBRTC_VIDEO_CODEC_OK) return error_;
    key_frame_pending_ = key_frame_pending_ ||
        (requested && std::find(requested->begin(), requested->end(),
            webrtc::VideoFrameType::kVideoFrameKey) != requested->end());
    if (paused_ || (requested && !requested->empty() &&
                   requested->front() == webrtc::VideoFrameType::kEmptyFrame)) {
      callback_->OnFrameDropped(frame.rtp_timestamp(), 0, true);
      return WEBRTC_VIDEO_CODEC_OK;
    }
    if (!frame.video_frame_buffer() || frame.width() != static_cast<int>(profile_.width) ||
        frame.height() != static_cast<int>(profile_.height) || frame.timestamp_us() < 0 ||
        frame.timestamp_us() > std::numeric_limits<LONGLONG>::max() / 10) {
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    try {
      const auto began = env_.clock().TimeInMilliseconds();
      auto input = frame.video_frame_buffer()->ToI420();
      if (!input || libyuv::I420ToNV12(
          input->DataY(), input->StrideY(), input->DataU(), input->StrideU(),
          input->DataV(), input->StrideV(), nv12_.data(), profile_.width,
          nv12_.data() + static_cast<size_t>(profile_.width) * profile_.height,
          profile_.width, profile_.width, profile_.height) != 0) {
        return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
      }
      D3D11_TEXTURE2D_DESC description{};
      description.Width = profile_.width;
      description.Height = profile_.height;
      description.MipLevels = 1;
      description.ArraySize = 1;
      description.Format = DXGI_FORMAT_NV12;
      description.SampleDesc.Count = 1;
      description.Usage = D3D11_USAGE_DEFAULT;
      D3D11_SUBRESOURCE_DATA pixels{};
      pixels.pSysMem = nv12_.data();
      pixels.SysMemPitch = profile_.width;
      pixels.SysMemSlicePitch = static_cast<UINT>(nv12_.size());
      native::ComPtr<ID3D11Texture2D> texture;
      native::Check(device_.device->CreateTexture2D(&description, &pixels, &texture),
                    "webrtc-h264-upload");
      const auto access_unit = encoder_->Encode(
          texture.Get(), static_cast<UINT64>(frame.timestamp_us()) * 10,
          key_frame_pending_);
      key_frame_pending_ = false;
      webrtc::EncodedImage image;
      image.SetEncodedData(webrtc::EncodedImageBuffer::Create(
          access_unit.bytes.data(), access_unit.bytes.size()));
      image._encodedWidth = profile_.width;
      image._encodedHeight = profile_.height;
      image.SetRtpTimestamp(frame.rtp_timestamp());
      image.capture_time_ms_ = frame.timestamp_us() / 1000;
      image.ntp_time_ms_ = frame.ntp_time_ms();
      image.SetPresentationTimestamp(frame.presentation_timestamp());
      image.rotation_ = frame.rotation();
      image.content_type_ = content_type_;
      image.SetColorSpace(frame.color_space());
      image.SetPacketInfos(frame.packet_infos());
      image.SetVideoFrameTrackingId(frame.id());
      image.SetSimulcastIndex(0);
      image.SetSpatialIndex(0);
      image.SetTemporalIndex(0);
      image.set_end_of_temporal_unit(true);
      image.SetFrameType(access_unit.key_frame
          ? webrtc::VideoFrameType::kVideoFrameKey
          : webrtc::VideoFrameType::kVideoFrameDelta);
      image.SetEncodeTime(began, env_.clock().TimeInMilliseconds());
      webrtc::CodecSpecificInfo info;
      info.codecType = webrtc::kVideoCodecH264;
      info.codecSpecific.H264 = {};
      info.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
      info.codecSpecific.H264.idr_frame = access_unit.key_frame;
      info.scalability_mode = webrtc::ScalabilityMode::kL1T1;
      const auto result = callback_->OnEncodedImage(image, &info);
      return result.error == webrtc::EncodedImageCallback::Result::OK
          ? WEBRTC_VIDEO_CODEC_OK : WEBRTC_VIDEO_CODEC_ERROR;
    } catch (const std::exception& error) {
      ReportFailure("encode", error);
      error_ = WEBRTC_VIDEO_CODEC_ENCODER_FAILURE;
      return error_;
    }
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = implementation_name_;
    info.is_hardware_accelerated = true;
    info.enable_cpu_overuse_detection = true;
    info.has_trusted_rate_controller = false;
    info.is_qp_trusted = false;
    info.scaling_settings = ScalingSettings::kOff;
    info.requested_resolution_alignment = 2;
    info.supports_native_handle = false;
    info.supports_simulcast = false;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kI420};
    return info;
  }

 private:
  static void ReportFailure(const char* operation, const std::exception& error) {
    std::cerr << "hardware-h264 " << operation << ": " << error.what();
    if (const auto* failure = dynamic_cast<const native::GateFailure*>(&error)) {
      std::cerr << " stage=" << failure->stage() << " hresult=" << failure->result();
    }
    std::cerr << '\n';
  }

  const webrtc::Environment env_;
  const unsigned adapter_index_;
  const unsigned encoder_index_;
  const webrtc::H264Level maximum_level_;
  std::unique_ptr<native::Runtime> runtime_;
  native::DeviceContext device_;
  std::unique_ptr<native::LiveEncoder> encoder_;
  native::VideoProfile profile_;
  std::vector<UINT8> nv12_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  std::string implementation_name_ = "Windows Media Foundation H264";
  webrtc::VideoContentType content_type_ = webrtc::VideoContentType::UNSPECIFIED;
  UINT32 applied_bitrate_ = 0;
  int32_t error_ = WEBRTC_VIDEO_CODEC_OK;
  bool paused_ = false;
  bool key_frame_pending_ = true;
};

class HardwareFactory final : public webrtc::VideoEncoderFactory {
 public:
  HardwareFactory(unsigned adapter_index, unsigned encoder_index)
      : adapter_index_(adapter_index), encoder_index_(encoder_index) {}

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {HardwareFormat()};
  }

  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format,
      std::optional<std::string> scalability_mode,
      std::optional<webrtc::Resolution> resolution) const override {
    if (resolution && !ValidDimensions(resolution->width, resolution->height)) return {};
    const auto profile = webrtc::ParseSdpForH264ProfileLevelId(format.parameters);
    native::VideoProfile minimum;
    minimum.frame_rate = 1;
    if (resolution) {
      minimum.width = resolution->width;
      minimum.height = resolution->height;
    }
    const bool supported = format.IsSameCodec(HardwareFormat()) &&
        (!scalability_mode || *scalability_mode == "L1T1") && profile &&
        minimum.h264_level() <= static_cast<UINT32>(profile->level);
    return {supported, supported};
  }

  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env, const webrtc::SdpVideoFormat& format) override {
    if (!QueryCodecSupport(format, std::nullopt, std::nullopt).is_supported) return nullptr;
    const auto profile = webrtc::ParseSdpForH264ProfileLevelId(format.parameters);
    return std::make_unique<HardwareEncoder>(env, adapter_index_, encoder_index_, profile->level);
  }

 private:
  const unsigned adapter_index_;
  const unsigned encoder_index_;
};

}  // namespace

std::unique_ptr<webrtc::VideoEncoderFactory> CreateHardwareEncoderFactory(
    unsigned adapter_index, unsigned encoder_index) {
  return std::make_unique<HardwareFactory>(adapter_index, encoder_index);
}

}  // namespace screener::probe
