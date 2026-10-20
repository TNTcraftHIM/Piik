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
  return AdaptiveAccessUnit{impl_->encoder->Encode(nullptr, timestamp, key, deadline),
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
      create, std::move(prepared), active, [&](const EncodedAccessUnit&) { output.set_value(); },
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
      }, nullptr, true, [&](const EncodedAccessUnit&) { output.set_value(); },
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
  EncodedAccessUnit output{0, true, {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f}};
  WriteVideoActive(writer, arguments, true, output);
  std::array<char, 4096> bytes{};
  DWORD count = 0;
  assert(ReadFile(read, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr));
  const std::string status(bytes.data(), count);
  assert(status.find("\"profileLevelId\":\"42e01f\"") != std::string::npos);
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
  CheckH264ProfileCompatibility();
  CheckPrimaryFailureDetails();
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
}
