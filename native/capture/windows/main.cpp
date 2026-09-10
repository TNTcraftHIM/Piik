#define NOMINMAX
#include <windows.h>

#include <codecapi.h>
#include <d3d10_1.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <evr.h>
#include <fcntl.h>
#include <io.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wmcodecdsp.h>
#ifdef PIIK_H264_FIXTURE
#include <pdh.h>
#include <pdhmsg.h>
#endif
#include <propvarutil.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winternl.h>
#include <wrl/client.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>

#include "capture_target.h"
#include "capture_geometry.h"
#include "process_audio.h"
#include "h264_encoder.h"
#ifndef PIIK_H264_FIXTURE
#include "adaptive_encoder.h"
#include "capture_control.h"
#include "capture_input.h"
#include "h264_decoder.h"
#include "capture_output.h"
#include "output_mailbox.h"
#include "vp8_decoder.h"
#include <vpx/vpx_codec.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cwctype>
#include <exception>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

#ifndef ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession5_INTERFACE_DEFINED__
#define ____x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession5_INTERFACE_DEFINED__
namespace ABI::Windows::Graphics::Capture {
MIDL_INTERFACE("67C0EA62-1F85-5061-925A-239BE0AC09CB")
IGraphicsCaptureSession5 : public IInspectable {
 public:
  IFACEMETHOD(get_MinUpdateInterval)(
      ABI::Windows::Foundation::TimeSpan* value) = 0;
  IFACEMETHOD(put_MinUpdateInterval)(
      ABI::Windows::Foundation::TimeSpan value) = 0;
};
}  // namespace ABI::Windows::Graphics::Capture
#endif

namespace {

using namespace piik::capture::windows;

constexpr LONGLONG kFastCaptureUpdateInterval100ns = 40'000;
#ifdef PIIK_H264_FIXTURE
constexpr UINT32 kFrameRate = kDefaultVideoProfile.frame_rate;
constexpr UINT32 kBitRate = kDefaultVideoProfile.bit_rate;
constexpr UINT32 kGopFrames = kFrameRate * 2;
constexpr UINT32 kMaxEventsPerPump = 64;
constexpr UINT32 kFrameCount = 360;
constexpr UINT32 kRateProbeBitRate = kBitRate / 2;
constexpr UINT32 kRateProbeFrames = kFrameCount / 3;
constexpr UINT32 kMaxInFlight = 8;
constexpr DWORD kMaxPdhArrayBytes = 4 * 1024 * 1024;
constexpr DWORD kMaxPdhArrayItems = 16 * 1024;
constexpr LONGLONG kFrameDuration100ns = 10'000'000 / kFrameRate;
#endif

void EnableFastCaptureUpdates(
    const winrt::Windows::Graphics::Capture::GraphicsCaptureSession& session) {
  ComPtr<ABI::Windows::Graphics::Capture::IGraphicsCaptureSession5> session5;
  auto* inspectable = reinterpret_cast<IInspectable*>(winrt::get_abi(session));
  if (SUCCEEDED(inspectable->QueryInterface(IID_PPV_ARGS(&session5)))) {
    // Zero is not an unlimited rate on current Windows. Keep WGC faster than
    // every supported profile and let the output cadence own the exact cap.
    ABI::Windows::Foundation::TimeSpan interval{kFastCaptureUpdateInterval100ns};
    (void)session5->put_MinUpdateInterval(interval);
  }
}

std::wstring Lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](wchar_t character) { return std::towlower(character); });
  return value;
}

std::string LuidString(const LUID& luid) {
  std::ostringstream output;
  output << "0x" << std::hex << std::setfill('0') << std::setw(8)
         << static_cast<UINT32>(luid.HighPart) << ":0x" << std::setw(8)
         << luid.LowPart;
  return output.str();
}

void PrintAdapters(const std::vector<Adapter>& adapters) {
  for (const Adapter& adapter : adapters) {
    std::cout << "adapter_index=" << adapter.index
              << " name=" << NarrowAscii(adapter.description.Description)
              << " vendor=0x" << std::hex << std::setw(4) << std::setfill('0')
              << adapter.description.VendorId << " device=0x" << std::setw(4)
              << adapter.description.DeviceId << std::dec
              << " luid=" << LuidString(adapter.description.AdapterLuid) << '\n';
  }
}

std::vector<UINT8> SyntheticNv12(
    UINT32 frame_index, const VideoProfile& profile = kDefaultVideoProfile) {
  const auto width = profile.width;
  const auto height = profile.height;
  std::vector<UINT8> pixels(width * height * 3 / 2);
  const UINT32 bar_start = (frame_index * 11) % width;
  for (UINT32 y = 0; y < height; ++y) {
    for (UINT32 x = 0; x < width; ++x) {
      UINT32 distance = (x + width - bar_start) % width;
      UINT8 base = static_cast<UINT8>(16 + ((x / 8 + y / 8 + frame_index) % 180));
      pixels[y * width + x] = distance < 96 ? static_cast<UINT8>(235) : base;
    }
  }
  UINT8* uv = pixels.data() + width * height;
  for (UINT32 y = 0; y < height / 2; ++y) {
    for (UINT32 x = 0; x < width; x += 2) {
      uv[y * width + x] = static_cast<UINT8>(96 + (frame_index % 64));
      uv[y * width + x + 1] = static_cast<UINT8>(160 - (frame_index % 64));
    }
  }
  return pixels;
}

ComPtr<ID3D11Texture2D> CreateSyntheticTexture(
    ID3D11Device* device, UINT32 frame_index,
    const VideoProfile& profile = kDefaultVideoProfile) {
  std::vector<UINT8> pixels = SyntheticNv12(frame_index, profile);
  D3D11_TEXTURE2D_DESC description = {};
  description.Width = profile.width;
  description.Height = profile.height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_NV12;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;

  D3D11_SUBRESOURCE_DATA initial = {};
  initial.pSysMem = pixels.data();
  initial.SysMemPitch = profile.width;
  initial.SysMemSlicePitch = static_cast<UINT>(pixels.size());

  ComPtr<ID3D11Texture2D> texture;
  Check(device->CreateTexture2D(&description, &initial, &texture),
        "input-texture-create");
  return texture;
}

#ifdef PIIK_H264_FIXTURE
ComPtr<IMFSample> CreateInputSample(ID3D11Device* device, UINT32 frame_index) {
  auto texture = CreateSyntheticTexture(device, frame_index);
  ComPtr<IMFMediaBuffer> buffer;
  Check(MFCreateDXGISurfaceBuffer(IID_ID3D11Texture2D, texture.Get(), 0,
                                  FALSE, &buffer),
        "input-dxgi-buffer");
  ComPtr<IMFSample> sample;
  Check(MFCreateVideoSampleFromSurface(nullptr, &sample),
        "input-video-sample");
  Check(sample->AddBuffer(buffer.Get()), "input-sample-buffer");
  Check(sample->SetSampleTime(static_cast<LONGLONG>(frame_index) *
                                  kFrameDuration100ns),
        "input-sample-time");
  Check(sample->SetSampleDuration(kFrameDuration100ns),
        "input-sample-duration");
  return sample;
}
#endif

#ifdef PIIK_H264_FIXTURE
ULONGLONG ProcessCpu100ns() {
  FILETIME created = {};
  FILETIME exited = {};
  FILETIME kernel = {};
  FILETIME user = {};
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {
    Check(HRESULT_FROM_WIN32(GetLastError()), "process-cpu-sample");
  }
  ULARGE_INTEGER kernel_value = {};
  kernel_value.LowPart = kernel.dwLowDateTime;
  kernel_value.HighPart = kernel.dwHighDateTime;
  ULARGE_INTEGER user_value = {};
  user_value.LowPart = user.dwLowDateTime;
  user_value.HighPart = user.dwHighDateTime;
  return kernel_value.QuadPart + user_value.QuadPart;
}

class VideoEncodeSampler final {
 public:
  explicit VideoEncodeSampler(LUID adapter_luid)
      : adapter_luid_(adapter_luid), process_id_(GetCurrentProcessId()) {}

  ~VideoEncodeSampler() { Stop(); }

  void Start() {
    worker_ = std::thread([this]() { Run(); });
  }

  void Stop() {
    stop_.store(true);
    if (worker_.joinable()) {
      worker_.join();
    }
  }

  std::vector<double> Samples() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!error_.empty()) {
      Fail("videoencode-counter", error_);
    }
    return samples_;
  }

 private:
  void Run() noexcept {
    PDH_HQUERY query = nullptr;
    PDH_HCOUNTER counter = nullptr;
    PDH_STATUS status = PdhOpenQueryW(nullptr, 0, &query);
    if (status == ERROR_SUCCESS) {
      status = PdhAddEnglishCounterW(
          query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &counter);
    }
    if (status == ERROR_SUCCESS) {
      status = PdhCollectQueryData(query);
    }
    if (status != ERROR_SUCCESS) {
      SetError("could not initialize the Windows GPU Engine counter");
      if (query != nullptr) {
        PdhCloseQuery(query);
      }
      return;
    }

    std::wostringstream prefix;
    prefix << L"pid_" << process_id_ << L"_luid_0x" << std::hex
           << std::setfill(L'0') << std::setw(8)
           << static_cast<UINT32>(adapter_luid_.HighPart) << L"_0x"
           << std::setw(8) << adapter_luid_.LowPart << L"_";
    std::wstring expected_prefix = Lower(prefix.str());

    while (!stop_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      status = PdhCollectQueryData(query);
      if (status != ERROR_SUCCESS) {
        SetError("could not sample the Windows GPU Engine counter");
        break;
      }

      DWORD bytes = 0;
      DWORD count = 0;
      status = PdhGetFormattedCounterArrayW(counter,
                                            PDH_FMT_DOUBLE | PDH_FMT_NOCAP100,
                                            &bytes, &count, nullptr);
      if (status != PDH_MORE_DATA) {
        if (status == PDH_CSTATUS_NO_INSTANCE || status == PDH_NO_DATA) {
          StoreSample(0.0);
          continue;
        }
        SetError("could not size the Windows GPU Engine counter array");
        break;
      }
      if (bytes == 0 || bytes > kMaxPdhArrayBytes ||
          count > kMaxPdhArrayItems ||
          count > bytes / sizeof(PDH_FMT_COUNTERVALUE_ITEM_W)) {
        SetError("Windows GPU Engine counter array exceeded its bounds");
        break;
      }
      std::vector<UINT8> storage(bytes);
      auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(
          storage.data());
      status = PdhGetFormattedCounterArrayW(
          counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &bytes, &count, items);
      if (status != ERROR_SUCCESS) {
        SetError("could not read the Windows GPU Engine counter array");
        break;
      }
      if (bytes > storage.size() || count > kMaxPdhArrayItems ||
          count > storage.size() / sizeof(PDH_FMT_COUNTERVALUE_ITEM_W)) {
        SetError("Windows GPU Engine counter array changed beyond its bounds");
        break;
      }

      double total = 0.0;
      for (DWORD index = 0; index < count; ++index) {
        std::wstring name = Lower(items[index].szName);
        if (name.find(expected_prefix) != std::wstring::npos &&
            name.find(L"engtype_videoencode") != std::wstring::npos &&
            items[index].FmtValue.CStatus == ERROR_SUCCESS) {
          total += std::max(0.0, items[index].FmtValue.doubleValue);
        }
      }
      StoreSample(total);
    }
    PdhCloseQuery(query);
  }

  void StoreSample(double value) {
    std::lock_guard<std::mutex> lock(mutex_);
    samples_.push_back(value);
  }

  void SetError(const std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    error_ = error;
  }

  LUID adapter_luid_;
  DWORD process_id_;
  std::atomic<bool> stop_ = false;
  std::thread worker_;
  mutable std::mutex mutex_;
  std::vector<double> samples_;
  std::string error_;
};

