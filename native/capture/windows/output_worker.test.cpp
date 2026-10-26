// Exercise the production worker with a synthetic codec at its existing link
// boundary. WARP also checks decoded-surface copies; no screen or audio is used.
#define wmain capture_main
#include "main.cpp"
#undef wmain

#include <cassert>
#include <filesystem>
#include <fstream>
#include <future>
#include <iterator>

#define WEBRTC_WIN 1
#define NDEBUG
#include "api/video/video_adapter.h"
#undef NDEBUG

namespace piik::capture::windows {
class AdaptiveEncoder::Impl final {
 public:
  explicit Impl(Factory create, VideoProfile profile, std::unique_ptr<VideoEncoder> initial)
      : encoder(initial ? std::move(initial) : create(profile)) {}
  std::unique_ptr<VideoEncoder> encoder;
};

AdaptiveEncoder::AdaptiveEncoder(OutputKind, VideoProfile profile, ID3D11Device*,
    Factory create, std::unique_ptr<VideoEncoder> initial, int)
    : impl_(std::make_unique<Impl>(std::move(create), profile, std::move(initial))) {}
AdaptiveEncoder::~AdaptiveEncoder() = default;

std::optional<AdaptiveAccessUnit> AdaptiveEncoder::Encode(FrameProducer,
    UINT32 width, UINT32 height, UINT64 timestamp, bool key, UINT32 bitrate,
    EncoderClock::time_point deadline) {
  impl_->encoder->SetBitrate(bitrate);
  auto output = impl_->encoder->Encode(nullptr, timestamp, key, deadline);
  if (output.bytes.empty()) return std::nullopt;
  return AdaptiveAccessUnit{std::move(output), width, height, 333'333};
}
}  // namespace piik::capture::windows

class FixtureEncoder final : public VideoEncoder {
 public:
  FixtureEncoder(std::promise<void>* entered, std::shared_future<void> released, bool drop = false)
      : VideoEncoder(OutputKind::h264, "fixture", "fixture"),
        entered_(entered), released_(std::move(released)), drop_(drop) {}

  EncodedAccessUnit Encode(ID3D11Texture2D*, UINT64 timestamp, bool key,
      EncoderClock::time_point) override {
    if (entered_) {
      entered_->set_value();
      released_.wait();
      if (drop_) return {timestamp, false, {}};
      throw GateFailure("fixture-encode", "synthetic encoder failed", E_FAIL);
    }
    return {timestamp, key, {1, 2, 3}};
  }
  void SetBitrate(UINT32) override {}

