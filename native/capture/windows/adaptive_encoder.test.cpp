// Exercise the actual WebRTC adapter with a codec that delays one keyframe.
#define WEBRTC_WIN 1
#define RTC_ENABLE_H265 1
#define NOMINMAX 1
// Match the release WebRTC SDK's inline checks, then enable this fixture's asserts.
#define NDEBUG
#include "adaptive_encoder.cpp"
#undef NDEBUG

#include <cassert>

using namespace piik::capture::windows;

class DelayedKeyframeEncoder final : public piik::capture::windows::VideoEncoder {
 public:
  explicit DelayedKeyframeEncoder(std::vector<bool>& requests)
      : VideoEncoder(piik::capture::OutputKind::h264, "fixture", "fixture"), requests_(requests) {}
  EncodedAccessUnit Encode(ID3D11Texture2D*, UINT64 timestamp, bool key,
      EncoderClock::time_point) override {
    requests_.push_back(key);
    return {timestamp, key && requests_.size() != 2, {1, 2, 3}};
  }
  void SetBitrate(UINT32) override {}

 private:
  std::vector<bool>& requests_;
};

class Frames final : public webrtc::EncodedImageCallback {
 public:
  void OnFrameDropped(uint32_t, int, bool) override { assert(false); }
  Result OnEncodedImage(const webrtc::EncodedImage& image,
      const webrtc::CodecSpecificInfo*) override {
    keys.push_back(image.IsKey());
    return Result(Result::OK);
  }
  std::vector<bool> keys;
};

int main() {
  const VideoProfile profile{64, 64, 30, 300'000};
  const auto env = webrtc::CreateEnvironment();
  Failure failure;
  std::vector<bool> requests;
  HardwareEncoder encoder(env, profile, [&](const VideoProfile&) {
    return std::make_unique<DelayedKeyframeEncoder>(requests);
  }, nullptr, failure);
  webrtc::VideoCodec config{};
  config.codecType = webrtc::kVideoCodecH264;
  config.width = 64;
  config.height = 64;
  config.maxFramerate = 30;
  config.startBitrate = 300;
  assert(encoder.InitEncode(&config, webrtc::VideoEncoder::Settings(
      webrtc::VideoEncoder::Capabilities(false), 1, 1200)) == WEBRTC_VIDEO_CODEC_OK);
  Frames frames;
  encoder.RegisterEncodeCompleteCallback(&frames);
  ComPtr<ID3D11Device> device;
  Check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, nullptr, 0,
      D3D11_SDK_VERSION, &device, nullptr, nullptr), "fixture-warp");
  Readback readback(device.Get(), failure);
  for (int i = 0; i < 4; ++i) {
    auto buffer = webrtc::make_ref_counted<NativeVideoFrameBuffer>(
        nullptr, 64, 64, (i + 1) * 333'333, readback, EncoderClock::time_point::max());
    const auto frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(buffer)
        .set_timestamp_us((i + 1) * 33'333).build();
    const std::vector<webrtc::VideoFrameType> requested{
        i == 1 ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta};
    assert(encoder.Encode(frame, &requested) == WEBRTC_VIDEO_CODEC_OK);
    failure.Rethrow();
  }
  // Delta output remains usable; only an actual recovery frame clears the request.
  if (requests != std::vector<bool>{true, true, true, false} ||
      frames.keys != std::vector<bool>{true, false, true, false}) {
    std::cerr << "A delayed keyframe lost its pending recovery request\n";
    return 1;
  }
}