struct RunEvidence final {
  UINT32 inputs = 0;
  UINT32 outputs = 0;
  UINT32 max_in_flight = 0;
  UINT32 recovery_units = 0;
  UINT64 output_bytes = 0;
  std::array<UINT64, 3> rate_phase_bytes{};
  std::vector<double> latencies_ms;
  std::vector<double> video_encode;
  std::string profile_level_id;
  ULONGLONG cpu_100ns = 0;
  double wall_seconds = 0.0;
};
#endif

#ifdef PIIK_H264_FIXTURE
bool IsRecoveryFrame(UINT32 frame) {
  return frame % kGopFrames == 0;
}

double Percentile95(std::vector<double> values) {
  if (values.empty()) {
    return 0.0;
  }
  std::sort(values.begin(), values.end());
  size_t index = static_cast<size_t>(
      std::ceil(static_cast<double>(values.size()) * 0.95)) - 1;
  return values[std::min(index, values.size() - 1)];
}

RunEvidence RunEncoder(const Adapter& adapter, const DeviceContext& device,
                       SelectedTransform& selected) {
  ConfigureCodec(selected.codec.Get());
  ComPtr<IMFMediaType> output_type = CreateOutputType();
  Check(selected.transform->SetOutputType(0, output_type.Get(), 0),
        "mft-set-output-type");
  ComPtr<IMFMediaType> input_type = CreateInputType();
  Check(selected.transform->SetInputType(0, input_type.Get(), 0),
        "mft-set-input-type");
  ValidateMediaTypes(selected.transform.Get());
  ValidateCodecReadback(selected.codec.Get());

  MFT_OUTPUT_STREAM_INFO output_info = {};
  Check(selected.transform->GetOutputStreamInfo(0, &output_info),
        "mft-output-stream-info");

  Check(selected.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
                                            0),
        "mft-begin-streaming");
  Check(selected.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM,
                                            0),
        "mft-start-stream");

  RunEvidence evidence;
  std::vector<std::chrono::steady_clock::time_point> submitted(kFrameCount);
  std::vector<bool> received(kFrameCount, false);
  std::optional<std::string> observed_profile;
  UINT32 pending_input = 0;
  bool drain_sent = false;
  bool drain_complete = false;

  VideoEncodeSampler video_encode(adapter.description.AdapterLuid);
  ULONGLONG cpu_start = ProcessCpu100ns();
  auto wall_start = std::chrono::steady_clock::now();
  auto next_input = wall_start;
  auto deadline = wall_start + std::chrono::seconds(30);
  video_encode.Start();

  try {
    while ((!drain_complete || evidence.outputs != kFrameCount) &&
           std::chrono::steady_clock::now() < deadline) {
      for (UINT32 event_count = 0; event_count < kMaxEventsPerPump;
           ++event_count) {
        if (std::chrono::steady_clock::now() >= deadline) {
          break;
        }
        ComPtr<IMFMediaEvent> event;
        HRESULT event_result = selected.events->GetEvent(MF_EVENT_FLAG_NO_WAIT,
                                                          &event);
        if (event_result == MF_E_NO_EVENTS_AVAILABLE) {
          break;
        }
        Check(event_result, "mft-get-event");
        HRESULT event_status = S_OK;
        Check(event->GetStatus(&event_status), "mft-event-status-read");
        Check(event_status, "mft-event-status");
        MediaEventType type = MEUnknown;
        Check(event->GetType(&type), "mft-event-type");

        if (type == METransformNeedInput) {
          if (evidence.inputs < kFrameCount) {
            if (pending_input >= kMaxInFlight) {
              Fail("mft-input-request-bound",
                   "hardware MFT queued more than eight input requests");
            }
            ++pending_input;
          }
        } else if (type == METransformHaveOutput) {
          ComPtr<IMFSample> sample = PullOutput(selected.transform.Get(),
                                                output_info);
          LONGLONG sample_time = -1;
          Check(sample->GetSampleTime(&sample_time), "output-sample-time");
          if (sample_time < 0 || sample_time % kFrameDuration100ns != 0) {
            Fail("output-timestamp", "output timestamp is off the input cadence");
          }
          UINT32 frame = static_cast<UINT32>(sample_time / kFrameDuration100ns);
          if (frame >= kFrameCount || received[frame]) {
            Fail("output-order", "output timestamp is duplicate or out of range");
          }
          if (frame != evidence.outputs) {
            Fail("output-reordering", "output frames were reordered");
          }

          std::vector<UINT8> bytes = ReadSample(sample.Get());
          NalSummary nal = InspectAnnexB(bytes);
          if (!nal.annex_b) {
            Fail("bitstream-annexb", "output is not Annex-B H264");
          }
          if (nal.profile_level_id) {
            if (observed_profile && *observed_profile != *nal.profile_level_id) {
              Fail("bitstream-profile-change",
                   "SPS profile-level-id changed during the run");
            }
            observed_profile = nal.profile_level_id;
          }
          if (IsRecoveryFrame(frame) && !(nal.sps && nal.pps && nal.idr)) {
            Fail("bitstream-recovery-unit",
                 "requested recovery access unit lacks SPS, PPS, or IDR");
          }
          if (IsRecoveryFrame(frame)) {
            ++evidence.recovery_units;
          }

          received[frame] = true;
          ++evidence.outputs;
          evidence.output_bytes += bytes.size();
          evidence.rate_phase_bytes[std::min<UINT32>(
              frame / kRateProbeFrames, 2)] += bytes.size();
          auto now = std::chrono::steady_clock::now();
          evidence.latencies_ms.push_back(
              std::chrono::duration<double, std::milli>(now - submitted[frame])
                  .count());
        } else if (type == METransformDrainComplete) {
          drain_complete = true;
        } else if (type == MEError) {
          Fail("mft-error-event", "hardware MFT emitted MEError");
        }
      }

      auto now = std::chrono::steady_clock::now();
      if (pending_input > 0 && evidence.inputs < kFrameCount &&
          evidence.inputs - evidence.outputs < kMaxInFlight &&
          now >= next_input) {
        UINT32 frame = evidence.inputs;
        if (frame == kRateProbeFrames) {
          SetU32(selected.codec.Get(), CODECAPI_AVEncCommonMeanBitRate,
                 kRateProbeBitRate, "codec-runtime-bitrate-low");
        } else if (frame == kRateProbeFrames * 2) {
          SetU32(selected.codec.Get(), CODECAPI_AVEncCommonMeanBitRate,
                 kBitRate, "codec-runtime-bitrate-high");
        }
        if (IsRecoveryFrame(frame)) {
          ForceKeyFrame(selected.codec.Get());
        }
        ComPtr<IMFSample> sample = CreateInputSample(device.device.Get(), frame);
        submitted[frame] = std::chrono::steady_clock::now();
        Check(selected.transform->ProcessInput(0, sample.Get(), 0),
              "mft-process-input");
        ++evidence.inputs;
        --pending_input;
        evidence.max_in_flight = std::max(
            evidence.max_in_flight, evidence.inputs - evidence.outputs);
        if (evidence.max_in_flight > kMaxInFlight) {
          Fail("mft-in-flight-bound", "hardware MFT exceeded eight in-flight frames");
        }
        next_input = wall_start + std::chrono::microseconds(
                                      static_cast<int64_t>(evidence.inputs) *
                                      1'000'000 / kFrameRate);
        if (evidence.inputs == kFrameCount) {
          Check(selected.transform->ProcessMessage(
                    MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0),
                "mft-end-stream");
          Check(selected.transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN,
                                                    0),
                "mft-drain");
          drain_sent = true;
        }
      } else {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    }
  } catch (...) {
    video_encode.Stop();
    selected.transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    selected.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    throw;
  }

  video_encode.Stop();
  auto wall_end = std::chrono::steady_clock::now();
  ULONGLONG cpu_end = ProcessCpu100ns();
  Check(selected.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0),
        "mft-end-streaming");

  if (!drain_sent || !drain_complete) {
    Fail("mft-drain-timeout", "hardware MFT did not drain within 30 seconds");
  }
  if (evidence.inputs != kFrameCount || evidence.outputs != kFrameCount) {
    Fail("frame-count", "hardware MFT did not produce 360 outputs for 360 inputs");
  }
  if (!observed_profile) {
    Fail("bitstream-sps", "no SPS profile-level-id was observed");
  }
  evidence.profile_level_id = *observed_profile;
  evidence.video_encode = video_encode.Samples();
  evidence.cpu_100ns = cpu_end - cpu_start;
  evidence.wall_seconds =
      std::chrono::duration<double>(wall_end - wall_start).count();

  double max_video_encode = evidence.video_encode.empty()
                                ? 0.0
                                : *std::max_element(evidence.video_encode.begin(),
                                                    evidence.video_encode.end());
  double mean_video_encode = evidence.video_encode.empty()
                                 ? 0.0
                                 : std::accumulate(evidence.video_encode.begin(),
                                                   evidence.video_encode.end(),
                                                   0.0) /
                                       evidence.video_encode.size();
  std::cout << "evidence_inputs=" << evidence.inputs << '\n'
            << "evidence_outputs=" << evidence.outputs << '\n'
            << "evidence_recovery_units=" << evidence.recovery_units << '\n'
            << "evidence_max_in_flight=" << evidence.max_in_flight << '\n'
            << "evidence_output_bytes=" << evidence.output_bytes << '\n'
            << "evidence_rate_phase_high_1_bytes="
            << evidence.rate_phase_bytes[0] << '\n'
            << "evidence_rate_phase_low_bytes="
            << evidence.rate_phase_bytes[1] << '\n'
            << "evidence_rate_phase_high_2_bytes="
            << evidence.rate_phase_bytes[2] << '\n'
            << "evidence_profile_level_id=" << evidence.profile_level_id << '\n'
            << std::fixed << std::setprecision(3)
            << "evidence_latency_p95_ms="
            << Percentile95(evidence.latencies_ms) << '\n'
            << "evidence_wall_seconds=" << evidence.wall_seconds << '\n'
            << "evidence_process_cpu_seconds="
            << static_cast<double>(evidence.cpu_100ns) / 10'000'000.0 << '\n'
            << "evidence_videoencode_samples=" << evidence.video_encode.size()
            << '\n'
            << "evidence_videoencode_mean_percent=" << mean_video_encode << '\n'
            << "evidence_videoencode_max_percent=" << max_video_encode << '\n'
            << std::flush;

  if (evidence.video_encode.size() < 10 || max_video_encode <= 0.1) {
    Fail("videoencode-attribution",
         "no process-and-adapter-attributed VideoEncode activity was observed");
  }
  if (!(evidence.rate_phase_bytes[1] < evidence.rate_phase_bytes[0] &&
        evidence.rate_phase_bytes[2] > evidence.rate_phase_bytes[1])) {
    Fail("codec-runtime-bitrate-effect",
         "live bitrate update did not lower and restore encoded output");
  }
  if (*observed_profile != "42c01f") {
    Fail("bitstream-pinned-fmtp",
         "SPS profile-level-id differs from the native media contract");
  }
  return evidence;
}
#endif

