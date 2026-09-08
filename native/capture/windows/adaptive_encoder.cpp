#include "adaptive_encoder.h"
#include "capture_output.h"

#include <algorithm>
#include <cmath>
#include <exception>
#include <future>
#include <limits>
#include <mutex>
#include <thread>

#include "api/environment/environment_factory.h"
#include "api/make_ref_counted.h"
#include "api/task_queue/task_queue_base.h"
#include "api/task_queue/task_queue_factory.h"
#include "api/video/builtin_video_bitrate_allocator_factory.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_adapter.h"
#include "api/video/video_frame.h"
#include "api/video/video_stream_encoder_settings.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "call/video_send_stream.h"
#include "libyuv/convert.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "system_wrappers/include/clock.h"
#include "video/adaptation/overuse_frame_detector.h"
#include "video/frame_cadence_adapter.h"
#include "video/send_statistics_proxy.h"
#include "video/video_stream_encoder.h"

namespace screener::capture::windows {
namespace {

template <typename F>
void Sync(webrtc::TaskQueueBase* queue, F fn) {
  std::promise<void> completed;
  auto result = completed.get_future();
  queue->PostTask([completed = std::move(completed), fn = std::move(fn)]() mutable {
    try {
      fn();
      completed.set_value();
    } catch (...) {
      completed.set_exception(std::current_exception());
    }
  });
  result.get();
}

// Library callbacks cannot throw through WebRTC's task queues.
class Failure final {
 public:
  void Capture() noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!failure_) failure_ = std::current_exception();
  }
  void Set(const char* detail) noexcept {
    try {
      throw GateFailure("adaptive-encoder", detail);
    } catch (...) {
      Capture();
    }
  }
  void Rethrow() {
    std::exception_ptr failure;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      failure = failure_;
    }
    if (failure) {
      try {
        std::rethrow_exception(failure);
      } catch (const GateFailure&) {
        throw;
      } catch (const std::exception& error) {
        throw GateFailure("adaptive-encoder", error.what());
      } catch (...) {
        throw GateFailure("adaptive-encoder", "WebRTC encoder callback failed");
      }
    }
  }

 private:
  std::mutex mutex_;
  std::exception_ptr failure_;
};

class Readback final {
 public:
  Readback(ID3D11Device* device, Failure& failure) : device_(device), failure_(failure) {
    device_->GetImmediateContext(&context_);
  }

  webrtc::scoped_refptr<webrtc::I420BufferInterface> Convert(ID3D11Texture2D* texture) {
    try {
      D3D11_TEXTURE2D_DESC description{};
      texture->GetDesc(&description);
      if (!staging_ || width_ != description.Width || height_ != description.Height) {
        staging_.Reset();
        description.Usage = D3D11_USAGE_STAGING;
        description.BindFlags = 0;
        description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        description.MiscFlags = 0;
        Check(device_->CreateTexture2D(&description, nullptr, &staging_),
              "adaptive-vp8-staging");
        width_ = description.Width;
        height_ = description.Height;
      }
      auto pixels = webrtc::I420Buffer::Create(static_cast<int>(width_),
                                              static_cast<int>(height_));
      context_->CopyResource(staging_.Get(), texture);
      D3D11_MAPPED_SUBRESOURCE mapped{};
      Check(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped),
            "adaptive-vp8-readback");
      const auto* y = static_cast<const UINT8*>(mapped.pData);
      const int result = libyuv::NV12ToI420(
          y, static_cast<int>(mapped.RowPitch), y + mapped.RowPitch * height_,
          static_cast<int>(mapped.RowPitch), pixels->MutableDataY(), pixels->StrideY(),
          pixels->MutableDataU(), pixels->StrideU(), pixels->MutableDataV(),
          pixels->StrideV(), static_cast<int>(width_), static_cast<int>(height_));
      context_->Unmap(staging_.Get(), 0);
      if (result != 0) Fail("adaptive-vp8-convert", "NV12 conversion failed");
      return pixels;
    } catch (...) {
      failure_.Capture();
      return nullptr;
    }
  }

 private:
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11Texture2D> staging_;
  Failure& failure_;
  UINT32 width_ = 0, height_ = 0;
};

