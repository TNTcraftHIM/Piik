#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <codecapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <strmif.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>

#include "capture_error.h"

#include <chrono>
#include <iomanip>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace piik::capture {
enum class OutputKind : UINT8;
}

namespace piik::capture::windows {

using Microsoft::WRL::ComPtr;

enum class DegradationPreference {
  resolution,
  balanced,
  framerate,
};

struct VideoProfile final {
  UINT32 width = 1280;
  UINT32 height = 720;
  UINT32 frame_rate = 30;
  UINT32 bit_rate = 3'000'000;
  DegradationPreference preference = DegradationPreference::balanced;

  UINT32 gop_frames() const { return frame_rate * 2; }
  LONGLONG frame_duration_100ns() const {
    return 10'000'000 / static_cast<LONGLONG>(frame_rate);
  }
  UINT32 quality_vs_speed() const {
    if (preference == DegradationPreference::resolution) return 100;
    if (preference == DegradationPreference::framerate) return 0;
    return 50;
  }
  UINT32 h264_level() const {
    const UINT64 macroblocks =
        ((static_cast<UINT64>(width) + 15) / 16) *
        ((static_cast<UINT64>(height) + 15) / 16);
    const UINT64 macroblocks_per_second = macroblocks * frame_rate;
    if (macroblocks <= 3'600 && macroblocks_per_second <= 108'000) return 31;
    if (macroblocks <= 8'192 && macroblocks_per_second <= 245'760) return 40;
    if (macroblocks <= 8'704 && macroblocks_per_second <= 522'240) return 42;
    if (macroblocks <= 22'080 && macroblocks_per_second <= 589'824) return 50;
    return 51;
  }
  std::string profile_level_id() const {
    std::ostringstream output;
    output << "42c0" << std::hex << std::setfill('0') << std::setw(2)
           << h264_level();
    return output.str();
  }
};

constexpr VideoProfile kDefaultVideoProfile{};

struct Runtime final {
  Runtime() {
    Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "com-initialize");
    com_started = true;
    Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "mf-startup");
    mf_started = true;
  }

  ~Runtime() {
    if (mf_started) {
      MFShutdown();
    }
    if (com_started) {
      CoUninitialize();
    }
  }

  bool com_started = false;
  bool mf_started = false;
};

struct Adapter final {
  UINT index = 0;
  DXGI_ADAPTER_DESC1 description = {};
  ComPtr<IDXGIAdapter1> value;
};

struct DeviceContext final {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IMFDXGIDeviceManager> manager;
  D3D_FEATURE_LEVEL feature_level = D3D_FEATURE_LEVEL_9_1;
};

class ActivationList final {
 public:
  ActivationList() = default;
  ActivationList(const ActivationList&) = delete;
  ActivationList& operator=(const ActivationList&) = delete;
  ActivationList(ActivationList&& other) noexcept
      : values(std::exchange(other.values, nullptr)),
        count(std::exchange(other.count, 0)) {}

  ~ActivationList() {
    for (UINT32 index = 0; index < count; ++index) {
      values[index]->Release();
    }
    CoTaskMemFree(values);
  }

  IMFActivate** values = nullptr;
  UINT32 count = 0;
};

struct SelectedTransform final {
  SelectedTransform() = default;
  SelectedTransform(const SelectedTransform&) = delete;
  SelectedTransform& operator=(const SelectedTransform&) = delete;
  SelectedTransform(SelectedTransform&&) noexcept = default;
  SelectedTransform& operator=(SelectedTransform&&) = delete;
  ~SelectedTransform() { if (activation) activation->ShutdownObject(); }

  std::string name;
  std::string clsid;
  ComPtr<IMFActivate> activation;
  ComPtr<IMFTransform> transform;
  ComPtr<ICodecAPI> codec;
  ComPtr<IMFMediaEventGenerator> events;
};