UINT ParseIndex(const wchar_t* value, const std::string& stage) {
  try {
    size_t consumed = 0;
    unsigned long parsed = std::stoul(value, &consumed, 10);
    if (value[consumed] != L'\0' || parsed > std::numeric_limits<UINT>::max()) {
      Fail(stage, "index is not a bounded unsigned integer");
    }
    return static_cast<UINT>(parsed);
  } catch (const std::exception&) {
    Fail(stage, "index is not a bounded unsigned integer");
  }
}

#ifndef PIIK_H264_FIXTURE
using piik::capture::kMaxProductAccessUnitBytes;
using piik::capture::OutputKind;
using piik::capture::ProtocolWriter;

class UniqueHandle final {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept
      : value_(std::exchange(other.value_, nullptr)) {}
  ~UniqueHandle() {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
  }
  HANDLE get() const { return value_; }

 private:
  HANDLE value_ = nullptr;
};

class FrameConverter final {
 public:
  explicit FrameConverter(
      ID3D11Device* device,
      VideoProfile profile = kDefaultVideoProfile)
      : device_(device), profile_(profile) {
    Check(device_->QueryInterface(IID_PPV_ARGS(&video_device_)),
          "video-processor-device");
    ComPtr<ID3D11DeviceContext> context;
    device_->GetImmediateContext(&context);
    Check(context.As(&video_context_), "video-processor-context");
  }

  ComPtr<ID3D11Texture2D> Convert(ID3D11Texture2D* source, UINT32 width,
                                  UINT32 height, SIZE presentation) {
    if (source == nullptr || width == 0 || height == 0 ||
        width > 16'384 || height > 16'384) {
      Fail("capture-size", "captured window dimensions are invalid");
    }
    if (!enumerator_ || width != input_width_ || height != input_height_) {
      Configure(width, height);
    }

    D3D11_TEXTURE2D_DESC output_description = {};
    output_description.Width = profile_.width;
    output_description.Height = profile_.height;
    output_description.MipLevels = 1;
    output_description.ArraySize = 1;
    output_description.Format = DXGI_FORMAT_NV12;
    output_description.SampleDesc.Count = 1;
    output_description.Usage = D3D11_USAGE_DEFAULT;
    output_description.BindFlags = D3D11_BIND_RENDER_TARGET;
    ComPtr<ID3D11Texture2D> output;
    Check(device_->CreateTexture2D(&output_description, nullptr, &output),
          "video-processor-output-texture");

    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_description = {};
    input_description.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    input_description.Texture2D.ArraySlice = 0;
    input_description.Texture2D.MipSlice = 0;
    ComPtr<ID3D11VideoProcessorInputView> input_view;
    Check(video_device_->CreateVideoProcessorInputView(
              source, enumerator_.Get(), &input_description, &input_view),
          "video-processor-input-view");

    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output_view_description = {};
    output_view_description.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    output_view_description.Texture2D.MipSlice = 0;
    ComPtr<ID3D11VideoProcessorOutputView> output_view;
    Check(video_device_->CreateVideoProcessorOutputView(
              output.Get(), enumerator_.Get(), &output_view_description,
              &output_view),
          "video-processor-output-view");

    RECT source_rect = {0, 0, static_cast<LONG>(width),
                        static_cast<LONG>(height)};
    RECT target_rect = piik::capture::FitFrameRect(
        presentation, {static_cast<LONG>(profile_.width),
                       static_cast<LONG>(profile_.height)});
    RECT output_rect = {0, 0, static_cast<LONG>(profile_.width),
                        static_cast<LONG>(profile_.height)};

    D3D11_VIDEO_COLOR background = {};
    background.RGBA.A = 1.0f;
    video_context_->VideoProcessorSetOutputBackgroundColor(processor_.Get(),
                                                            FALSE, &background);
    video_context_->VideoProcessorSetOutputTargetRect(processor_.Get(), TRUE,
                                                       &output_rect);
    video_context_->VideoProcessorSetStreamFrameFormat(
        processor_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    video_context_->VideoProcessorSetStreamSourceRect(processor_.Get(), 0,
                                                       TRUE, &source_rect);
    video_context_->VideoProcessorSetStreamDestRect(processor_.Get(), 0, TRUE,
                                                     &target_rect);
    video_context_->VideoProcessorSetStreamAutoProcessingMode(processor_.Get(),
                                                              0, FALSE);
    D3D11_VIDEO_PROCESSOR_STREAM stream = {};
    stream.Enable = TRUE;
    stream.pInputSurface = input_view.Get();
    Check(video_context_->VideoProcessorBlt(processor_.Get(), output_view.Get(),
                                             0, 1, &stream),
          "video-processor-blit");
    return output;
  }

 private:
  void Configure(UINT32 width, UINT32 height) {
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC description = {};
    description.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    description.InputFrameRate = {profile_.frame_rate, 1};
    description.InputWidth = width;
    description.InputHeight = height;
    description.OutputFrameRate = {profile_.frame_rate, 1};
    description.OutputWidth = profile_.width;
    description.OutputHeight = profile_.height;
    description.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    Check(video_device_->CreateVideoProcessorEnumerator(&description,
                                                         &enumerator),
          "video-processor-enumerator");
    ComPtr<ID3D11VideoProcessor> processor;
    Check(video_device_->CreateVideoProcessor(enumerator.Get(), 0, &processor),
          "video-processor-create");
    enumerator_ = std::move(enumerator);
    processor_ = std::move(processor);
    input_width_ = width;
    input_height_ = height;
  }

  ComPtr<ID3D11Device> device_;
  VideoProfile profile_;
  ComPtr<ID3D11VideoDevice> video_device_;
  ComPtr<ID3D11VideoContext> video_context_;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  UINT32 input_width_ = 0;
  UINT32 input_height_ = 0;
};

winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice
CreateCaptureDevice(ID3D11Device* device) {
  ComPtr<IDXGIDevice> dxgi_device;
  Check(device->QueryInterface(IID_PPV_ARGS(&dxgi_device)),
        "capture-dxgi-device");
  winrt::com_ptr<IInspectable> inspectable;
  Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(),
                                             inspectable.put()),
        "capture-winrt-device");
  return inspectable.as<
      winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
}

winrt::Windows::Graphics::Capture::GraphicsCaptureItem CreateCaptureItem(
    HWND window) {
  using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
  auto interop = winrt::get_activation_factory<GraphicsCaptureItem,
                                                IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  Check(interop->CreateForWindow(window, winrt::guid_of<GraphicsCaptureItem>(),
                                 winrt::put_abi(item)),
        "capture-item-window");
  return item;
}

winrt::Windows::Graphics::Capture::GraphicsCaptureItem CreateCaptureItem(
    HMONITOR monitor) {
  using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
  auto interop = winrt::get_activation_factory<GraphicsCaptureItem,
                                                IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  Check(interop->CreateForMonitor(monitor, winrt::guid_of<GraphicsCaptureItem>(),
                                  winrt::put_abi(item)),
        "capture-item-display");
  return item;
}

ComPtr<ID3D11Texture2D> CaptureTexture(
    const winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame& frame) {
  auto access = frame.Surface().as<
      ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  ComPtr<ID3D11Texture2D> texture;
  Check(access->GetInterface(IID_PPV_ARGS(&texture)),
        "capture-frame-texture");
  return texture;
}

std::string JSONString(const std::string& value) {
  std::string output = "\"";
  for (unsigned char character : value) {
    if (character == '\\' || character == '"') {
      output.push_back('\\');
      output.push_back(static_cast<char>(character));
    } else if (character >= 0x20 && character <= 0x7e) {
      output.push_back(static_cast<char>(character));
    } else {
      output.push_back('?');
    }
  }
  output.push_back('"');
  return output;
}

class InputReader final {
 public:
  std::vector<piik::capture::InputEnvelope> Read(bool blocking = false) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0;
    if (input == INVALID_HANDLE_VALUE || input == nullptr) return {};
    if (!blocking && !PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) return End();
      Check(HRESULT_FROM_WIN32(GetLastError()), "capture-control-peek");
    }
    if (!blocking && available == 0) return {};
    std::array<char, 32 * 1024> bytes{};
    DWORD read = 0;
    if (!ReadFile(input, bytes.data(),
                  blocking ? static_cast<DWORD>(bytes.size()) : std::min<DWORD>(available, static_cast<DWORD>(bytes.size())),
                  &read, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) return End();
      Check(HRESULT_FROM_WIN32(GetLastError()), "capture-control-read");
    }
    return envelopes_.Feed(std::string_view(bytes.data(), read));
  }

 private:
  std::vector<piik::capture::InputEnvelope> End() {
    if (!envelopes_.Empty()) Fail("capture-input-eof", "native input ended within an envelope");
    piik::capture::InputEnvelope stop;
    stop.kind = 7;
    stop.data = {'Q'};
    return {std::move(stop)};
  }
  piik::capture::InputEnvelopes envelopes_;
};