class NativeVideoFrameBuffer : public webrtc::VideoFrameBuffer {
 public:
  NativeVideoFrameBuffer(ComPtr<ID3D11Texture2D> texture, UINT32 width, UINT32 height,
                        UINT64 timestamp100ns, Readback& readback)
      : texture_(std::move(texture)), width_(width), height_(height),
        timestamp100ns_(timestamp100ns), readback_(readback) {}
  Type type() const override { return Type::kNative; }
  int width() const override { return static_cast<int>(width_); }
  int height() const override { return static_cast<int>(height_); }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override {
    return readback_.Convert(texture_.Get());
  }
  ID3D11Texture2D* texture() const { return texture_.Get(); }
  UINT64 timestamp100ns() const { return timestamp100ns_; }

 private:
  ComPtr<ID3D11Texture2D> texture_;
  const UINT32 width_, height_;
  const UINT64 timestamp100ns_;
  Readback& readback_;
};

class HardwareEncoder final : public webrtc::VideoEncoder {
 public:
  HardwareEncoder(const webrtc::Environment& env, VideoProfile ceiling,
                  AdaptiveEncoder::Factory create,
                  std::unique_ptr<screener::capture::windows::VideoEncoder> initial,
                  Failure& failure)
      : env_(env), ceiling_(ceiling), create_(std::move(create)),
        initial_(std::move(initial)), failure_(failure) {
    Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "adaptive-h264-apartment");
  }
  ~HardwareEncoder() override {
    initial_.reset();
    Release();
    CoUninitialize();
  }

  int32_t InitEncode(const webrtc::VideoCodec* config, const Settings&) override {
    Release();
    try {
      if (!config || config->codecType != webrtc::kVideoCodecH264 ||
          config->width == 0 || config->height == 0 || (config->width & 1) ||
          (config->height & 1) || config->width > ceiling_.width ||
          config->height > ceiling_.height || config->maxFramerate == 0 ||
          config->maxFramerate > ceiling_.frame_rate || config->startBitrate == 0 ||
          config->numberOfSimulcastStreams > 1 || config->H264().numberOfTemporalLayers > 1) {
        Fail("adaptive-h264-config", "WebRTC requested an unsupported H264 configuration");
      }
      profile_ = ceiling_;
      profile_.width = config->width;
      profile_.height = config->height;
      profile_.frame_rate = config->maxFramerate;
      profile_.bit_rate = config->startBitrate * 1000;
      if (initial_ && profile_.width == ceiling_.width &&
          profile_.height == ceiling_.height && profile_.frame_rate == ceiling_.frame_rate) {
        encoder_ = std::move(initial_);
        encoder_->SetBitrate(profile_.bit_rate);
      } else {
        initial_.reset();
        encoder_ = create_(profile_);
      }
      if (!encoder_ || encoder_->kind != OutputKind::h264)
        Fail("adaptive-h264-create", "The native H264 encoder is unavailable");
      applied_bitrate_ = profile_.bit_rate;
      return WEBRTC_VIDEO_CODEC_OK;
    } catch (...) {
      failure_.Capture();
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
    paused_ = false;
    key_frame_pending_ = true;
    applied_bitrate_ = 0;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  void SetRates(const RateControlParameters& rates) override {
    if (!encoder_) return;
    try {
      const UINT32 bitrate = rates.bitrate.get_sum_bps();
      if (bitrate != rates.bitrate.GetBitrate(0, 0) ||
          !std::isfinite(rates.framerate_fps))
        Fail("adaptive-h264-rates", "WebRTC supplied unsupported H264 rates");
      if (bitrate == 0) {
        paused_ = true;
        return;
      }
      const double fps = rates.framerate_fps > 0 ? rates.framerate_fps : profile_.frame_rate;
      // Chromium M152 MF compensates bitrate when requested FPS differs from configured FPS.
      const double adjusted = static_cast<double>(bitrate) * profile_.frame_rate / fps;
      if (!std::isfinite(adjusted) || adjusted < 1 ||
          adjusted > std::numeric_limits<UINT32>::max())
        Fail("adaptive-h264-rates", "H264 rate compensation overflowed");
      const auto next = static_cast<UINT32>(adjusted);
      if (next != applied_bitrate_) encoder_->SetBitrate(next);
      applied_bitrate_ = next;
      key_frame_pending_ = key_frame_pending_ || paused_;
      paused_ = false;
    } catch (...) {
      failure_.Capture();
    }
  }

  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* requested) override {
    try {
      failure_.Rethrow();
      if (!encoder_ || !callback_)
        Fail("adaptive-h264-encode", "The H264 encoder is not initialized");
      key_frame_pending_ = key_frame_pending_ ||
          (requested && std::find(requested->begin(), requested->end(),
              webrtc::VideoFrameType::kVideoFrameKey) != requested->end());
      if (paused_ || (requested && !requested->empty() &&
                     requested->front() == webrtc::VideoFrameType::kEmptyFrame)) {
        callback_->OnFrameDropped(frame.rtp_timestamp(), 0, true);
        return WEBRTC_VIDEO_CODEC_OK;
      }
      const auto* native = dynamic_cast<NativeVideoFrameBuffer*>(frame.video_frame_buffer().get());
      if (!native || frame.width() != static_cast<int>(profile_.width) ||
          frame.height() != static_cast<int>(profile_.height))
        Fail("adaptive-h264-input", "H264 requires the selected native NV12 surface");
      const auto began = env_.clock().TimeInMilliseconds();
      const auto access_unit = encoder_->Encode(native->texture(), native->timestamp100ns(),
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
      image.SetColorSpace(frame.color_space());
      image.SetVideoFrameTrackingId(frame.id());
      image.SetSimulcastIndex(0);
      image.SetSpatialIndex(0);
      image.SetTemporalIndex(0);
      image.set_end_of_temporal_unit(true);
      image.SetFrameType(access_unit.key_frame ? webrtc::VideoFrameType::kVideoFrameKey
                                             : webrtc::VideoFrameType::kVideoFrameDelta);
      image.SetEncodeTime(began, env_.clock().TimeInMilliseconds());
      webrtc::CodecSpecificInfo info;
      info.codecType = webrtc::kVideoCodecH264;
      info.codecSpecific.H264 = {};
      info.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
      info.codecSpecific.H264.idr_frame = access_unit.key_frame;
      info.scalability_mode = webrtc::ScalabilityMode::kL1T1;
      if (callback_->OnEncodedImage(image, &info).error != webrtc::EncodedImageCallback::Result::OK)
        Fail("adaptive-h264-callback", "WebRTC rejected the encoded H264 frame");
      return WEBRTC_VIDEO_CODEC_OK;
    } catch (...) {
      failure_.Capture();
      return WEBRTC_VIDEO_CODEC_ENCODER_FAILURE;
    }
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = "Windows Media Foundation H264";
    info.is_hardware_accelerated = true;
    info.enable_cpu_overuse_detection = true;
    info.has_trusted_rate_controller = false;
    // VSE parses H264 slice QP; use upstream H264 quality-scaler thresholds.
    info.is_qp_trusted = true;
    info.scaling_settings = ScalingSettings(24, 37);
    info.requested_resolution_alignment = 2;
    info.supports_native_handle = true;
    info.supports_simulcast = false;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kNative};
    return info;
  }

 private:
  const webrtc::Environment env_;
  const VideoProfile ceiling_;
  AdaptiveEncoder::Factory create_;
  std::unique_ptr<screener::capture::windows::VideoEncoder> initial_, encoder_;
  Failure& failure_;
  VideoProfile profile_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  UINT32 applied_bitrate_ = 0;
  bool paused_ = false, key_frame_pending_ = true;
};