struct NalSummary final {
  bool annex_b = false;
  bool sps = false;
  bool pps = false;
  bool idr = false;
  std::optional<std::string> profile_level_id;
};

std::vector<Adapter> EnumerateAdapters();
const Adapter& SelectAdapter(const std::vector<Adapter>& adapters, UINT index);
DeviceContext CreateDevice(const Adapter& adapter);
ActivationList EnumerateHardwareEncoders(const Adapter& adapter,
                                         bool require_candidate = true);
SelectedTransform ActivateTransform(const ActivationList& list, UINT index,
                                    IMFDXGIDeviceManager* manager);
std::wstring GetOptionalString(IMFAttributes* attributes, const GUID& key);
std::string NarrowAscii(const std::wstring& value);
std::string GuidString(const GUID& value);

// The hardware fixture uses the same configuration and output validation.
void SetU32(ICodecAPI* codec, const GUID& key, UINT32 expected,
            const std::string& name);
void ConfigureCodec(ICodecAPI* codec,
                    const VideoProfile& profile = kDefaultVideoProfile);
ComPtr<IMFMediaType> CreateOutputType(
    const VideoProfile& profile = kDefaultVideoProfile);
ComPtr<IMFMediaType> CreateInputType(
    const VideoProfile& profile = kDefaultVideoProfile);
void ValidateMediaTypes(IMFTransform* transform,
                        const VideoProfile& profile = kDefaultVideoProfile);
void ValidateCodecReadback(ICodecAPI* codec,
                           const VideoProfile& profile = kDefaultVideoProfile);
void ForceKeyFrame(ICodecAPI* codec);
ComPtr<IMFSample> PullOutput(IMFTransform* transform,
                            const MFT_OUTPUT_STREAM_INFO& info);
NalSummary InspectAnnexB(const std::vector<UINT8>& bytes);
std::vector<UINT8> ReadSample(IMFSample* sample);

struct EncodedAccessUnit final {
  UINT64 timestamp100ns = 0;
  bool key_frame = false;
  std::vector<UINT8> bytes;
};

using EncoderClock = std::chrono::steady_clock;

void RequireEncoderTime(EncoderClock::time_point deadline);

class VideoEncoder {
 public:
  VideoEncoder(OutputKind kind, std::string name, std::string identity)
      : kind(kind), name(std::move(name)), identity(std::move(identity)) {}
  virtual ~VideoEncoder() = default;
  virtual EncodedAccessUnit Encode(ID3D11Texture2D* texture,
                                    UINT64 timestamp100ns,
                                    bool force_key_frame,
                                    EncoderClock::time_point deadline =
                                        EncoderClock::time_point::max()) = 0;
  virtual void SetBitrate(UINT32 bitrate) = 0;
  const OutputKind kind;
  const std::string name;
  const std::string identity;
};

// The caller owns COM/MF startup and serializes access to each encoder.
class LiveEncoder final : public VideoEncoder {
 public:
  explicit LiveEncoder(SelectedTransform selected,
                       VideoProfile profile = kDefaultVideoProfile);
  ~LiveEncoder() override;
  LiveEncoder(const LiveEncoder&) = delete;
  LiveEncoder& operator=(const LiveEncoder&) = delete;

  void SetBitrate(UINT32 bitrate) override;
  EncodedAccessUnit Encode(
      ID3D11Texture2D* texture, UINT64 timestamp100ns, bool force_key_frame,
      EncoderClock::time_point deadline = EncoderClock::time_point::max()) override;

 private:
  MediaEventType NextEvent(EncoderClock::time_point deadline);
  void WaitForInput(EncoderClock::time_point deadline);

  SelectedTransform selected_;
  VideoProfile profile_;
  MFT_OUTPUT_STREAM_INFO output_info_ = {};
  UINT32 input_requests_ = 0;
  std::optional<std::string> profile_level_id_;
  bool started_ = false;
};

}  // namespace piik::capture::windows