class ControlReader final {
 public:
  std::vector<piik::capture::CaptureControl> Read() {
    std::vector<piik::capture::CaptureControl> controls;
    for (const auto& envelope : input_.Read()) controls.push_back(envelope.Control());
    return controls;
  }

 private:
  InputReader input_;
};

UINT64 ParseUint64(const wchar_t* value, const std::string& stage) {
  try {
    size_t consumed = 0;
    unsigned long long parsed = std::stoull(value, &consumed, 10);
    if (value[consumed] != L'\0' || parsed == 0) {
      Fail(stage, "value is not a positive bounded integer");
    }
    return static_cast<UINT64>(parsed);
  } catch (const std::exception&) {
    Fail(stage, "value is not a positive bounded integer");
  }
}

UINT64 ParseNonNegativeUint64(const wchar_t* value, const std::string& stage) {
  try {
    size_t consumed = 0;
    unsigned long long parsed = std::stoull(value, &consumed, 10);
    if (value[consumed] != L'\0') {
      Fail(stage, "value is not a bounded integer");
    }
    return static_cast<UINT64>(parsed);
  } catch (const std::exception&) {
    Fail(stage, "value is not a bounded integer");
  }
}

piik::capture::TargetKind ParseTargetKind(const wchar_t* value) {
  const std::wstring kind(value);
  if (kind == L"window") return piik::capture::TargetKind::window;
  if (kind == L"display") return piik::capture::TargetKind::display;
  Fail("argument-target-kind", "capture target kind is unsupported");
}

struct ProductArguments final {
  enum class Mode { list, probe, preview, audio, video, encoded } mode = Mode::list;
  piik::capture::TargetKind target_kind =
      piik::capture::TargetKind::window;
  DWORD pid = 0;
  UINT64 creation_time = 0;
  UINT64 source_id = 0;
  UINT adapter_index = 0;
  UINT mft_index = 0;
  std::string codec = "auto";
  VideoProfile profile;
  std::vector<VideoProfile> outputs;
};

DegradationPreference ParseDegradationPreference(const wchar_t* value) {
  const std::wstring preference(value);
  if (preference == L"maintain-resolution") {
    return DegradationPreference::resolution;
  }
  if (preference == L"balanced") return DegradationPreference::balanced;
  if (preference == L"maintain-framerate") {
    return DegradationPreference::framerate;
  }
  Fail("argument-preference", "degradation preference is invalid");
}

void ValidateVideoProfile(const VideoProfile& profile) {
  const bool valid_resolution =
      (profile.width == 854 && profile.height == 480) ||
      (profile.width == 1280 && profile.height == 720) ||
      (profile.width == 1920 && profile.height == 1080) ||
      (profile.width == 2560 && profile.height == 1440);
  if (!valid_resolution || profile.frame_rate < 15 || profile.frame_rate > 60 ||
      profile.bit_rate < 2'000'000 || profile.bit_rate > 12'000'000) {
    Fail("argument-profile", "video profile is outside the product bounds");
  }
}

void ParseOutputProfiles(ProductArguments& arguments, int first, int count, wchar_t** values) {
  for (int index = first; index < count; index += 5) {
    if (std::wstring(values[index]) != L"--output") Fail("argument-output", "output profile is missing");
    VideoProfile output = arguments.profile;
    output.width = ParseIndex(values[index + 1], "argument-output-width");
    output.height = ParseIndex(values[index + 2], "argument-output-height");
    output.frame_rate = ParseIndex(values[index + 3], "argument-output-fps");
    output.bit_rate = ParseIndex(values[index + 4], "argument-output-bitrate");
    if (output.width < 2 || output.height < 2 || (output.width & 1) || (output.height & 1) ||
        output.width > 2560 || output.height > 1440 || output.frame_rate == 0 ||
        output.frame_rate > 60 || output.bit_rate < 1'000 || output.bit_rate > 12'000'000) {
      Fail("argument-output", "output profile exceeds codec bounds");
    }
    if (arguments.mode == ProductArguments::Mode::video &&
        (output.width > arguments.profile.width || output.height > arguments.profile.height ||
         output.frame_rate > arguments.profile.frame_rate || output.bit_rate > arguments.profile.bit_rate)) {
      Fail("argument-output", "output profile exceeds source bounds");
    }
    arguments.outputs.push_back(output);
  }
}

ProductArguments ParseProductArguments(int count, wchar_t** values) {
  ProductArguments arguments;
  if (count == 2 && std::wstring(values[1]) == L"--list") return arguments;
  if (count == 2 && std::wstring(values[1]) == L"--probe") {
    arguments.mode = ProductArguments::Mode::probe;
    return arguments;
  }
  if (count == 6 && std::wstring(values[1]) == L"--preview") {
    arguments.mode = ProductArguments::Mode::preview;
    arguments.target_kind = ParseTargetKind(values[2]);
    arguments.source_id = ParseUint64(values[3], "argument-source");
    UINT64 pid = ParseNonNegativeUint64(values[4], "argument-pid");
    if (pid > std::numeric_limits<DWORD>::max()) {
      Fail("argument-pid", "PID is outside the Windows process range");
    }
    arguments.pid = static_cast<DWORD>(pid);
    arguments.creation_time =
        ParseNonNegativeUint64(values[5], "argument-creation-time");
    return arguments;
  }
  if (count == 5 && std::wstring(values[1]) == L"--capture-audio") {
    arguments.mode = ProductArguments::Mode::audio;
    arguments.target_kind = ParseTargetKind(values[2]);
  } else if (count >= 16 && count <= 11 + 5 * piik::capture::kMaxOutputs && (count - 11) % 5 == 0 &&
             std::wstring(values[1]) == L"--encoded-video" &&
             std::wstring(values[2]) == L"--codec" &&
             std::wstring(values[4]) == L"--adapter-index" &&
             std::wstring(values[6]) == L"--mft-index" &&
             std::wstring(values[8]) == L"--preference" &&
             std::wstring(values[10]) == L"--protocol-v7") {
    arguments.mode = ProductArguments::Mode::encoded;
    arguments.codec = NarrowAscii(values[3]);
    if (arguments.codec != "h264" && arguments.codec != "vp8") Fail("argument-codec", "encoded input codec is unsupported");
    arguments.adapter_index = ParseIndex(values[5], "argument-adapter");
    arguments.mft_index = ParseIndex(values[7], "argument-mft");
    arguments.profile.preference = ParseDegradationPreference(values[9]);
    ParseOutputProfiles(arguments, 11, count, values);
    arguments.profile = arguments.outputs.front();
    for (const auto& output : arguments.outputs) {
      arguments.profile.width = std::max(arguments.profile.width, output.width);
      arguments.profile.height = std::max(arguments.profile.height, output.height);
      arguments.profile.frame_rate = std::max(arguments.profile.frame_rate, output.frame_rate);
      arguments.profile.bit_rate = std::max(arguments.profile.bit_rate, output.bit_rate);
    }
    return arguments;
  } else if (count >= 28 && count <= 23 + 5 * piik::capture::kMaxOutputs && (count - 23) % 5 == 0 &&
             std::wstring(values[1]) == L"--capture-video" &&
             std::wstring(values[6]) == L"--adapter-index" &&
             std::wstring(values[8]) == L"--mft-index" &&
             std::wstring(values[10]) == L"--width" &&
             std::wstring(values[12]) == L"--height" &&
             std::wstring(values[14]) == L"--fps" &&
             std::wstring(values[16]) == L"--bitrate" &&
             std::wstring(values[18]) == L"--preference" &&
             std::wstring(values[20]) == L"--codec" &&
             std::wstring(values[22]) == L"--protocol-v7") {
    arguments.mode = ProductArguments::Mode::video;
    arguments.target_kind = ParseTargetKind(values[2]);
    arguments.source_id = ParseUint64(values[3], "argument-source");
    arguments.adapter_index = ParseIndex(values[7], "argument-adapter");
    arguments.mft_index = ParseIndex(values[9], "argument-mft");
    arguments.profile.width = ParseIndex(values[11], "argument-width");
    arguments.profile.height = ParseIndex(values[13], "argument-height");
    arguments.profile.frame_rate = ParseIndex(values[15], "argument-fps");
    arguments.profile.bit_rate = ParseIndex(values[17], "argument-bitrate");
    arguments.profile.preference = ParseDegradationPreference(values[19]);
    const std::wstring codec(values[21]);
    if (codec != L"auto" && codec != L"h264" && codec != L"vp8") {
      Fail("argument-codec", "video codec is unsupported");
    }
    arguments.codec = NarrowAscii(codec);
    ValidateVideoProfile(arguments.profile);
    ParseOutputProfiles(arguments, 23, count, values);
    const auto& original = arguments.outputs[arguments.outputs.size() > 1 ? 1 : 0];
    if (original.width != arguments.profile.width || original.height != arguments.profile.height ||
        original.frame_rate != arguments.profile.frame_rate || original.bit_rate != arguments.profile.bit_rate) {
      Fail("argument-output-source", "original output must match the source profile");
    }
  } else {
    Fail("arguments", "unsupported or incomplete command-line argument");
  }
  const int pid_index = arguments.mode == ProductArguments::Mode::audio ? 3 : 4;
  const int creation_index = pid_index + 1;
  UINT64 pid = ParseNonNegativeUint64(values[pid_index], "argument-pid");
  if (pid > std::numeric_limits<DWORD>::max()) {
    Fail("argument-pid", "PID is outside the Windows process range");
  }
  arguments.pid = static_cast<DWORD>(pid);
  arguments.creation_time =
      ParseNonNegativeUint64(values[creation_index], "argument-creation-time");
  if (arguments.target_kind == piik::capture::TargetKind::window &&
      (arguments.pid == 0 || arguments.creation_time == 0)) {
    Fail("argument-window-identity", "window identity is incomplete");
  }
  if (arguments.target_kind == piik::capture::TargetKind::display &&
      (arguments.pid != 0 || arguments.creation_time != 0)) {
    Fail("argument-display-identity", "display identity is invalid");
  }
  return arguments;
}