webrtc::DegradationPreference Preference(DegradationPreference preference) {
  switch (preference) {
    case DegradationPreference::resolution: return webrtc::DegradationPreference::MAINTAIN_RESOLUTION;
    case DegradationPreference::framerate: return webrtc::DegradationPreference::MAINTAIN_FRAMERATE;
    case DegradationPreference::balanced: return webrtc::DegradationPreference::BALANCED;
  }
  Fail("adaptive-preference", "Unknown degradation preference");
}

}  // namespace

class AdaptiveEncoder::Impl final : public webrtc::VideoSourceInterface<webrtc::VideoFrame>,
                                    public webrtc::VideoStreamEncoderInterface::EncoderSink,
                                    public webrtc::VideoEncoderFactory {
 public:
  Impl(OutputKind kind, VideoProfile ceiling, ID3D11Device* device,
       Factory create, std::unique_ptr<VideoEncoder> initial)
      : kind_(kind), ceiling_(ceiling), device_(device), create_(std::move(create)),
        initial_(std::move(initial)), env_(webrtc::CreateEnvironment()),
        readback_(device, failure_), builtin_(webrtc::CreateBuiltinVideoEncoderFactory()),
        allocator_(webrtc::CreateBuiltinVideoBitrateAllocatorFactory()),
        worker_(env_.task_queue_factory().CreateTaskQueue(
            "CaptureAdaptation", webrtc::TaskQueueFactory::Priority::kNormal)) {}

  ~Impl() override {
    Sync(worker_.get(), [&] {
      if (encoder_) {
        encoder_->Stop();
        encoder_.reset();
        encode_queue_ = nullptr;
      }
    });
  }

  void Start() {
    Sync(worker_.get(), [&] {
      const auto format = GetSupportedFormats().front();
      webrtc::VideoSendStream::Config send_config(nullptr);
      send_config.rtp.ssrcs = {1};
      send_config.rtp.payload_name = format.name;
      send_config.rtp.payload_type = 96;
      stats_ = std::make_unique<webrtc::SendStatisticsProxy>(
          &env_.clock(), send_config, webrtc::VideoEncoderConfig::ContentType::kRealtimeVideo,
          env_.field_trials());
      webrtc::VideoStreamEncoderSettings settings(webrtc::VideoEncoder::Capabilities(false));
      settings.encoder_factory = this;
      settings.bitrate_allocator_factory = allocator_.get();
      auto queue = env_.task_queue_factory().CreateTaskQueue(
          "CaptureEncoder", webrtc::TaskQueueFactory::Priority::kNormal);
      encode_queue_ = queue.get();
      auto cadence = webrtc::FrameCadenceAdapterInterface::Create(
          &env_.clock(), queue.get(), nullptr, webrtc::TaskQueueBase::Current(), env_.field_trials());
      encoder_ = std::make_unique<webrtc::VideoStreamEncoder>(
          env_, static_cast<int>(std::max(1u, std::thread::hardware_concurrency())),
          stats_.get(), settings, std::make_unique<webrtc::OveruseFrameDetector>(env_, stats_.get()),
          std::move(cadence), std::move(queue),
          webrtc::VideoStreamEncoder::BitrateAllocationCallbackType::kVideoBitrateAllocation,
          nullptr, [this](std::optional<webrtc::SdpVideoFormat>, bool) {
            failure_.Set("WebRTC could not continue with the selected encoder");
          });
      adapter_.OnOutputFormatRequest(std::nullopt,
          static_cast<int>(ceiling_.width * ceiling_.height), static_cast<int>(ceiling_.frame_rate));
      encoder_->SetSink(this, false);
      encoder_->SetSource(this, Preference(ceiling_.preference));
      encoder_->SetStartBitrate(static_cast<int>(ceiling_.bit_rate));
      webrtc::VideoEncoderConfig config;
      config.codec_type = kind_ == OutputKind::h264 ? webrtc::kVideoCodecH264 : webrtc::kVideoCodecVP8;
      config.video_format = format;
      config.content_type = webrtc::VideoEncoderConfig::ContentType::kRealtimeVideo;
      config.number_of_streams = 1;
      config.max_bitrate_bps = static_cast<int>(ceiling_.bit_rate);
      config.frame_drop_enabled = true;
      config.is_quality_scaling_allowed = true;
      config.simulcast_layers.resize(1);
      config.simulcast_layers[0].active = true;
      config.simulcast_layers[0].max_framerate = static_cast<int>(ceiling_.frame_rate);
      config.simulcast_layers[0].max_bitrate_bps = static_cast<int>(ceiling_.bit_rate);
      config.simulcast_layers[0].num_temporal_layers = 1;
      if (kind_ == OutputKind::vp8) {
        auto vp8 = webrtc::VideoEncoder::GetDefaultVp8Settings();
        vp8.automaticResizeOn = true;
        config.encoder_specific_settings =
            webrtc::make_ref_counted<webrtc::VideoEncoderConfig::Vp8EncoderSpecificSettings>(vp8);
      }
      encoder_->ConfigureEncoder(std::move(config), 1200, [this](webrtc::RTCError error) {
        if (!error.ok()) failure_.Set("WebRTC encoder configuration failed");
      });
    });
    Sync(encode_queue_, [] {});
    failure_.Rethrow();
  }

  std::optional<AdaptiveAccessUnit> Encode(FrameProducer produce, UINT32 source_width,
      UINT32 source_height, UINT64 timestamp100ns, bool key_frame, UINT32 bitrate) {
    if (!produce || source_width == 0 || source_height == 0 ||
        source_width > ceiling_.width || source_height > ceiling_.height ||
        timestamp100ns > static_cast<UINT64>(std::numeric_limits<INT64>::max()))
      Fail("adaptive-input", "Invalid adaptive encoder input");
    failure_.Rethrow();
    Sync(worker_.get(), [&] {
      const auto rate = webrtc::DataRate::BitsPerSec(std::min(bitrate, ceiling_.bit_rate));
      if (!bitrate_ || *bitrate_ != rate.bps()) {
        encoder_->OnBitrateUpdated(rate, rate, 0, 0, 0);
        bitrate_ = rate.bps();
      }
      if (key_frame) encoder_->SendKeyFrame();
      if (!source_sink_) return;
      if (!anchor100ns_) {
        anchor100ns_ = timestamp100ns;
        anchor_us_ = env_.clock().TimeInMicroseconds();
        anchor_ntp_ms_ = env_.clock().CurrentNtpInMilliseconds();
      }
      if (timestamp100ns < *anchor100ns_)
        Fail("adaptive-timestamp", "Capture timestamp moved before its output anchor");
      const auto elapsed = timestamp100ns - *anchor100ns_;
      const INT64 capture_us = anchor_us_ + static_cast<INT64>(elapsed / 10);
      const INT64 ntp_ms = anchor_ntp_ms_ + static_cast<INT64>(elapsed / 10'000);
      int crop_width, crop_height, width, height;
      if (!adapter_.AdaptFrameResolution(static_cast<int>(source_width),
          static_cast<int>(source_height), capture_us * 1000,
          &crop_width, &crop_height, &width, &height)) {
        source_sink_->OnDiscardedFrame();
        return;
      }
      auto texture = produce(static_cast<UINT32>(width), static_cast<UINT32>(height));
      if (!texture) Fail("adaptive-surface", "The selected NV12 surface is unavailable");
      D3D11_TEXTURE2D_DESC description{};
      texture->GetDesc(&description);
      ComPtr<ID3D11Device> texture_device;
      texture->GetDevice(&texture_device);
      if (texture_device.Get() != device_.Get() || description.Format != DXGI_FORMAT_NV12 ||
          description.Width != static_cast<UINT32>(width) ||
          description.Height != static_cast<UINT32>(height))
        Fail("adaptive-surface", "The selected NV12 surface has a different device or size");
      {
        std::lock_guard<std::mutex> lock(output_mutex_);
        timestamp100ns_ = timestamp100ns;
        rtp_timestamp_ = 90u * static_cast<UINT32>(ntp_ms);
        const double fps = std::min<double>(ceiling_.frame_rate, adapter_.GetMaxFramerate());
        duration100ns_ = static_cast<UINT64>(10'000'000 / fps);
      }
      auto buffer = webrtc::make_ref_counted<NativeVideoFrameBuffer>(
          std::move(texture), static_cast<UINT32>(width), static_cast<UINT32>(height),
          timestamp100ns, readback_);
      source_sink_->OnFrame(webrtc::VideoFrame::Builder().set_video_frame_buffer(buffer)
          .set_timestamp_us(capture_us).set_ntp_time_ms(ntp_ms).build());
    });
    // Both selected codecs complete synchronously; native frames cannot be retained by VSE.
    Sync(encode_queue_, [] {});
    Sync(worker_.get(), [] {});
    failure_.Rethrow();
    std::lock_guard<std::mutex> lock(output_mutex_);
    return std::exchange(output_, std::nullopt);
  }

  void AddOrUpdateSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
                       const webrtc::VideoSinkWants& wants) override {
    source_sink_ = sink;
    adapter_.OnSinkWants(wants);
  }
  void RemoveSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink) override {
    if (source_sink_ == sink) source_sink_ = nullptr;
  }

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    if (kind_ == OutputKind::vp8) return {webrtc::SdpVideoFormat("VP8")};
    return {webrtc::SdpVideoFormat("H264", {{"profile-level-id", ceiling_.profile_level_id()},
        {"packetization-mode", "1"}, {"level-asymmetry-allowed", "1"}})};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment& env,
                                            const webrtc::SdpVideoFormat& format) override {
    try {
      if (kind_ == OutputKind::vp8) {
        initial_.reset();
        auto encoder = builtin_->Create(env, format);
        if (!encoder) Fail("adaptive-vp8-create", "WebRTC VP8 encoder is unavailable");
        return encoder;
      }
      return std::make_unique<HardwareEncoder>(env, ceiling_, create_, std::move(initial_), failure_);
    } catch (...) {
      failure_.Capture();
      return nullptr;
    }
  }

  void OnEncoderConfigurationChanged(std::vector<webrtc::VideoStream>, bool,
      webrtc::VideoEncoderConfig::ContentType, int) override {}
  void OnBitrateAllocationUpdated(const webrtc::VideoBitrateAllocation&) override {}
  void OnVideoLayersAllocationUpdated(webrtc::VideoLayersAllocation) override {}
  void OnFrameDropped(uint32_t, int, bool) override {}
  Result OnEncodedImage(const webrtc::EncodedImage& image,
                        const webrtc::CodecSpecificInfo*) override {
    try {
      std::lock_guard<std::mutex> lock(output_mutex_);
      if (output_)
        Fail("adaptive-output-duplicate", "WebRTC returned more than one access unit for the current input");
      if (image.RtpTimestamp() != rtp_timestamp_)
        Fail("adaptive-output-timestamp", "WebRTC returned an access unit from a different input");
      if (image.size() == 0 || image.size() > kMaxProductAccessUnitBytes)
        Fail("adaptive-output-size", "Encoded access unit bytes=" + std::to_string(image.size()));
      if (image._encodedWidth == 0 || image._encodedHeight == 0 ||
          image._encodedWidth > ceiling_.width || image._encodedHeight > ceiling_.height)
        Fail("adaptive-output-dimensions", "WebRTC returned output outside its configured dimensions");
      AdaptiveAccessUnit output;
      output.access_unit.timestamp100ns = timestamp100ns_;
      output.access_unit.key_frame = image.IsKey();
      output.access_unit.bytes.assign(image.data(), image.data() + image.size());
      output.width = image._encodedWidth;
      output.height = image._encodedHeight;
      output.duration100ns = duration100ns_;
      output_ = std::move(output);
      return Result(Result::OK);
    } catch (...) {
      failure_.Capture();
      return Result(Result::ERROR_SEND_FAILED);
    }
  }

 private:
  const OutputKind kind_;
  const VideoProfile ceiling_;
  ComPtr<ID3D11Device> device_;
  Factory create_;
  std::unique_ptr<VideoEncoder> initial_;
  const webrtc::Environment env_;
  Failure failure_;
  Readback readback_;
  std::unique_ptr<webrtc::VideoEncoderFactory> builtin_;
  std::unique_ptr<webrtc::VideoBitrateAllocatorFactory> allocator_;
  std::unique_ptr<webrtc::SendStatisticsProxy> stats_;
  std::unique_ptr<webrtc::TaskQueueBase, webrtc::TaskQueueDeleter> worker_;
  std::unique_ptr<webrtc::VideoStreamEncoder> encoder_;
  webrtc::TaskQueueBase* encode_queue_ = nullptr;
  webrtc::VideoSinkInterface<webrtc::VideoFrame>* source_sink_ = nullptr;
  webrtc::VideoAdapter adapter_{2};
  std::optional<INT64> bitrate_;
  std::optional<UINT64> anchor100ns_;
  INT64 anchor_us_ = 0, anchor_ntp_ms_ = 0;
  std::mutex output_mutex_;
  std::optional<AdaptiveAccessUnit> output_;
  UINT64 timestamp100ns_ = 0, duration100ns_ = 0;
  UINT32 rtp_timestamp_ = 0;
};