 private:
  std::promise<void>* entered_;
  std::shared_future<void> released_;
  bool drop_;
};

void CheckQuietCaptureRefresh() {
  CaptureInput latest;
  latest.width = 1280;
  latest.height = 720;
  latest.presentation = {1280, 720};
  latest.timestamp = static_cast<UINT64>(MFGetSystemTime()) - 50'000'000;
  latest.capture_timestamp = latest.timestamp;
  const auto previous = latest.timestamp;
  const auto before = static_cast<UINT64>(MFGetSystemTime());
  const auto refreshed = RefreshCaptureInput(latest);
  const auto after = static_cast<UINT64>(MFGetSystemTime());
  assert(refreshed->timestamp >= before && refreshed->timestamp <= after);
  assert(refreshed->timestamp - previous >= 50'000'000);
  assert(latest.timestamp == previous);
  assert(refreshed->capture_timestamp == latest.capture_timestamp);
  assert(refreshed->width == latest.width && refreshed->height == latest.height &&
         refreshed->presentation.cx == latest.presentation.cx &&
         refreshed->presentation.cy == latest.presentation.cy &&
         refreshed->color_space == latest.color_space && refreshed->texture.Get() == latest.texture.Get());
  // The compositor changed the picture just before the refresh, but its frame
  // callback arrives afterwards. It is new capture input, not a stale still.
  const auto delayed_capture = before - 1;
  const auto following = CapturePresentationTimestamp(delayed_capture, previous, refreshed->timestamp, 0);
  assert(following && *following > refreshed->timestamp);
  assert((*following - refreshed->timestamp) * 90'000 >= 10'000'000);
  assert(!CapturePresentationTimestamp(previous, previous, refreshed->timestamp, 0));
  const auto current_capture = after + 10'000'000;
  const auto current = CapturePresentationTimestamp(current_capture, delayed_capture, *following, 0);
  assert(current && *current == current_capture);
  // Minimized title-bar frames can arrive after restore. Their timestamps are
  // newer than the last real picture, but older than the observed restoration.
  const auto restored_at = current_capture + 10'000'000;
  assert(!CapturePresentationTimestamp(restored_at - 1, current_capture, *current, restored_at));
  const auto restored = CapturePresentationTimestamp(restored_at + 1, current_capture, *current, restored_at);
  assert(restored && *restored == restored_at + 1);
}

class CadenceEncoder final : public VideoEncoder {
 public:
  explicit CadenceEncoder(int fps) : VideoEncoder(OutputKind::h264, "cadence", "cadence") {
    adapter_.OnOutputFormatRequest(std::nullopt, 64 * 64, fps);
  }
  EncodedAccessUnit Encode(ID3D11Texture2D*, UINT64 timestamp, bool key,
      EncoderClock::time_point) override {
    int crop_width, crop_height, width, height;
    if (!adapter_.AdaptFrameResolution(64, 64, static_cast<int64_t>(timestamp * 100),
        &crop_width, &crop_height, &width, &height)) return {timestamp, false, {}};
    if (key) ++key_requests_;
    return {timestamp, key && key_requests_ != 2,
      {static_cast<BYTE>(bitrate_ >> 24), static_cast<BYTE>(bitrate_ >> 16),
       static_cast<BYTE>(bitrate_ >> 8), static_cast<BYTE>(bitrate_)}};
  }
  void SetBitrate(UINT32 bitrate) override { bitrate_ = bitrate; }
 private:
  webrtc::VideoAdapter adapter_{2};
  unsigned key_requests_ = 0;
  UINT32 bitrate_ = 0;
};

void CheckRetainedContentAtAdaptedCadence(ID3D11Device* device) {
  HANDLE sink = CreateFileW(L"NUL", GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  assert(sink != INVALID_HANDLE_VALUE);
  ProtocolWriter writer(sink);
  const VideoProfile profile{64, 64, 30, 300'000};
  std::atomic<bool> refresh{false};
  std::atomic<UINT64> changed_at{UINT64_MAX};
  std::array<std::atomic<unsigned>, 2> delivered{}, changed{}, keys{};
  std::array<std::atomic<UINT32>, 2> published_bitrate{};
  std::vector<std::unique_ptr<OutputWorker>> workers;
  for (int layer = 0; layer < 2; ++layer) {
    workers.push_back(std::make_unique<OutputWorker>(static_cast<UINT8>(layer), profile,
        OutputKind::h264, device, writer, [layer](const VideoProfile&) {
          return std::make_unique<CadenceEncoder>(layer == 0 ? 3 : 11);
        }, nullptr, true, [&, layer](const AdaptiveAccessUnit& output) {
          ++delivered[layer];
          if (output.access_unit.timestamp100ns >= changed_at.load()) ++changed[layer];
          if (output.access_unit.key_frame) ++keys[layer];
          const auto& bytes = output.access_unit.bytes;
          published_bitrate[layer].store((static_cast<UINT32>(bytes[0]) << 24) |
              (static_cast<UINT32>(bytes[1]) << 16) | (static_cast<UINT32>(bytes[2]) << 8) | bytes[3]);
        }, [](std::exception_ptr error) { std::rethrow_exception(error); },
        [&] { refresh.store(true); }));
  }
  auto input = std::make_shared<CaptureInput>();
  input->width = input->height = 64;
  input->presentation = {64, 64};
  input->timestamp = static_cast<UINT64>(MFGetSystemTime());
  input->capture_timestamp = input->timestamp;
  auto submit = [&](std::shared_ptr<const CaptureInput> next) {
    for (auto& worker : workers) worker->Submit(next);
  };
  const auto deadline = EncoderClock::now() + std::chrono::seconds(3);
  auto wait = [&](auto done) {
    while (!done()) {
      assert(EncoderClock::now() < deadline);
      if (refresh.exchange(false)) submit(RefreshCaptureInput(*input));
      std::this_thread::sleep_for(std::chrono::milliseconds(34));
    }
  };
  for (auto& worker : workers) worker->SetBitrate(profile.bit_rate / 2);
  submit(input);
  wait([&] { return delivered[0] > 0 && delivered[1] > 0; });
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  input = std::make_shared<CaptureInput>(*input);
  input->timestamp = static_cast<UINT64>(MFGetSystemTime());
  input->capture_timestamp = input->timestamp;
  changed_at.store(input->timestamp);
  submit(input);
  wait([&] { return changed[0] > 0 && changed[1] > 0; });
  // One rendition's drop must not reopen the other rendition's delivered content.
  if (refresh.exchange(false)) submit(RefreshCaptureInput(*input));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  assert(!refresh.load());
  const auto before = keys[0].load();
  workers[0]->RequestKeyFrame();
  submit(RefreshCaptureInput(*input));
  wait([&] { return keys[0] > before; });
  if (refresh.exchange(false)) submit(RefreshCaptureInput(*input));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  assert(!refresh.load());
  workers[0]->SetBitrate(profile.bit_rate);
  submit(RefreshCaptureInput(*input));
  wait([&] { return published_bitrate[0] == profile.bit_rate; });
  if (refresh.exchange(false)) submit(RefreshCaptureInput(*input));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  assert(!refresh.load());
  for (auto& worker : workers) worker->Stop();
  for (auto& worker : workers) worker->Join();
  CloseHandle(sink);
}

void CheckRetiredDropCannotRequestRefresh(ID3D11Device* device, bool stop) {
  std::promise<void> entered, release, output;
  auto began = entered.get_future();
  auto released = release.get_future().share();
  auto delivered = output.get_future();
  std::atomic<bool> refresh{false};
  std::atomic<unsigned> created{0};
  HANDLE sink = CreateFileW(L"NUL", GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  assert(sink != INVALID_HANDLE_VALUE);
  ProtocolWriter writer(sink);
  OutputWorker worker(0, VideoProfile{}, OutputKind::h264, device, writer,
      [&](const VideoProfile&) {
        return std::make_unique<FixtureEncoder>(created++ == 0 ? &entered : nullptr, released, true);
      },
      nullptr, true, [&](const AdaptiveAccessUnit&) { output.set_value(); },
      [](std::exception_ptr error) { std::rethrow_exception(error); },
      [&] { refresh.store(true); });
  auto input = std::make_shared<CaptureInput>();
  input->width = 1280;
  input->height = 720;
  input->presentation = {1280, 720};
  input->timestamp = input->capture_timestamp = static_cast<UINT64>(MFGetSystemTime());
  worker.Submit(input);
  assert(began.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  if (stop) worker.Stop();
  else {
    worker.SetActive(false);
    assert(worker.SetActive(true));
    worker.Submit(input);
  }
  release.set_value();
  if (!stop) assert(delivered.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  worker.Stop();
  worker.Join();
  assert(!refresh.load());
  CloseHandle(sink);
}

void CheckWorkerFailureGeneration(ID3D11Device* device, bool replace, bool active = true) {
  std::promise<void> entered, release, output, failure;
  auto began = entered.get_future();
  auto released = release.get_future().share();
  auto delivered = output.get_future();
  auto failed = failure.get_future();
  std::atomic<unsigned> created = 0;
  HANDLE sink = CreateFileW(L"NUL", GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  assert(sink != INVALID_HANDLE_VALUE);
  ProtocolWriter writer(sink);
  const AdaptiveEncoder::Factory create = [&](const VideoProfile&) -> std::unique_ptr<VideoEncoder> {
    return std::make_unique<FixtureEncoder>(created++ == 0 ? &entered : nullptr, released);
  };
  // The selected codec moves into its worker without recreation. Retirement
  // still rebuilds it from the same factory.
  auto prepared = create(VideoProfile{});
  OutputWorker worker(0, VideoProfile{}, OutputKind::h264, device, writer,
      create, std::move(prepared), active, [&](const AdaptiveAccessUnit&) { output.set_value(); },
      [&](std::exception_ptr error) {
        try { std::rethrow_exception(error); }
        catch (const GateFailure& actual) { assert(actual.result() == E_FAIL); }
        failure.set_value();
      });
  auto input = std::make_shared<CaptureInput>();
  input->width = 1280;
  input->height = 720;
  input->presentation = {1280, 720};
  input->timestamp = 333'333;
  if (!active) assert(worker.SetActive(true));
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

void CheckWorkerDimensions(ID3D11Device* device, SIZE content, SIZE expected) {
  HANDLE read = nullptr, write = nullptr;
  assert(CreatePipe(&read, &write, nullptr, 4096));
  UniqueHandle input_pipe(read), output_pipe(write);
  ProtocolWriter writer(write);
  std::promise<void> output;
  auto delivered = output.get_future();
  OutputWorker worker(0, VideoProfile{}, OutputKind::h264, device, writer,
      [](const VideoProfile&) -> std::unique_ptr<VideoEncoder> {
        return std::make_unique<FixtureEncoder>(nullptr, std::shared_future<void>{});
      }, nullptr, true, [&](const AdaptiveAccessUnit& actual) {
        assert(actual.width == static_cast<UINT32>(expected.cx));
        assert(actual.height == static_cast<UINT32>(expected.cy));
        output.set_value();
      },
      [&](std::exception_ptr error) { output.set_exception(error); });
  auto frame = std::make_shared<CaptureInput>();
  frame->width = static_cast<UINT32>(content.cx);
  frame->height = static_cast<UINT32>(content.cy);
  frame->presentation = content;
  frame->timestamp = 333'333;
  worker.Submit(frame);
  assert(delivered.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  delivered.get();
  worker.Stop();
  worker.Join();
  std::array<BYTE, 35> packet{};
  DWORD received = 0;
  assert(ReadFile(read, packet.data(), static_cast<DWORD>(packet.size()), &received, nullptr));
  assert(received == packet.size());
  assert((packet[24] << 8 | packet[25]) == expected.cx);
  assert((packet[26] << 8 | packet[27]) == expected.cy);
}

void CheckH264ProfileCompatibility() {
  const VideoProfile profile;
  for (const auto* value : {"42c01f", "42e01f", "42E01F", "4d801f", "58c01f",
                           "42c00a", "42c016", "42e01e", "42c02a", "42c033", "42c034"})
    assert(SupportsH264ProfileLevelId(value));
  for (const auto* value : {"42001f", "4d001f", "64001f", "42e11f", "42e01", "42e01fg",
                           "42e0gg", "42e035", "42e03c", "42e000", " 42c01"})
    assert(!SupportsH264ProfileLevelId(value));
  Runtime runtime;
  for (const auto size : {SIZE{1280, 720}, SIZE{3840, 2160}, SIZE{2160, 3840}}) {
    const auto type = CreateOutputType(VideoProfile{
        static_cast<UINT32>(size.cx), static_cast<UINT32>(size.cy), 60, 12'000'000});
    UINT32 level = 0;
    assert(type->GetUINT32(MF_MT_MPEG2_LEVEL, &level) == MF_E_ATTRIBUTENOTFOUND);
  }

  HANDLE read = nullptr, write = nullptr;
  assert(CreatePipe(&read, &write, nullptr, 4096));
  ProtocolWriter writer(write);
  ProductArguments arguments;
  arguments.outputs = {profile};
  AdaptiveAccessUnit output{{0, true, {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f}}, 640, 480, 333'333};
  WriteVideoActive(writer, arguments, true, output);
  std::array<char, 4096> bytes{};
  DWORD count = 0;
  assert(ReadFile(read, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr));
  const std::string status(bytes.data(), count);
  assert(status.find("\"profileLevelId\":\"42e01f\"") != std::string::npos);
  assert(status.find("\"width\":640,\"height\":480") != std::string::npos);
  assert(arguments.profile.width == 1280 && arguments.profile.height == 720);
  assert(status.find("42c01f") == std::string::npos);
  CloseHandle(write);
  CloseHandle(read);
}

void CheckEncoderCandidates() {
  const std::vector<EncoderCandidate> candidates{{0, 0}, {1, 0}, {1, 1}, {2, 0}};
  const EncoderCandidate preferred{1, 0};
  std::vector<EncoderCandidate> tried;
  const auto deadline = EncoderClock::now() + std::chrono::seconds(1);
  std::ostringstream diagnostic;
  auto previous = std::cerr.rdbuf(diagnostic.rdbuf());
  const auto chosen = SelectEncoderCandidate(candidates, preferred, deadline,
      [&](EncoderCandidate candidate) {
        tried.push_back(candidate);
        if (candidate == preferred)
          throw GateFailure("input-texture-create", "fixture device loss", DXGI_ERROR_DEVICE_REMOVED);
        if (candidate != EncoderCandidate{1, 1})
          throw GateFailure("fixture-activation", "candidate is not usable", E_FAIL);
      });
  std::cerr.rdbuf(previous);
  assert((chosen == EncoderCandidate{1, 1}));
  assert((tried == std::vector<EncoderCandidate>{{1, 0}, {0, 0}, {1, 1}}));
  assert(diagnostic.str().find("stage=input-texture-create") != std::string::npos);
  assert(diagnostic.str().find("fixture device loss") != std::string::npos);
  assert(diagnostic.str().find("hresult=0x887a0005") != std::string::npos);
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

  // A slow failed candidate can leave 750 ms of the four-second selection
  // budget. Auto at 30 fps cannot fit its cadence measurement into that time;
  // manual H264 and the immediate two-frame 1 fps probe still can proceed.
  for (const auto [automatic, frame_rate] :
       {std::pair{true, 30U}, std::pair{false, 30U}, std::pair{true, 1U}}) {
    VideoProfile profile;
    profile.frame_rate = frame_rate;
    const auto minimum_time = automatic ? CadenceTiming(profile).MinimumDuration()
                                        : EncoderClock::duration::zero();
    tried.clear();
    bool expired = false;
    try {
      const auto selected = SelectEncoderCandidate(candidates, preferred,
          EncoderClock::now() + std::chrono::milliseconds(750),
          [&](EncoderCandidate candidate) { tried.push_back(candidate); }, minimum_time);
      assert(selected == preferred);
    } catch (const GateFailure& error) {
      expired = error.stage() == "codec-probe-timeout";
    }
    assert(expired == (automatic && frame_rate == 30));
    assert(tried.size() == (expired ? 0U : 1U));
  }
}

class CadenceFixtureEncoder final : public VideoEncoder {
 public:
  CadenceFixtureEncoder(std::chrono::milliseconds latency, UINT32 dropped, bool cold_only,
                        UINT32& calls)
      : VideoEncoder(OutputKind::h264, "cadence-fixture", "cadence-fixture"),
        latency_(latency), dropped_(dropped), cold_only_(cold_only), calls_(calls) {}

  EncodedAccessUnit Encode(ID3D11Texture2D*, UINT64 timestamp, bool key,
      EncoderClock::time_point deadline) override {
    if (!cold_only_ || calls_ == 0) std::this_thread::sleep_for(latency_);
    ++calls_;
    RequireEncoderTime(deadline);
    // An empty unit stands for an input the pipeline did not encode.
    return calls_ <= dropped_ ? EncodedAccessUnit{timestamp, key, {}} : EncodedAccessUnit{timestamp, key, {1, 2, 3}};
  }
  void SetBitrate(UINT32) override {}

 private:
  std::chrono::milliseconds latency_;
  UINT32 dropped_;
  bool cold_only_;
  UINT32& calls_;
};

void CheckAutoCadenceProbe(ID3D11Device* device) {
  // The Browser probe allows one 100 ms poll of lag at each target rate.
  assert(CadenceLagFrames(5) == 1 && CadenceLagFrames(15) == 2 &&
         CadenceLagFrames(30) == 3 && CadenceLagFrames(60) == 6);
  VideoProfile profile;
  profile.width = 64;
  profile.height = 64;
  // WARP checks cadence independently of hardware video-processor support.
  DeviceContext context;
  context.device = device;
  const std::vector<BYTE> pixels(profile.width * profile.height * 3 / 2, 128);
  EncoderProbeTextures textures;
  for (auto& texture : textures)
    texture = UploadDecodedNV12(context, pixels.data(), profile.width, profile.height);
  UINT32 calls = 0;
  auto probe = [&](std::chrono::milliseconds latency, UINT32 dropped,
                   EncoderClock::time_point deadline, bool cold_only = false) {
    calls = 0;
    CadenceFixtureEncoder encoder(latency, dropped, cold_only, calls);
    return SustainsEncodedCadence(encoder, device, profile, deadline, textures);
  };
  const auto deadline = EncoderClock::now() + std::chrono::seconds(30);
  // Valid output at a fraction of the source rate is the driver defect Auto rejects.
  assert(!probe(std::chrono::milliseconds(0), UINT32_MAX, deadline));
  const UINT32 warmup = (profile.frame_rate + 1) / 2;
  // Once missing frames exceed the allowance, even perfect remaining frames cannot pass.
  assert(calls == warmup + CadenceLagFrames(profile.frame_rate) + 1);
  // Exactly the allowed loss must still complete and pass the original measurement.
  assert(probe(std::chrono::milliseconds(0), warmup + CadenceLagFrames(profile.frame_rate), deadline));
  assert(calls == warmup + profile.frame_rate);
  // Cold startup must not reject an encoder that sustains the measured cadence.
  assert(probe(std::chrono::milliseconds(220), 0, deadline, true));
  // Sustained slow encoding still fails after warmup.
  assert(!probe(std::chrono::milliseconds(300), 0, deadline));
  profile.frame_rate = 1;
  assert(!probe(std::chrono::milliseconds(0), UINT32_MAX, deadline));
  assert(probe(std::chrono::milliseconds(0), 0, deadline));
  bool expired = false;
  try {
    probe(std::chrono::milliseconds(0), 0, EncoderClock::time_point::min());
  } catch (const GateFailure& error) {
    expired = error.stage() == "codec-probe-timeout";
  }
  assert(expired);
}

void CheckOutputSampleAlignment() {
  Runtime runtime;
  for (DWORD alignment : {0u, 1u, 16u, 64u, 512u}) {
    MFT_OUTPUT_STREAM_INFO info{};
    info.cbSize = 4096;
    info.cbAlignment = alignment;
    auto sample = CreateCallerOutputSample(info);
    ComPtr<IMFMediaBuffer> buffer;
    Check(sample->GetBufferByIndex(0, &buffer), "fixture-output-buffer");
    BYTE* data = nullptr;
    DWORD maximum = 0;
    Check(buffer->Lock(&data, &maximum, nullptr), "fixture-output-lock");
    const auto address = reinterpret_cast<uintptr_t>(data);
    Check(buffer->Unlock(), "fixture-output-unlock");
    assert(maximum >= info.cbSize);
    assert(alignment == 0 || address % alignment == 0);
  }
}

void CheckSurfaceSample(ID3D11Device* device) {
  Runtime runtime;
  const VideoProfile profile{64, 64, 30, 3'000'000};
  DeviceContext context;
  context.device = device;
  const std::vector<BYTE> pixels(profile.width * profile.height * 3 / 2, 128);
  auto texture = UploadDecodedNV12(context, pixels.data(), profile.width, profile.height);
  auto sample = CreateSurfaceSample(texture.Get(), 1'000'000, 333'333);
  ComPtr<IMFMediaBuffer> buffer;
  Check(sample->GetBufferByIndex(0, &buffer), "fixture-sample-buffer");
  DWORD current = 0, maximum = 0, total = 0;
  Check(buffer->GetCurrentLength(&current), "fixture-buffer-length");
  Check(buffer->GetMaxLength(&maximum), "fixture-buffer-capacity");
  Check(sample->GetTotalLength(&total), "fixture-sample-length");
  assert(current == profile.width * profile.height * 3 / 2);
  assert(total == current && maximum == current);
  ComPtr<IMFDXGIBuffer> surface;
  Check(buffer.As(&surface), "fixture-surface-buffer");
  ComPtr<ID3D11Texture2D> retained;
  Check(surface->GetResource(IID_PPV_ARGS(&retained)), "fixture-surface-resource");
  assert(retained.Get() == texture.Get());
  LONGLONG time = 0, duration = 0;
  Check(sample->GetSampleTime(&time), "fixture-sample-time");
  Check(sample->GetSampleDuration(&duration), "fixture-sample-duration");
  assert(time == 1'000'000 && duration == 333'333);
}

void CheckDecodedDisplayArea(ID3D11Device* device) {
  Runtime runtime;
  DeviceContext context;
  context.device = device;
  device->GetImmediateContext(&context.context);
  auto check_red = [&](ID3D11Texture2D* texture) {
    D3D11_TEXTURE2D_DESC description{};
    texture->GetDesc(&description);
    assert(description.Width == 3840 && description.Height == 2160 &&
           description.Format == DXGI_FORMAT_NV12);
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    Check(device->CreateTexture2D(&description, nullptr, &staging), "fixture-readback");
    context.context->CopyResource(staging.Get(), texture);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(context.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "fixture-map");
    const auto* pixels = static_cast<const BYTE*>(mapped.pData);
    for (UINT y : {0u, 1080u, 2159u}) {
      for (UINT x : {0u, 1920u, 3839u}) {
        const size_t uv = static_cast<size_t>(2160 + y / 2) * mapped.RowPitch + (x & ~1u);
        if (pixels[static_cast<size_t>(y) * mapped.RowPitch + x] <= 60 ||
            pixels[uv] >= 130 || pixels[uv + 1] <= 180)
          std::cerr << "aperture pixel " << x << ',' << y << " YUV="
                    << unsigned(pixels[static_cast<size_t>(y) * mapped.RowPitch + x]) << ','
                    << unsigned(pixels[uv]) << ',' << unsigned(pixels[uv + 1]) << '\n';
        assert(pixels[static_cast<size_t>(y) * mapped.RowPitch + x] > 60);
        assert(pixels[uv] < 130 && pixels[uv + 1] > 180);
      }
    }
    context.context->Unmap(staging.Get(), 0);
  };

  const auto path = std::filesystem::path(__FILE__).parent_path().parent_path().parent_path() /
      "fixtures" / "h264-padding" / "aperture.h264";
  std::ifstream file(path, std::ios::binary);
  assert(file);
  piik::capture::InputEnvelope input;
  input.kind = 2;
  input.recovery = true;
  input.width = 3840;
  input.height = 2160;
  input.duration = 10'000'000 / 24;
  input.data = std::vector<uint8_t>(std::istreambuf_iterator<char>(file), {});
  unsigned decoded = 0;
  piik::capture::H264Decoder decoder(nullptr);
  for (unsigned index = 0; index < 4; ++index) {
    input.timestamp = (index + 1) * input.duration;
    decoder.Decode(input, [&](IMFSample* sample, UINT32 width, UINT32 height, LONG stride) {
      const auto area = decoder.DisplayArea();
      assert(width == 3856 && height == 2176 && area.left == 0 && area.top == 0 &&
             area.right == 3840 && area.bottom == 2160);
      check_red(OwnDecodedTexture(context, sample, width, height, stride, area).Get());
      ++decoded;
    });
  }
  assert(decoded > 0);

  // Exercise the DXGI-buffer path with known NV12 padding as well.
  constexpr UINT width = 3872, height = 2176;
  std::vector<BYTE> pixels(width * height * 3 / 2);
  for (UINT y = 0; y < height; ++y) {
    for (UINT x = 0; x < width; ++x) {
      pixels[y * width + x] = x >= 16 && x < 3856 && y >= 8 && y < 2168 ? 81 : 41;
      if (y < height / 2) {
        const bool red = x >= 16 && x < 3856 && y >= 4 && y < 1084;
        pixels[(height + y) * width + x] = red ? (x % 2 ? 240 : 90) : (x % 2 ? 110 : 240);
      }
    }
  }
  auto texture = UploadDecodedNV12(context, pixels.data(), width, height);
  auto sample = CreateSurfaceSample(texture.Get(), 1'000'000, 416'666);
  check_red(OwnDecodedTexture(context, sample.Get(), width, height, width,
                            RECT{16, 8, 3856, 2168}).Get());
}

void CheckAudioCapabilityIsolation() {
  using Clock = AudioCapabilityProbe::Clock;
  // Each real worker must own its COM apartment; quick completion must not
  // wait out the optional budget or conflate the independently queried flags.
  const auto apartment = []() {
    APTTYPE type;
    APTTYPEQUALIFIER qualifier;
    assert(SUCCEEDED(CoGetApartmentType(&type, &qualifier)) && type == APTTYPE_MTA);
  };
  const auto start = Clock::now();
  AudioCapabilityProbe quick(start + std::chrono::seconds(5),
      [apartment](bool exclude) { apartment(); return !exclude; },
      [apartment]() { apartment(); return true; });
  const auto supported = quick.Snapshot();
  assert(Clock::now() - start < std::chrono::seconds(1));
  assert(supported.process && supported.system && !supported.exclusion);

  auto include_release = std::make_shared<std::promise<void>>();
  auto include_released = include_release->get_future().share();
  AudioCapabilityProbe include_slow(Clock::now() + std::chrono::milliseconds(30),
      [include_released](bool exclude) { if (!exclude) include_released.wait(); return true; },
      []() { return true; });
  const auto partial = include_slow.Snapshot();
  assert(!partial.process && partial.exclusion && partial.system);
  include_release->set_value();
  const auto include_deadline = Clock::now() + std::chrono::seconds(2);
  while (!include_slow.Snapshot().process) {
    assert(Clock::now() < include_deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  auto release = std::make_shared<std::promise<void>>();
  auto released = release->get_future().share();
  AudioCapabilityProbe slow(Clock::now() + std::chrono::milliseconds(30),
      [released](bool) { released.wait(); return true; },
      [released]() { released.wait(); return true; });
  const auto snapshot = slow.Snapshot();
  assert(!snapshot.process && !snapshot.system && !snapshot.exclusion);
  {
    Runtime runtime;
    std::ostringstream output;
    const auto previous = std::cout.rdbuf(output.rdbuf());
    try { WriteCapabilityProbe(slow); }
    catch (...) { std::cout.rdbuf(previous); release->set_value(); throw; }
    std::cout.rdbuf(previous);
    const auto payload = output.str();
    // The actual production serializer still emits video/encoder discovery
    // while all optional API queries remain blocked past their shared budget.
    assert(payload.find("\"videoCapture\":") != std::string::npos);
    assert(payload.find("\"adapters\":[") != std::string::npos);
    assert(payload.find("\"processAudio\":false") != std::string::npos);
    assert(payload.find("\"systemAudio\":false") != std::string::npos);
    assert(payload.find("\"processAudioExclusion\":false") != std::string::npos);
  }
  // The returned snapshot is independent of shared late results. Release the
  // controlled APIs and observe their successful completion before this fixture
  // ends, without requiring the production probe to join a blocked OS call.
  release->set_value();
  const auto deadline = Clock::now() + std::chrono::seconds(2);
  for (;;) {
    const auto current = slow.Snapshot();
    if (current.process && current.system && current.exclusion) break;
    assert(Clock::now() < deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  assert(!snapshot.process && !snapshot.system && !snapshot.exclusion);
}

int main() {
  VideoProfile profile{2560, 1440, 60, 12'000'000};
  ValidateVideoProfile(profile);
  for (const auto& requested : {VideoProfile{1280, 720, 1, 100'000},
                               VideoProfile{1280, 720, 5, 800'000},
                               VideoProfile{3840, 2160, 60, 50'000'000},
                               VideoProfile{1920, 1080, 240, 240'000'000},
                               VideoProfile{2560, 1440, 144, 100'000'000},
                               VideoProfile{5120, 1440, 60, 100'000'000},
                               VideoProfile{4096, 2304, 56, 80'000'000}}) {
    ValidateVideoProfile(requested);
  }
  for (const auto& requested : {VideoProfile{1280, 720, 0, 100'000},
                               VideoProfile{1280, 720, 1, 99'999},
                               VideoProfile{3840, 2160, 60, 240'000'001},
                               VideoProfile{1920, 1080, 241, 100'000'000}}) {
    try {
      ValidateVideoProfile(requested);
      assert(false);
    } catch (const GateFailure& error) {
      assert(error.stage() == "argument-profile");
    }
  }
  for (const SIZE size : {SIZE{1920, 1200}, SIZE{720, 1280}, SIZE{4, 4},
                          SIZE{3840, 2160}, SIZE{2160, 3840}, SIZE{3000, 2764}}) {
    ValidateVideoProfile(VideoProfile{static_cast<UINT32>(size.cx), static_cast<UINT32>(size.cy), 60, 3'000'000});
  }
  for (const SIZE size : {SIZE{0, 720}, SIZE{2, 720}, SIZE{1280, 2}, SIZE{1279, 720},
                          SIZE{1280, 719}, SIZE{8194, 100}, SIZE{5120, 2880},
                          SIZE{4096, 2306}, SIZE{6562, 1438}}) {
    try {
      ValidateVideoProfile(VideoProfile{static_cast<UINT32>(size.cx), static_cast<UINT32>(size.cy), 30, 3'000'000});
      assert(false);
    } catch (const GateFailure& error) {
      assert(error.stage() == "argument-profile");
    }
  }
  assert(piik::capture::ValidVideoFormat(3840, 2160, 30));
  assert(piik::capture::ValidVideoFormat(3840, 2160, 60));
  assert(piik::capture::ValidVideoFormat(2160, 3840, 60));
  assert(!piik::capture::ValidVideoFormat(3840, 2160, 65));
  assert(!piik::capture::ValidVideoFormat(UINT32_MAX, UINT32_MAX, UINT32_MAX));
  assert(piik::capture::ValidCodedVideoSize(3840, 2176));
  assert(piik::capture::ValidCodedVideoSize(2176, 3840));
  assert(!piik::capture::ValidCodedVideoSize(3840, 3840));
  assert(!piik::capture::ValidCodedVideoSize(UINT32_MAX, UINT32_MAX));
  CheckEncoderCandidates();
  CheckQuietCaptureRefresh();
  CheckH264ProfileCompatibility();
  CheckPrimaryFailureDetails();
  CheckAudioCapabilityIsolation();
  CheckOutputSampleAlignment();
  ComPtr<ID3D11Device> device;
  Check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, nullptr, 0,
                         D3D11_SDK_VERSION, &device, nullptr, nullptr), "fixture-warp");
  CheckSurfaceSample(device.Get());
  CheckDecodedDisplayArea(device.Get());
  CheckAutoCadenceProbe(device.Get());
  CheckWorkerFailureGeneration(device.Get(), false);
  CheckWorkerFailureGeneration(device.Get(), true);
  CheckWorkerFailureGeneration(device.Get(), false, false);
  CheckWorkerDimensions(device.Get(), {1080, 1920}, {404, 720});
  CheckWorkerDimensions(device.Get(), {3440, 1440}, {1280, 534});
  CheckWorkerDimensions(device.Get(), {640, 480}, {640, 480});
  CheckRetainedContentAtAdaptedCadence(device.Get());
  CheckRetiredDropCannotRequestRefresh(device.Get(), false);
  CheckRetiredDropCannotRequestRefresh(device.Get(), true);
}