HRESULT RunAudioCapture(const ProductArguments& arguments) {
  UniqueHandle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (stop.get() == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  ProtocolWriter writer;
  ControlReader controls;
  auto should_stop = [&]() {
    const auto commands = controls.Read();
    if (commands.empty()) return false;
    if (commands.front().kind != 'Q') Fail("audio-control", "audio process only accepts stop");
    return true;
  };
  auto ready = [&writer]() {
    return writer.WriteStatus("{\"state\":\"active\",\"audio\":true}");
  };
  auto pcm = [&writer](UINT64 timestamp100ns, const BYTE* data, DWORD size) {
    return writer.Write(OutputKind::pcm, 0, timestamp100ns,
                        piik::capture::kAudioChunkDuration100ns, data,
                        size);
  };
  if (arguments.target_kind == piik::capture::TargetKind::display) {
    return piik::capture::CaptureSystemAudio(
        stop.get(), should_stop, ready, pcm);
  }
  return piik::capture::CaptureProcessAudio(
      arguments.pid, arguments.creation_time, stop.get(),
      should_stop,
      ready, pcm);
}

UINT32 WindowsBuild() {
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (module == nullptr) {
    Fail("windows-version", "ntdll.dll is unavailable");
  }
  using RtlGetVersionFunction = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto get_version = reinterpret_cast<RtlGetVersionFunction>(
      GetProcAddress(module, "RtlGetVersion"));
  if (get_version == nullptr) {
    Fail("windows-version", "RtlGetVersion is unavailable");
  }
  RTL_OSVERSIONINFOW version = {};
  version.dwOSVersionInfoSize = sizeof(version);
  if (get_version(&version) < 0 || version.dwMajorVersion != 10) {
    Fail("windows-version", "unsupported Windows version");
  }
  return version.dwBuildNumber;
}

void WriteCapabilityProbe() {
  constexpr UINT32 kCreateForWindowMinimumBuild = 18'362;
  constexpr UINT32 kProcessLoopbackMinimumBuild = 19'041;
  const UINT32 build = WindowsBuild();
  bool window_capture = false;
  if (build >= kCreateForWindowMinimumBuild) {
    try {
      window_capture =
          winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported();
    } catch (const winrt::hresult_error&) {
      window_capture = false;
    }
  }
  const bool process_audio =
      build >= kProcessLoopbackMinimumBuild &&
      piik::capture::ProcessAudioAvailable();
  const bool system_audio = piik::capture::SystemAudioAvailable();

  std::vector<Adapter> adapters = EnumerateAdapters();
  std::ostringstream output;
  output << "{\"protocol\":7,\"platform\":\"windows\",\"platformBuild\":"
         << JSONString(std::to_string(build))
         << ",\"videoCapture\":" << (window_capture ? "true" : "false")
         << ",\"softwareVP8\":true"
         << ",\"processAudio\":"
         << (process_audio ? "true" : "false")
         << ",\"systemAudio\":" << (system_audio ? "true" : "false")
         << ",\"adapters\":[";
  for (size_t adapter_index = 0; adapter_index < adapters.size();
       ++adapter_index) {
    if (adapter_index != 0) output << ',';
    const Adapter& adapter = adapters[adapter_index];
    ActivationList encoders = EnumerateHardwareEncoders(adapter, false);
    output << "{\"index\":" << adapter.index << ",\"name\":"
           << JSONString(NarrowAscii(adapter.description.Description))
           << ",\"identity\":"
           << JSONString(LuidString(adapter.description.AdapterLuid))
           << ",\"hardwareH264\":[";
    for (UINT32 encoder_index = 0; encoder_index < encoders.count;
         ++encoder_index) {
      if (encoder_index != 0) output << ',';
      IMFActivate* encoder = encoders.values[encoder_index];
      std::wstring name =
          GetOptionalString(encoder, MFT_FRIENDLY_NAME_Attribute);
      GUID clsid = {};
      Check(encoder->GetGUID(MFT_TRANSFORM_CLSID_Attribute, &clsid),
            "mft-probe-clsid");
      output << "{\"index\":" << encoder_index << ",\"name\":"
             << JSONString(NarrowAscii(name)) << ",\"identity\":"
             << JSONString(GuidString(clsid)) << '}';
    }
    output << "]}";
  }
  output << "]}";
  std::cout << output.str();
  if (!std::cout.good()) {
    Fail("capability-output", "could not write the capability result");
  }
}

double MeasureEncoderWork(VideoEncoder* hardware, ID3D11Device* device,
                          const VideoProfile& profile,
                          EncoderClock::time_point deadline) {
  const UINT32 warmup_frames = (profile.frame_rate + 1) / 2;
  const UINT32 sample_frames = profile.frame_rate;
  std::unique_ptr<AdaptiveEncoder> adaptive;
  if (!hardware) {
    adaptive = std::make_unique<AdaptiveEncoder>(OutputKind::vp8, profile, device,
                                               AdaptiveEncoder::Factory{});
  }
  const auto cadence_start = EncoderClock::now();
  std::chrono::duration<double> measured{};
  for (UINT32 frame = 0; frame < warmup_frames + sample_frames; ++frame) {
    RequireEncoderTime(deadline);
    auto texture = CreateSyntheticTexture(device, frame, profile);
    if (adaptive) {
      // VSE observes real input cadence; pacing is not encoder work.
      std::this_thread::sleep_until(cadence_start + std::chrono::nanoseconds(
          static_cast<INT64>(frame) * profile.frame_duration_100ns() * 100));
      RequireEncoderTime(deadline);
    }
    const auto start = EncoderClock::now();
    const auto timestamp = (static_cast<UINT64>(frame) + 1) * profile.frame_duration_100ns();
    EncodedAccessUnit encoded;
    if (adaptive) {
      auto output = adaptive->Encode([&](UINT32 width, UINT32 height) {
        if (width != profile.width || height != profile.height)
          Fail("codec-probe-output", "encoder reduced the probe resolution");
        return texture;
      }, profile.width, profile.height, timestamp, frame == 0, profile.bit_rate);
      RequireEncoderTime(deadline);
      if (!output || output->width != profile.width || output->height != profile.height ||
          output->duration100ns != static_cast<UINT64>(profile.frame_duration_100ns())) {
        Fail("codec-probe-output", "encoder reduced the probe profile or dropped a frame");
      }
      encoded = std::move(output->access_unit);
    } else {
      encoded = hardware->Encode(texture.Get(), timestamp, frame == 0, deadline);
    }
    // A dropped input cannot count as a throughput-probe output frame.
    if (encoded.bytes.empty() || encoded.bytes.size() > kMaxProductAccessUnitBytes) {
      Fail("codec-probe-output", "encoder produced an invalid probe frame");
    }
    if (frame >= warmup_frames) measured += EncoderClock::now() - start;
  }
  return measured.count() / sample_frames;
}

struct VideoEncoderSelection final {
  OutputKind kind = OutputKind::vp8;
  std::unique_ptr<VideoEncoder> initial;
};

VideoEncoderSelection SelectVideoEncoder(
    const ProductArguments& arguments, const Adapter& adapter,
    const DeviceContext& device) {
  const auto create = [&]() -> std::unique_ptr<VideoEncoder> {
    ActivationList activations = EnumerateHardwareEncoders(adapter);
    auto selected = ActivateTransform(activations, arguments.mft_index, device.manager.Get());
    return std::make_unique<LiveEncoder>(std::move(selected), arguments.profile);
  };
  if (arguments.codec == "vp8") return {};
  if (arguments.codec == "h264") return {OutputKind::h264, create()};

  const auto began = EncoderClock::now();
  const auto budget = std::chrono::seconds(4);
  const auto deadline = began + budget;
  std::optional<double> hardware_work;
  try {
    auto hardware = create();
    hardware_work = MeasureEncoderWork(hardware.get(), device.device.Get(),
                                      arguments.profile, began + budget / 2);
    if (*hardware_work <= 1.0 / arguments.profile.frame_rate)
      return {OutputKind::h264, std::move(hardware)};
  } catch (const std::exception&) {
    // No media has been published; a failed hardware probe may try software.
  }
  RequireEncoderTime(deadline);
  try {
    const double software_work = MeasureEncoderWork(nullptr, device.device.Get(),
                                                    arguments.profile, deadline);
    if (!hardware_work || software_work <= *hardware_work) return {};
  } catch (const std::exception&) {
    if (!hardware_work) throw;
  }
  RequireEncoderTime(deadline);
  auto hardware = create();
  RequireEncoderTime(deadline);
  return {OutputKind::h264, std::move(hardware)};
}

struct CaptureInput final {
  ComPtr<ID3D11Texture2D> texture;
  UINT32 width = 0;
  UINT32 height = 0;
  SIZE presentation{};
  UINT64 timestamp = 0;
};

class OutputWorker final {
 public:
  using Factory = AdaptiveEncoder::Factory;
  OutputWorker(UINT8 layer, VideoProfile profile, OutputKind kind, ID3D11Device* device,
               ProtocolWriter& writer, Factory create,
               std::unique_ptr<VideoEncoder> initial, bool active,
               std::function<void()> on_output,
               std::function<void(std::exception_ptr)> on_failure)
      : layer_(layer), profile_(profile), kind_(kind), device_(device), writer_(writer),
        create_(std::move(create)), initial_(std::move(initial)),
        on_output_(std::move(on_output)), on_failure_(std::move(on_failure)),
        mailbox_(profile.bit_rate, active), thread_([this]() { Run(); }) {}

  ~OutputWorker() { Stop(); Join(); }

  void Submit(std::shared_ptr<const CaptureInput> input) {
    mailbox_.Submit(std::move(input));
  }

  bool SetActive(bool active) { return mailbox_.SetActive(active); }
  void RequestKeyFrame() { mailbox_.RequestKeyFrame(); }
  void SetBitrate(UINT32 bitrate) { mailbox_.SetBitrate(bitrate); }

  void Stop() {
    mailbox_.Stop();
    if (thread_.joinable()) CancelSynchronousIo(thread_.native_handle());
  }

  void Join() {
    if (!thread_.joinable()) return;
    // Keep cancellation effective if a retiring worker was about to enter WriteFile.
    const DWORD interval = std::max<DWORD>(1, 1000 / profile_.frame_rate);
    while (WaitForSingleObject(thread_.native_handle(), interval) == WAIT_TIMEOUT) {
      CancelSynchronousIo(thread_.native_handle());
    }
    thread_.join();
  }

 private:
  void Run() noexcept {
    bool apartment = false;
    bool recovery = false;
    auto initial = std::move(initial_);
    std::unique_ptr<AdaptiveEncoder> encoder;
    std::unique_ptr<FrameConverter> converter;
    try {
      Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "output-com-apartment");
      apartment = true;
      UINT64 codec_generation = 0;
      UINT32 converted_width = 0, converted_height = 0;
      for (;;) {
        const auto work = mailbox_.Take();
        if (work.action == Mailbox::Action::stop) break;
        if (work.action == Mailbox::Action::retire) {
          encoder.reset();
          initial.reset();
          converter.reset();
          continue;
        }
        const auto& input = work.input;
        recovery = work.recovery;
        if (codec_generation != work.generation) {
          encoder.reset();
          initial.reset();
          converter.reset();
          codec_generation = work.generation;
        }
        if (!encoder) {
          encoder = std::make_unique<AdaptiveEncoder>(
              kind_, profile_, device_.Get(), create_, std::move(initial), layer_);
        }
        auto output = encoder->Encode([&](UINT32 width, UINT32 height) {
          if (!converter || converted_width != width || converted_height != height) {
            auto selected = profile_;
            selected.width = width;
            selected.height = height;
            converter = std::make_unique<FrameConverter>(device_.Get(), selected);
            converted_width = width;
            converted_height = height;
          }
          return converter->Convert(input->texture.Get(), input->width,
                                    input->height, input->presentation);
        }, profile_.width, profile_.height, input->timestamp, recovery, work.bitrate);
        if (!output) continue;
        if (!mailbox_.Accept(work.generation)) continue;
        const auto& access_unit = output->access_unit;
        Check(writer_.Write(kind_, access_unit.key_frame ? 1 : 0,
                             access_unit.timestamp100ns, output->duration100ns,
                             access_unit.bytes.data(), static_cast<DWORD>(access_unit.bytes.size()),
                             layer_, static_cast<UINT16>(output->width),
                             static_cast<UINT16>(output->height)), "capture-video-output");
        if (on_output_) on_output_();
      }
    } catch (...) {
      if (mailbox_.Fail(recovery)) on_failure_(std::current_exception());
    }
    encoder.reset();
    initial.reset();
    converter.reset();
    if (apartment) CoUninitialize();
  }

  const UINT8 layer_;
  const VideoProfile profile_;
  const OutputKind kind_;
  ComPtr<ID3D11Device> device_;
  ProtocolWriter& writer_;
  Factory create_;
  std::unique_ptr<VideoEncoder> initial_;
  std::function<void()> on_output_;
  std::function<void(std::exception_ptr)> on_failure_;
  using Mailbox = piik::capture::OutputMailbox<CaptureInput>;
  Mailbox mailbox_;
  std::thread thread_;
};

