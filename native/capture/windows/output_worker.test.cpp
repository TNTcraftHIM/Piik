// Exercise the production worker with a synthetic codec at its existing link
// boundary. WARP supplies only the device-status API; no screen or audio is used.
#define wmain capture_main
#include "main.cpp"
#undef wmain

#include <cassert>
#include <future>

namespace piik::capture::windows {
class AdaptiveEncoder::Impl final {
 public:
  explicit Impl(Factory create, VideoProfile profile) : encoder(create(profile)) {}
  std::unique_ptr<VideoEncoder> encoder;
};

AdaptiveEncoder::AdaptiveEncoder(OutputKind, VideoProfile profile, ID3D11Device*,
    Factory create, std::unique_ptr<VideoEncoder>, int)
    : impl_(std::make_unique<Impl>(std::move(create), profile)) {}
AdaptiveEncoder::~AdaptiveEncoder() = default;

std::optional<AdaptiveAccessUnit> AdaptiveEncoder::Encode(FrameProducer,
    UINT32 width, UINT32 height, UINT64 timestamp, bool key, UINT32 bitrate) {
  impl_->encoder->SetBitrate(bitrate);
  return AdaptiveAccessUnit{impl_->encoder->Encode(nullptr, timestamp, key),
                            width, height, 333'333};
}
}  // namespace piik::capture::windows

class FixtureEncoder final : public VideoEncoder {
 public:
  FixtureEncoder(std::promise<void>* entered, std::shared_future<void> released)
      : VideoEncoder(OutputKind::h264, "fixture", "fixture"),
        entered_(entered), released_(std::move(released)) {}

  EncodedAccessUnit Encode(ID3D11Texture2D*, UINT64 timestamp, bool key,
      EncoderClock::time_point) override {
    if (entered_) {
      entered_->set_value();
      released_.wait();
      throw GateFailure("fixture-encode", "synthetic encoder failed", E_FAIL);
    }
    return {timestamp, key, {1, 2, 3}};
  }
  void SetBitrate(UINT32) override {}

 private:
  std::promise<void>* entered_;
  std::shared_future<void> released_;
};

void CheckWorkerFailureGeneration(ID3D11Device* device, bool replace) {
  std::promise<void> entered, release, output, failure;
  auto began = entered.get_future();
  auto released = release.get_future().share();
  auto delivered = output.get_future();
  auto failed = failure.get_future();
  std::atomic<unsigned> created = 0;
  HANDLE sink = CreateFileW(L"NUL", GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  assert(sink != INVALID_HANDLE_VALUE);
  ProtocolWriter writer(sink);
  OutputWorker worker(0, VideoProfile{}, OutputKind::h264, device, writer,
      [&](const VideoProfile&) -> std::unique_ptr<VideoEncoder> {
        return std::make_unique<FixtureEncoder>(created++ == 0 ? &entered : nullptr, released);
      }, nullptr, true, [&] { output.set_value(); },
      [&](std::exception_ptr error) {
        try { std::rethrow_exception(error); }
        catch (const GateFailure& actual) { assert(actual.result() == E_FAIL); }
        failure.set_value();
      });
  auto input = std::make_shared<CaptureInput>();
  input->width = 1280;
  input->height = 720;
  input->timestamp = 333'333;
  worker.Submit(input);
  assert(began.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  if (replace) {
    worker.SetActive(false);
    assert(worker.SetActive(true));
    worker.Submit(input);
  }
  release.set_value();
  if (replace) {
    assert(delivered.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    assert(failed.wait_for(std::chrono::milliseconds(0)) == std::future_status::timeout);
    assert(created == 2);
  } else {
    assert(failed.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    assert(delivered.wait_for(std::chrono::milliseconds(0)) == std::future_status::timeout);
    assert(created == 1);
    assert(!worker.SetActive(false) && !worker.SetActive(true));
  }
  worker.Stop();
  worker.Join();
  CloseHandle(sink);
}

void CheckPrimaryFailureDetails() {
  std::ostringstream output;
  auto previous = std::cerr.rdbuf(output.rdbuf());
  assert(OutputFailureDetail(3, std::make_exception_ptr(
      GateFailure("fixture-output", "original cause", E_ACCESSDENIED))) == "fixture-output");
  std::cerr.rdbuf(previous);
  const auto text = output.str();
  assert(text.find("layer=3") != std::string::npos);
  assert(text.find("original cause") != std::string::npos);
  assert(text.find("hresult=0x80070005") != std::string::npos);
  // With no COM apartment, the real decoder fails at its first API boundary.
  bool rejected = false;
  try { piik::capture::H264Decoder decoder(nullptr); }
  catch (const GateFailure& error) {
    rejected = error.stage() == "h264-decoder-create" && error.result() == CO_E_NOTINITIALIZED;
  }
  assert(rejected);
}

int main() {
  CheckPrimaryFailureDetails();
  ComPtr<ID3D11Device> device;
  Check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, nullptr, 0,
                         D3D11_SDK_VERSION, &device, nullptr, nullptr), "fixture-warp");
  CheckWorkerFailureGeneration(device.Get(), false);
  CheckWorkerFailureGeneration(device.Get(), true);
}