AdaptiveEncoder::AdaptiveEncoder(OutputKind kind, VideoProfile ceiling, ID3D11Device* device,
    Factory create, std::unique_ptr<VideoEncoder> initial) {
  if ((kind != OutputKind::vp8 && kind != OutputKind::h264) || !device ||
      (kind == OutputKind::h264 && !create) ||
      ceiling.width == 0 || ceiling.height == 0 || (ceiling.width & 1) || (ceiling.height & 1) ||
      static_cast<UINT64>(ceiling.width) * ceiling.height > std::numeric_limits<int>::max() ||
      ceiling.frame_rate == 0 || ceiling.frame_rate > 1'000 || ceiling.bit_rate < 1'000 ||
      ceiling.bit_rate > static_cast<UINT32>(std::numeric_limits<int>::max()))
    Fail("adaptive-profile", "Invalid adaptive encoder profile");
  impl_ = std::make_unique<Impl>(kind, ceiling, device, std::move(create), std::move(initial));
  impl_->Start();
}

AdaptiveEncoder::~AdaptiveEncoder() = default;

std::optional<AdaptiveAccessUnit> AdaptiveEncoder::Encode(FrameProducer produce,
    UINT32 source_width, UINT32 source_height, UINT64 timestamp100ns,
    bool key_frame, UINT32 bitrate) {
  return impl_->Encode(std::move(produce), source_width, source_height, timestamp100ns,
                       key_frame, bitrate);
}

}  // namespace screener::capture::windows