void AppendOutputProfiles(std::ostream& output, const std::vector<VideoProfile>& profiles) {
  output << ",\"outputs\":[";
  for (size_t index = 0; index < profiles.size(); ++index) {
    if (index != 0) output << ',';
    const auto& profile = profiles[index];
    output << "{\"width\":" << profile.width << ",\"height\":" << profile.height
           << ",\"fps\":" << profile.frame_rate << ",\"bitrate\":" << profile.bit_rate << '}';
  }
  output << ']';
}

void WriteVideoStarting(ProtocolWriter& writer, const ProductArguments& arguments,
                        const Adapter& adapter, const VideoEncoderSelection& encoder) {
  const bool hardware = encoder.kind == OutputKind::h264;
  std::ostringstream status;
  status << "{\"state\":\"starting\",\"hardwareOnly\":" << (hardware ? "true" : "false")
         << ",\"codec\":" << JSONString(hardware ? "h264" : "vp8")
         << ",\"adapterIndex\":" << adapter.index
         << ",\"adapterName\":" << JSONString(NarrowAscii(adapter.description.Description))
         << ",\"adapterIdentity\":" << JSONString(LuidString(adapter.description.AdapterLuid))
         << ",\"encoderName\":" << JSONString(hardware ? encoder.initial->name : "libvpx VP8")
         << ",\"encoderIdentity\":" << JSONString(hardware ? encoder.initial->identity :
              std::string("libvpx/") + vpx_codec_version_str());
  if (hardware) status << ",\"encoderIndex\":" << arguments.mft_index;
  AppendOutputProfiles(status, arguments.outputs);
  status << '}';
  Check(writer.WriteStatus(status.str()), "capture-status-starting");
}

void WriteVideoActive(ProtocolWriter& writer, const ProductArguments& arguments, bool hardware) {
  std::ostringstream status;
  status << "{\"state\":\"active\",\"hardwareOnly\":" << (hardware ? "true" : "false")
         << ",\"codec\":" << JSONString(hardware ? "h264" : "vp8");
  if (hardware) status << ",\"profileLevelId\":" << JSONString(arguments.profile.profile_level_id());
  status << ",\"width\":" << arguments.profile.width << ",\"height\":" << arguments.profile.height
         << ",\"fps\":" << arguments.profile.frame_rate;
  AppendOutputProfiles(status, arguments.outputs);
  status << '}';
  Check(writer.WriteStatus(status.str()), "capture-status-active");
}

std::vector<std::unique_ptr<OutputWorker>> CreateOutputWorkers(
    const ProductArguments& arguments, const Adapter& adapter, const DeviceContext& device,
    ProtocolWriter& writer, VideoEncoderSelection encoder,
    const std::function<void()>& on_active,
    const std::function<void(size_t, std::exception_ptr)>& on_failure) {
  const bool hardware = encoder.kind == OutputKind::h264;
  const UINT encoder_index = arguments.mft_index;
  const bool capture = arguments.mode == ProductArguments::Mode::video;
  const size_t original_layer = capture && arguments.outputs.size() > 1 ? 1 : 0;
  std::vector<std::unique_ptr<OutputWorker>> workers;
  for (size_t layer = 0; layer < arguments.outputs.size(); ++layer) {
    const auto profile = arguments.outputs[layer];
    const bool original = layer == original_layer;
    AdaptiveEncoder::Factory create;
    if (hardware) {
      create = [&adapter, &device, encoder_index](const VideoProfile& selected_profile) -> std::unique_ptr<VideoEncoder> {
        auto activations = EnumerateHardwareEncoders(adapter);
        auto selected = ActivateTransform(activations, encoder_index, device.manager.Get());
        return std::make_unique<LiveEncoder>(std::move(selected), selected_profile);
      };
    }
    workers.push_back(std::make_unique<OutputWorker>(
        static_cast<UINT8>(layer), profile, encoder.kind, device.device.Get(), writer,
        std::move(create), original ? std::move(encoder.initial) : nullptr, capture && layer < 2,
        [original, on_active]() { if (original) on_active(); },
        [layer, on_failure](std::exception_ptr error) { on_failure(layer, error); }));
  }
  return workers;
}

std::string OutputFailureDetail(std::exception_ptr error) {
  try {
    std::rethrow_exception(error);
  } catch (const GateFailure& failed) {
    return failed.stage();
  } catch (const std::exception& failed) {
    return failed.what();
  } catch (...) {
    return "Output encoder is unavailable";
  }
}

bool ApplyOutputControl(const piik::capture::CaptureControl& control,
                        const std::vector<std::unique_ptr<OutputWorker>>& workers) {
  if (control.layer >= static_cast<int>(workers.size())) Fail("control-layer", "output layer is unavailable");
  if (control.kind == 'A') {
    return workers[control.layer]->SetActive(control.value != 0);
  } else if (control.kind == 'K') {
    for (size_t layer = 0; layer < workers.size(); ++layer) {
      if (control.layer == -1 || static_cast<size_t>(control.layer) == layer) workers[layer]->RequestKeyFrame();
    }
  } else if (control.kind == 'B') {
    workers[control.layer]->SetBitrate(control.value);
  }
  return false;
}

ComPtr<ID3D11Texture2D> UploadDecodedNV12(const DeviceContext& device,
                                        const BYTE* data, UINT32 width, UINT32 height) {
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = description.ArraySize = 1;
  description.Format = DXGI_FORMAT_NV12;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  D3D11_SUBRESOURCE_DATA input{};
  input.pSysMem = data;
  input.SysMemPitch = width;
  input.SysMemSlicePitch = width * height * 3 / 2;
  ComPtr<ID3D11Texture2D> texture;
  Check(device.device->CreateTexture2D(&description, &input, &texture), "decoded-input-upload");
  return texture;
}

ComPtr<ID3D11Texture2D> OwnDecodedTexture(const DeviceContext& device, IMFSample* sample,
                                         UINT32 width, UINT32 height, LONG stride) {
  ComPtr<IMFMediaBuffer> buffer;
  Check(sample->GetBufferByIndex(0, &buffer), "decoded-buffer");
  ComPtr<IMFDXGIBuffer> dxgi;
  if (SUCCEEDED(buffer.As(&dxgi))) {
    ComPtr<ID3D11Texture2D> original;
    UINT subresource = 0;
    Check(dxgi->GetResource(IID_PPV_ARGS(&original)), "decoded-dxgi-resource");
    Check(dxgi->GetSubresourceIndex(&subresource), "decoded-dxgi-subresource");
    D3D11_TEXTURE2D_DESC description{};
    original->GetDesc(&description);
    if (description.Format != DXGI_FORMAT_NV12 || description.Width < width || description.Height < height ||
        description.Width > 2560 || description.Height > 1440) Fail("decoded-texture-size", "decoder texture exceeds source bounds");
    description.ArraySize = description.MipLevels = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.CPUAccessFlags = description.MiscFlags = 0;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    ComPtr<ID3D11Texture2D> owned;
    Check(device.device->CreateTexture2D(&description, nullptr, &owned), "decoded-owned-texture");
    device.context->CopySubresourceRegion(owned.Get(), 0, 0, 0, 0, original.Get(), subresource, nullptr);
    return owned;
  }
  const DWORD size = width * height * 3 / 2;
  std::vector<BYTE> pixels(size);
  ComPtr<IMF2DBuffer> planar;
  if (SUCCEEDED(buffer.As(&planar))) {
    DWORD length = 0;
    Check(planar->GetContiguousLength(&length), "decoded-contiguous-length");
    if (length != size) Fail("decoded-contiguous-size", "NV12 output does not match its dimensions");
    Check(planar->ContiguousCopyTo(pixels.data(), size), "decoded-contiguous-copy");
  } else {
    BYTE* data = nullptr;
    DWORD length = 0;
    Check(buffer->Lock(&data, nullptr, &length), "decoded-memory-lock");
    const bool valid = stride >= static_cast<LONG>(width) &&
        static_cast<UINT64>(stride) * height * 3 / 2 <= length;
    if (valid) {
      for (UINT32 row = 0; row < height * 3 / 2; ++row) {
        std::copy_n(data + static_cast<size_t>(row) * stride, width, pixels.data() + static_cast<size_t>(row) * width);
      }
    }
    Check(buffer->Unlock(), "decoded-memory-unlock");
    if (!valid) Fail("decoded-memory-size", "NV12 output buffer is incomplete");
  }
  return UploadDecodedNV12(device, pixels.data(), width, height);
}

