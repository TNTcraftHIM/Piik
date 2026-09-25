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

void CheckEncoderCandidates() {
  const std::vector<EncoderCandidate> candidates{{0, 0}, {1, 0}, {1, 1}, {2, 0}};
  const EncoderCandidate preferred{1, 0};
  std::vector<EncoderCandidate> tried;
  const auto deadline = EncoderClock::now() + std::chrono::seconds(1);
  const auto chosen = SelectEncoderCandidate(candidates, preferred, deadline,
      [&](EncoderCandidate candidate) {
        tried.push_back(candidate);
        if (candidate != EncoderCandidate{1, 1})
          throw GateFailure("fixture-activation", "candidate is not usable", E_FAIL);
      });
  assert((chosen == EncoderCandidate{1, 1}));
  assert((tried == std::vector<EncoderCandidate>{{1, 0}, {0, 0}, {1, 1}}));
  tried.clear();
  try {
    SelectEncoderCandidate(candidates, chosen, deadline, [&](EncoderCandidate candidate) {
      tried.push_back(candidate);
      throw GateFailure("fixture-all-failed", "no working candidate", E_FAIL);
    });
    assert(false);
  } catch (const GateFailure& error) {
    assert(error.stage() == "fixture-all-failed");
  }
  assert(tried.size() == candidates.size() && tried.front() == chosen);
  tried.clear();
  try {
    SelectEncoderCandidate(candidates, preferred, EncoderClock::now(),
        [&](EncoderCandidate candidate) { tried.push_back(candidate); });
    assert(false);
  } catch (const GateFailure& error) {
    assert(error.stage() == "codec-probe-timeout");
  }
  assert(tried.empty());
}

void CheckAutoEncoderFallback() {
  const auto deadline = EncoderClock::time_point::max();
  const auto expired = EncoderClock::time_point::min();
  auto hardware = [] { return std::make_unique<FixtureEncoder>(nullptr, std::shared_future<void>{}); };
  for (const auto probe_deadline : {deadline, expired}) {
    auto initial = hardware();
    const auto* proven = initial.get();
    bool probed = false;
    const auto selected = CompareSoftwareEncoder(std::move(initial), .04, probe_deadline, [&]() -> double {
      probed = true;
      // A slow software comparison exhausts its budget after H264 succeeded.
      RequireEncoderTime(expired);
      return 0;
    });
    assert(selected.kind == OutputKind::h264 && selected.initial.get() == proven);
    assert(probed == (probe_deadline == deadline));
  }
  for (const double software_work : {.02, .04, .06}) {
    const auto selected = CompareSoftwareEncoder(hardware(), .04, deadline, [&] { return software_work; });
    assert((selected.kind == OutputKind::vp8) == (software_work <= .04));
    assert(static_cast<bool>(selected.initial) == (software_work > .04));
  }
  const auto software_only = CompareSoftwareEncoder(nullptr, std::nullopt, deadline, [] { return .03; });
  assert(software_only.kind == OutputKind::vp8 && !software_only.initial);
  for (const auto probe_deadline : {deadline, expired}) {
    bool failed = false;
    try {
      CompareSoftwareEncoder(nullptr, std::nullopt, probe_deadline, [&]() -> double {
        RequireEncoderTime(expired);
        return 0;
      });
    } catch (const GateFailure& error) {
      failed = error.stage() == "codec-probe-timeout";
    }
    assert(failed);  // No proved encoder must remain a startup failure.
  }
}

int main() {
  CheckEncoderCandidates();
  CheckAutoEncoderFallback();
  CheckPrimaryFailureDetails();
  ComPtr<ID3D11Device> device;
  Check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, nullptr, 0,
                         D3D11_SDK_VERSION, &device, nullptr, nullptr), "fixture-warp");
  CheckWorkerFailureGeneration(device.Get(), false);
  CheckWorkerFailureGeneration(device.Get(), true);
}