void RunEncodedVideo(const ProductArguments& arguments) {
  auto adapters = EnumerateAdapters();
  const auto& adapter = SelectAdapter(adapters, arguments.adapter_index);
  const auto device = CreateDevice(adapter);
  auto encoder = SelectVideoEncoder(arguments, adapter, device);
  const bool hardware = arguments.codec == "h264";
  ProtocolWriter writer;
  WriteVideoStarting(writer, arguments, adapter, encoder);
  HANDLE input_thread_handle = nullptr;
  Check(DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(),
                         &input_thread_handle, 0, FALSE, DUPLICATE_SAME_ACCESS), "encoded-input-thread");
  UniqueHandle input_thread(input_thread_handle);
  std::atomic<bool> active{false};
  std::atomic<size_t> failed{0};
  auto workers = CreateOutputWorkers(arguments, adapter, device, writer, std::move(encoder),
      [&]() { if (!active.exchange(true)) WriteVideoActive(writer, arguments, hardware); },
      [&](size_t layer, std::exception_ptr error) {
        (void)writer.WriteUnavailable(static_cast<UINT8>(layer), OutputFailureDetail(error));
        if (failed.fetch_add(1) + 1 == arguments.outputs.size()) CancelSynchronousIo(input_thread.get());
      });
  auto cleanup = [&]() {
    writer.Stop();
    for (auto& worker : workers) worker->Stop();
    for (auto& worker : workers) worker->Join();
  };
  try {
    std::unique_ptr<piik::capture::H264Decoder> h264;
    std::unique_ptr<piik::capture::Vp8Decoder> vp8;
    if (hardware) h264 = std::make_unique<piik::capture::H264Decoder>(device.manager.Get());
    else vp8 = std::make_unique<piik::capture::Vp8Decoder>();
    InputReader reader;
    bool began = false;
    UINT64 last_timestamp = 0;
    auto submit = [&](ComPtr<ID3D11Texture2D> texture, UINT32 width, UINT32 height,
                      UINT64 timestamp, UINT64 duration) {
      if ((began && timestamp <= last_timestamp) || width < arguments.profile.width || height < arguments.profile.height) {
        Fail("encoded-input-output", "decoded frame changed the source timeline or output bounds");
      }
      auto input = std::make_shared<CaptureInput>();
      input->texture = std::move(texture);
      input->width = width;
      input->height = height;
      input->presentation = {static_cast<LONG>(width), static_cast<LONG>(height)};
      input->timestamp = timestamp;
      Check(writer.WriteBegin(timestamp, duration), "decoded-frame-begin");
      for (auto& worker : workers) worker->Submit(input);
      began = true;
      last_timestamp = timestamp;
    };
    for (;;) {
      if (failed.load() == workers.size()) Fail("encoded-outputs", "all derived outputs are unavailable");
      for (const auto& input : reader.Read(true)) {
        if (input.kind == 7) {
          const auto control = input.Control();
          if (control.kind == 'Q') { cleanup(); return; }
          ApplyOutputControl(control, workers);
          continue;
        }
        if (input.kind != (hardware ? 2 : 4)) Fail("encoded-input-codec", "encoded source codec changed");
        if (h264) {
          h264->Decode(input, [&](IMFSample* sample, UINT32 width, UINT32 height, LONG stride) {
            LONGLONG timestamp = -1, duration = 0;
            Check(sample->GetSampleTime(&timestamp), "decoded-timestamp");
            Check(sample->GetSampleDuration(&duration), "decoded-duration");
            if (timestamp < 0 || duration <= 0) Fail("decoded-timing", "decoder did not preserve source timing");
            submit(OwnDecodedTexture(device, sample, width, height, stride), width, height,
                   static_cast<UINT64>(timestamp), static_cast<UINT64>(duration));
          });
        } else {
          const auto decoded = vp8->Decode(input.data);
          if (!decoded.nv12.empty()) submit(UploadDecodedNV12(device, decoded.nv12.data(), decoded.width, decoded.height),
              decoded.width, decoded.height, input.timestamp, input.duration);
        }
      }
    }
  } catch (...) {
    cleanup();
    throw;
  }
}

void RunVideoCapture(const ProductArguments& arguments) {
  const bool window_target =
      arguments.target_kind == piik::capture::TargetKind::window;
  HRESULT identity = window_target
                         ? piik::capture::ValidateWindowTarget(
                               arguments.source_id, arguments.pid,
                               arguments.creation_time)
                         : piik::capture::ValidateDisplayTarget(
                               arguments.source_id);
  Check(identity, "target-identity");

  std::vector<Adapter> adapters = EnumerateAdapters();
  const Adapter& adapter = SelectAdapter(adapters, arguments.adapter_index);
  DeviceContext device = CreateDevice(adapter);
  auto encoder = SelectVideoEncoder(arguments, adapter, device);
  const bool hardware = encoder.kind == OutputKind::h264;
  piik::capture::CapturePresentation presentation(arguments.target_kind,
                                                      arguments.source_id);
  ProtocolWriter writer;

  using namespace winrt::Windows::Graphics::Capture;
  using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
  if (!GraphicsCaptureSession::IsSupported()) {
    Fail("capture-support", "Windows Graphics Capture is unavailable");
  }
  UniqueHandle process(window_target
                           ? OpenProcess(SYNCHRONIZE, FALSE, arguments.pid)
                           : nullptr);
  if (window_target && process.get() == nullptr) {
    Check(HRESULT_FROM_WIN32(GetLastError()), "target-process-handle");
  }
  Check(window_target
            ? piik::capture::ValidateWindowTarget(
                  arguments.source_id, arguments.pid, arguments.creation_time)
            : piik::capture::ValidateDisplayTarget(arguments.source_id),
        "target-identity-before-capture");
  auto capture_device = CreateCaptureDevice(device.device.Get());
  GraphicsCaptureItem item = window_target
                                 ? CreateCaptureItem(reinterpret_cast<HWND>(
                                       static_cast<UINT_PTR>(arguments.source_id)))
                                 : CreateCaptureItem(reinterpret_cast<HMONITOR>(
                                       static_cast<UINT_PTR>(arguments.source_id)));
  Check(window_target
            ? piik::capture::ValidateWindowTarget(
                  arguments.source_id, arguments.pid, arguments.creation_time)
            : piik::capture::ValidateDisplayTarget(arguments.source_id),
        "target-identity-after-item");
  auto initial_size = item.Size();
  if (initial_size.Width <= 0 || initial_size.Height <= 0) {
    Fail("capture-size", "selected window has no capturable content");
  }
  Direct3D11CaptureFramePool pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      capture_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2,
      initial_size);
  GraphicsCaptureSession capture_session = pool.CreateCaptureSession(item);
  EnableFastCaptureUpdates(capture_session);

  UniqueHandle shutdown(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  UniqueHandle frame_ready(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (shutdown.get() == nullptr || frame_ready.get() == nullptr) {
    Check(HRESULT_FROM_WIN32(GetLastError()), "capture-events");
  }

  std::atomic<bool> item_closed{false};
  auto frame_token = pool.FrameArrived(
      [event = frame_ready.get()](const Direct3D11CaptureFramePool&,
                                  const winrt::Windows::Foundation::IInspectable&) {
        SetEvent(event);
      });
  auto closed_token = item.Closed(
      [event = shutdown.get(), &item_closed](const GraphicsCaptureItem&,
                                              const winrt::Windows::Foundation::IInspectable&) {
        item_closed.store(true);
        SetEvent(event);
      });
  std::vector<std::unique_ptr<OutputWorker>> workers;
  std::atomic<bool> active_status_written{false};
  std::mutex failure_mutex;
  std::exception_ptr failure;
  auto fail_capture = [&](std::exception_ptr error) {
    {
      std::lock_guard<std::mutex> lock(failure_mutex);
      if (!failure) failure = error;
    }
    SetEvent(shutdown.get());
  };
  auto cleanup = [&]() noexcept {
    SetEvent(shutdown.get());
    writer.Stop();
    for (auto& worker : workers) worker->Stop();
    try {
      pool.FrameArrived(frame_token);
    } catch (...) {
    }
    try {
      item.Closed(closed_token);
    } catch (...) {
    }
    try {
      capture_session.Close();
    } catch (...) {
    }
    try {
      pool.Close();
    } catch (...) {
    }
    for (auto& worker : workers) worker->Join();
  };

  try {
    const UINT64 frame_duration = static_cast<UINT64>(
        arguments.profile.frame_duration_100ns());
    const DWORD control_wait_ms = static_cast<DWORD>((frame_duration + 9'999) / 10'000);
    WriteVideoStarting(writer, arguments, adapter, encoder);
    workers = CreateOutputWorkers(arguments, adapter, device, writer, std::move(encoder),
      [&]() {
        if (!active_status_written.exchange(true)) WriteVideoActive(writer, arguments, hardware);
      },
      [&](size_t layer, std::exception_ptr error) {
        if (layer == (arguments.outputs.size() > 1 ? 1u : 0u)) {
          fail_capture(error);
          return;
        }
        if (FAILED(writer.WriteUnavailable(static_cast<UINT8>(layer), OutputFailureDetail(error)))) fail_capture(error);
      });
    capture_session.StartCapture();

    UINT64 previous_timestamp = 0;
    UINT64 next_output_timestamp = 0;
    UINT64 source_frames = 0;
    auto pool_size = initial_size;
    std::shared_ptr<const CaptureInput> latest_input;
    bool refresh_input = false;
    ControlReader controls;
    auto submit = [&](std::shared_ptr<const CaptureInput> input) {
      Check(writer.WriteBegin(input->timestamp, frame_duration), "capture-frame-begin");
      for (auto& worker : workers) worker->Submit(input);
      previous_timestamp = input->timestamp;
      ++source_frames;
      refresh_input = false;
    };
    const HANDLE window_waits[] = {
        process.get(), shutdown.get(), frame_ready.get()};
    const HANDLE display_waits[] = {shutdown.get(), frame_ready.get()};
    for (;;) {
      for (const auto& control : controls.Read()) {
        if (control.kind == 'Q') {
          cleanup();
          return;
        }
        if (control.kind == 'A') {
          refresh_input = ApplyOutputControl(control, workers) || refresh_input;
          continue;
        }
        ApplyOutputControl(control, workers);
        refresh_input = true;
      }
      DWORD wait = window_target
                       ? WaitForMultipleObjects(3, window_waits, FALSE, control_wait_ms)
                       : WaitForMultipleObjects(2, display_waits, FALSE, control_wait_ms);
      if (window_target && wait == WAIT_OBJECT_0) {
        Fail("target-exited", "selected target process exited");
      }
      const DWORD shutdown_index =
          window_target ? WAIT_OBJECT_0 + 1 : WAIT_OBJECT_0;
      const DWORD frame_index =
          window_target ? WAIT_OBJECT_0 + 2 : WAIT_OBJECT_0 + 1;
      if (wait == shutdown_index) {
        {
          std::lock_guard<std::mutex> lock(failure_mutex);
          if (failure) std::rethrow_exception(failure);
        }
        if (item_closed.load()) {
          Fail("capture-closed", "selected source stopped capture");
        }
        Fail("capture-stopped", "source capture stopped");
      }
      if (wait == WAIT_TIMEOUT) {
        // An explicit output/control request may reuse a quiet source; silence is not EOF.
        if (refresh_input && latest_input) {
          auto input = std::make_shared<CaptureInput>(*latest_input);
          input->timestamp = previous_timestamp + frame_duration;
          submit(input);
        }
        continue;
      }
      if (wait != frame_index) {
        Check(HRESULT_FROM_WIN32(GetLastError()), "capture-wait");
      }

      Direct3D11CaptureFrame latest{nullptr};
      for (;;) {
        Direct3D11CaptureFrame next = pool.TryGetNextFrame();
        if (!next) break;
        latest = std::move(next);
      }
      if (!latest) continue;
      INT64 signed_timestamp = latest.SystemRelativeTime().count();
      if (signed_timestamp <= 0) {
        Fail("capture-timestamp", "captured frame has no QPC timestamp");
      }
      UINT64 timestamp = static_cast<UINT64>(signed_timestamp);
      if (previous_timestamp != 0 && timestamp <= previous_timestamp) continue;
      const UINT64 timing_tolerance = frame_duration / 20;
      if (next_output_timestamp != 0 && timestamp < next_output_timestamp &&
          next_output_timestamp - timestamp > timing_tolerance) {
        continue;
      }
      auto content_size = latest.ContentSize();
      if (content_size.Width <= 0 || content_size.Height <= 0) continue;
      if (content_size.Width != pool_size.Width ||
          content_size.Height != pool_size.Height) {
        latest.Close();
        latest = nullptr;
        latest_input.reset();
        pool.Recreate(capture_device,
                      DirectXPixelFormat::B8G8R8A8UIntNormalized, 2,
                      content_size);
        pool_size = content_size;
        continue;
      }
      ComPtr<ID3D11Texture2D> source = CaptureTexture(latest);
      D3D11_TEXTURE2D_DESC source_description = {};
      source->GetDesc(&source_description);
      UINT32 content_width = std::min<UINT32>(
          source_description.Width, static_cast<UINT32>(content_size.Width));
      UINT32 content_height = std::min<UINT32>(
          source_description.Height, static_cast<UINT32>(content_size.Height));
      auto input = std::make_shared<CaptureInput>();
      auto owned_description = source_description;
      owned_description.Usage = D3D11_USAGE_DEFAULT;
      owned_description.CPUAccessFlags = 0;
      owned_description.MiscFlags = 0;
      owned_description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
      Check(device.device->CreateTexture2D(&owned_description, nullptr, &input->texture), "capture-owned-input");
      device.context->CopyResource(input->texture.Get(), source.Get());
      input->width = content_width;
      input->height = content_height;
      input->timestamp = timestamp;
      input->presentation = presentation.Resolve(content_width, content_height,
          source_frames % arguments.profile.gop_frames() == 0);
      latest.Close();
      latest = nullptr;
      if (next_output_timestamp == 0) {
        next_output_timestamp = timestamp + frame_duration;
      } else {
        const UINT64 elapsed = timestamp > next_output_timestamp
                                   ? timestamp - next_output_timestamp
                                   : 0;
        next_output_timestamp +=
            (elapsed / frame_duration + 1) * frame_duration;
      }
      latest_input = input;
      submit(input);
    }
  } catch (...) {
    cleanup();
    throw;
  }
}
#endif

#ifdef PIIK_H264_FIXTURE
struct Arguments final {
  bool list = false;
  std::optional<UINT> adapter_index;
  UINT mft_index = 0;
};

Arguments ParseArguments(int count, wchar_t** values) {
  Arguments arguments;
  for (int index = 1; index < count; ++index) {
    std::wstring argument = values[index];
    if (argument == L"--list-adapters") {
      arguments.list = true;
    } else if (argument == L"--adapter-index" && index + 1 < count) {
      arguments.adapter_index = ParseIndex(values[++index], "argument-adapter");
    } else if (argument == L"--mft-index" && index + 1 < count) {
      arguments.mft_index = ParseIndex(values[++index], "argument-mft");
    } else {
      Fail("arguments", "unsupported or incomplete command-line argument");
    }
  }
  if (!arguments.list && !arguments.adapter_index) {
    Fail("arguments", "--adapter-index is required for an encode run");
  }
  return arguments;
}

void PrintEvidence(const Adapter& adapter, UINT mft_index,
                   const SelectedTransform& selected,
                   const RunEvidence& evidence) {
  double max_video_encode = *std::max_element(evidence.video_encode.begin(),
                                               evidence.video_encode.end());
  double mean_video_encode = std::accumulate(evidence.video_encode.begin(),
                                              evidence.video_encode.end(), 0.0) /
                             evidence.video_encode.size();
  std::cout << "result=go-native-h264-hardware-fixture\n"
            << "adapter_index=" << adapter.index << '\n'
            << "adapter_name=" << NarrowAscii(adapter.description.Description)
            << '\n'
            << "adapter_luid=" << LuidString(adapter.description.AdapterLuid)
            << '\n'
            << "mft_index=" << mft_index << '\n'
            << "mft_name=" << selected.name << '\n'
            << "mft_clsid=" << selected.clsid << '\n'
            << "inputs=" << evidence.inputs << '\n'
            << "outputs=" << evidence.outputs << '\n'
            << "recovery_units=" << evidence.recovery_units << '\n'
            << "max_in_flight=" << evidence.max_in_flight << '\n'
            << "output_bytes=" << evidence.output_bytes << '\n'
            << "profile_level_id=" << evidence.profile_level_id << '\n'
            << std::fixed << std::setprecision(3)
            << "latency_p95_ms=" << Percentile95(evidence.latencies_ms) << '\n'
            << "wall_seconds=" << evidence.wall_seconds << '\n'
            << "process_cpu_seconds="
            << static_cast<double>(evidence.cpu_100ns) / 10'000'000.0 << '\n'
            << "videoencode_samples=" << evidence.video_encode.size() << '\n'
            << "videoencode_mean_percent=" << mean_video_encode << '\n'
            << "videoencode_max_percent=" << max_video_encode << '\n';
}
#endif

}  // namespace

#ifdef PIIK_H264_FIXTURE
int wmain(int argc, wchar_t** argv) {
  try {
    Arguments arguments = ParseArguments(argc, argv);
    Runtime runtime;
    std::vector<Adapter> adapters = EnumerateAdapters();
    if (arguments.list) {
      PrintAdapters(adapters);
      return 0;
    }

    const Adapter& adapter = SelectAdapter(adapters, *arguments.adapter_index);
    DeviceContext device = CreateDevice(adapter);
    ActivationList activations = EnumerateHardwareEncoders(adapter);
    for (UINT32 index = 0; index < activations.count; ++index) {
      std::wstring name = GetOptionalString(activations.values[index],
                                            MFT_FRIENDLY_NAME_Attribute);
      std::cout << "mft_candidate_index=" << index
                << " name=" << NarrowAscii(name) << '\n';
    }
    SelectedTransform selected = ActivateTransform(
        activations, arguments.mft_index, device.manager.Get());
    std::cout << "selected_adapter_index=" << adapter.index << '\n'
              << "selected_adapter_name="
              << NarrowAscii(adapter.description.Description) << '\n'
              << "selected_adapter_luid="
              << LuidString(adapter.description.AdapterLuid) << '\n'
              << "selected_mft_index=" << arguments.mft_index << '\n'
              << "selected_mft_name=" << selected.name << '\n'
              << "selected_mft_clsid=" << selected.clsid << '\n'
              << std::flush;
    RunEvidence evidence = RunEncoder(adapter, device, selected);
    PrintEvidence(adapter, arguments.mft_index, selected, evidence);
    return 0;
  } catch (const GateFailure& error) {
    std::cerr << "result=no-go-native-h264-hardware-fixture\n"
              << "stage=" << error.stage() << '\n'
              << "detail=" << error.what() << '\n';
    if (FAILED(error.result())) {
      std::cerr << "hresult=0x" << std::hex << std::setfill('0')
                << std::setw(8) << static_cast<UINT32>(error.result()) << '\n';
    }
    return 2;
  } catch (const std::exception& error) {
    std::cerr << "result=no-go-native-h264-hardware-fixture\n"
              << "stage=unclassified\n"
              << "detail=" << error.what() << '\n';
    return 3;
  }
}
#endif

#ifndef PIIK_H264_FIXTURE
int wmain(int argc, wchar_t** argv) {
  try {
    ProductArguments arguments = ParseProductArguments(argc, argv);
    if (arguments.mode == ProductArguments::Mode::list) {
      return piik::capture::WriteSourceList();
    }
    if (arguments.mode == ProductArguments::Mode::probe) {
      Runtime runtime;
      WriteCapabilityProbe();
      return 0;
    }
    if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
      Fail("stdout-binary", "could not switch stdout to binary mode");
    }
    if (arguments.mode == ProductArguments::Mode::preview) {
      Check(piik::capture::WriteSourcePreview(
                arguments.target_kind, arguments.source_id, arguments.pid,
                arguments.creation_time),
            "capture-preview");
      return 0;
    }
    if (arguments.mode == ProductArguments::Mode::audio) {
      Check(RunAudioCapture(arguments), "process-audio-capture");
      return 0;
    }
    Runtime runtime;
    if (arguments.mode == ProductArguments::Mode::encoded) RunEncodedVideo(arguments);
    else RunVideoCapture(arguments);
    return 0;
  } catch (const GateFailure& error) {
    std::cerr << "result=window-capture-failed\n"
              << "stage=" << error.stage() << '\n'
              << "detail=" << error.what() << '\n';
    if (FAILED(error.result())) {
      std::cerr << "hresult=0x" << std::hex << std::setfill('0')
                << std::setw(8) << static_cast<UINT32>(error.result()) << '\n';
    }
    return 2;
  } catch (const winrt::hresult_error& error) {
    std::cerr << "result=window-capture-failed\n"
              << "stage=windows-runtime\n"
              << "hresult=0x" << std::hex << std::setfill('0')
              << std::setw(8) << static_cast<UINT32>(error.code()) << '\n';
    return 2;
  } catch (const std::exception& error) {
    std::cerr << "result=window-capture-failed\n"
              << "stage=unclassified\n"
              << "detail=" << error.what() << '\n';
    return 3;
  }
}
#endif
