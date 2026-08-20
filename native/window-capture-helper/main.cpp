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
#ifdef SCREENER_H264_FIXTURE
#include <pdh.h>
#include <pdhmsg.h>
#endif
#include <propvarutil.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>

#include "process_audio.h"

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

namespace {

constexpr UINT32 kWidth = 1280;
constexpr UINT32 kHeight = 720;
constexpr UINT32 kFrameRate = 30;
constexpr UINT32 kBitRate = 3'000'000;
constexpr UINT32 kVbvBytes = kBitRate / kFrameRate / 8;
constexpr UINT32 kGopFrames = 60;
constexpr UINT32 kMaxEventsPerPump = 64;
constexpr DWORD kMaxEncodedSampleBytes = 4 * 1024 * 1024;
#ifdef SCREENER_H264_FIXTURE
constexpr UINT32 kFrameCount = 360;
constexpr UINT32 kMaxInFlight = 8;
constexpr DWORD kMaxPdhArrayBytes = 4 * 1024 * 1024;
constexpr DWORD kMaxPdhArrayItems = 16 * 1024;
#endif

constexpr LONGLONG kFrameDuration100ns = 10'000'000 / kFrameRate;

class GateFailure final : public std::runtime_error {
 public:
  GateFailure(std::string stage, std::string detail, HRESULT result = S_OK)
      : std::runtime_error(detail), stage_(std::move(stage)), result_(result) {}

  const std::string& stage() const noexcept { return stage_; }
  HRESULT result() const noexcept { return result_; }

 private:
  std::string stage_;
  HRESULT result_;
};

[[noreturn]] void Fail(const std::string& stage, const std::string& detail) {
  throw GateFailure(stage, detail);
}

void Check(HRESULT result, const std::string& stage) {
  if (FAILED(result)) {
    throw GateFailure(stage, "Windows API returned a failing HRESULT", result);
  }
}

std::wstring Lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](wchar_t character) { return std::towlower(character); });
  return value;
}

std::string NarrowAscii(const std::wstring& value) {
  std::string result;
  result.reserve(value.size());
  for (wchar_t character : value) {
    result.push_back(character >= 32 && character <= 126
                         ? static_cast<char>(character)
                         : '?');
  }
  return result;
}

std::string GuidString(const GUID& value) {
  wchar_t buffer[40] = {};
  if (StringFromGUID2(value, buffer, static_cast<int>(std::size(buffer))) == 0) {
    return "unavailable";
  }
  return NarrowAscii(buffer);
}

std::string LuidString(const LUID& luid) {
  std::ostringstream output;
  output << "0x" << std::hex << std::setfill('0') << std::setw(8)
         << static_cast<UINT32>(luid.HighPart) << ":0x" << std::setw(8)
         << luid.LowPart;
  return output.str();
}

std::string HexByte(UINT8 value) {
  std::ostringstream output;
  output << std::hex << std::setfill('0') << std::setw(2)
         << static_cast<UINT32>(value);
  return output.str();
}

std::string ProfileLevelId(UINT8 profile, UINT8 constraints, UINT8 level) {
  return HexByte(profile) + HexByte(constraints) + HexByte(level);
}

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

std::vector<Adapter> EnumerateAdapters() {
  ComPtr<IDXGIFactory1> factory;
  Check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "dxgi-factory");

  std::vector<Adapter> adapters;
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIAdapter1> adapter;
    HRESULT result = factory->EnumAdapters1(index, &adapter);
    if (result == DXGI_ERROR_NOT_FOUND) {
      break;
    }
    Check(result, "dxgi-enumerate-adapter");

    Adapter current;
    current.index = index;
    current.value = adapter;
    Check(adapter->GetDesc1(&current.description), "dxgi-adapter-description");
    if ((current.description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0) {
      adapters.push_back(std::move(current));
    }
  }
  return adapters;
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

const Adapter& SelectAdapter(const std::vector<Adapter>& adapters, UINT index) {
  auto found = std::find_if(adapters.begin(), adapters.end(),
                            [index](const Adapter& adapter) {
                              return adapter.index == index;
                            });
  if (found == adapters.end()) {
    Fail("adapter-select", "selected DXGI adapter index is unavailable");
  }
  return *found;
}

struct DeviceContext final {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IMFDXGIDeviceManager> manager;
  D3D_FEATURE_LEVEL feature_level = D3D_FEATURE_LEVEL_9_1;
};

DeviceContext CreateDevice(const Adapter& adapter) {
  DeviceContext result;
  constexpr D3D_FEATURE_LEVEL levels[] = {
      D3D_FEATURE_LEVEL_12_1, D3D_FEATURE_LEVEL_12_0,
      D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
  };
  Check(D3D11CreateDevice(adapter.value.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                          D3D11_CREATE_DEVICE_VIDEO_SUPPORT |
                              D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                          levels, static_cast<UINT>(std::size(levels)),
                          D3D11_SDK_VERSION, &result.device,
                          &result.feature_level, &result.context),
        "d3d11-create-device");

  ComPtr<ID3D10Multithread> multithread;
  Check(result.device.As(&multithread), "d3d11-multithread-interface");
  multithread->SetMultithreadProtected(TRUE);
  if (!multithread->GetMultithreadProtected()) {
    Fail("d3d11-multithread-protection",
         "D3D11 device did not enable multithread protection");
  }

  UINT reset_token = 0;
  Check(MFCreateDXGIDeviceManager(&reset_token, &result.manager),
        "dxgi-device-manager-create");
  Check(result.manager->ResetDevice(result.device.Get(), reset_token),
        "dxgi-device-manager-reset");
  return result;
}

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

std::wstring GetOptionalString(IMFAttributes* attributes, const GUID& key) {
  wchar_t* raw = nullptr;
  UINT32 length = 0;
  HRESULT result = attributes->GetAllocatedString(key, &raw, &length);
  if (result == MF_E_ATTRIBUTENOTFOUND) {
    return L"";
  }
  Check(result, "mft-activation-string");
  std::wstring value(raw, length);
  CoTaskMemFree(raw);
  return value;
}

ActivationList EnumerateHardwareEncoders(const Adapter& adapter) {
  ComPtr<IMFAttributes> attributes;
  Check(MFCreateAttributes(&attributes, 1), "mft-enumeration-attributes");
  Check(attributes->SetBlob(MFT_ENUM_ADAPTER_LUID,
                            reinterpret_cast<const UINT8*>(
                                &adapter.description.AdapterLuid),
                            sizeof(LUID)),
        "mft-enumeration-adapter-luid");

  MFT_REGISTER_TYPE_INFO input = {MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output = {MFMediaType_Video, MFVideoFormat_H264};
  ActivationList list;
  Check(MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER,
                 MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                 &input, &output, attributes.Get(), &list.values, &list.count),
        "mft-hardware-enumeration");
  if (list.count == 0) {
    Fail("mft-hardware-enumeration",
         "selected adapter exposed no hardware NV12-to-H264 MFT");
  }
  return list;
}

struct SelectedTransform final {
  std::string name;
  std::string clsid;
  ComPtr<IMFTransform> transform;
  ComPtr<ICodecAPI> codec;
  ComPtr<IMFMediaEventGenerator> events;
};

SelectedTransform ActivateTransform(const ActivationList& list, UINT index,
                                    IMFDXGIDeviceManager* manager) {
  if (index >= list.count) {
    Fail("mft-select", "selected hardware MFT index is unavailable");
  }

  IMFActivate* activation = list.values[index];
  std::wstring friendly = GetOptionalString(activation, MFT_FRIENDLY_NAME_Attribute);
  if (friendly.empty()) {
    Fail("mft-identity", "hardware MFT has no friendly-name attribute");
  }

  GUID clsid = {};
  Check(activation->GetGUID(MFT_TRANSFORM_CLSID_Attribute, &clsid),
        "mft-clsid");

  PROPVARIANT hardware_url;
  PropVariantInit(&hardware_url);
  HRESULT hardware_result = activation->GetItem(
      MFT_ENUM_HARDWARE_URL_Attribute, &hardware_url);
  PropVariantClear(&hardware_url);
  if (FAILED(hardware_result)) {
    Fail("mft-hardware-identity",
         "hardware-only activation omitted its hardware URL attribute");
  }

  SelectedTransform selected;
  selected.name = NarrowAscii(friendly);
  selected.clsid = GuidString(clsid);
  Check(activation->ActivateObject(IID_PPV_ARGS(&selected.transform)),
        "mft-activate");

  ComPtr<IMFAttributes> transform_attributes;
  Check(selected.transform->GetAttributes(&transform_attributes),
        "mft-global-attributes");
  UINT32 is_async = 0;
  Check(transform_attributes->GetUINT32(MF_TRANSFORM_ASYNC, &is_async),
        "mft-async-readback");
  if (is_async != TRUE) {
    Fail("mft-async-readback", "hardware MFT is not asynchronous");
  }
  Check(transform_attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE),
        "mft-async-unlock");

  UINT32 d3d11_aware = 0;
  Check(transform_attributes->GetUINT32(MF_SA_D3D11_AWARE, &d3d11_aware),
        "mft-d3d11-aware-readback");
  if (d3d11_aware != TRUE) {
    Fail("mft-d3d11-aware-readback", "hardware MFT is not D3D11-aware");
  }

  Check(selected.transform->ProcessMessage(
            MFT_MESSAGE_SET_D3D_MANAGER,
            reinterpret_cast<ULONG_PTR>(manager)),
        "mft-set-d3d-manager");
  Check(selected.transform.As(&selected.codec), "mft-codec-api");
  Check(selected.transform.As(&selected.events), "mft-event-generator");
  return selected;
}

void RequireProperty(ICodecAPI* codec, const GUID& key,
                     const std::string& name) {
  HRESULT supported = codec->IsSupported(&key);
  if (supported != S_OK) {
    if (FAILED(supported) && supported != E_NOTIMPL) {
      Check(supported, name + "-supported-query");
    }
    Fail(name + "-unsupported", "required codec property is unsupported");
  }
  HRESULT modifiable = codec->IsModifiable(&key);
  if (modifiable == S_FALSE) {
    Fail(name + "-readonly", "required codec property is read-only");
  }
  // Some hardware MFTs do not implement this advisory query. SetValue=S_OK
  // followed by exact GetValue readback remains the authoritative gate.
  if (modifiable != S_OK && modifiable != E_NOTIMPL) {
    Check(modifiable, name + "-modifiable-query");
  }
}

UINT32 ReadU32(ICodecAPI* codec, const GUID& key, const std::string& name) {
  VARIANT value;
  VariantInit(&value);
  Check(codec->GetValue(&key, &value), name + "-readback");
  if (value.vt != VT_UI4) {
    VariantClear(&value);
    Fail(name + "-readback-type", "codec property did not return VT_UI4");
  }
  UINT32 result = value.ulVal;
  VariantClear(&value);
  return result;
}

bool ReadBool(ICodecAPI* codec, const GUID& key, const std::string& name) {
  VARIANT value;
  VariantInit(&value);
  Check(codec->GetValue(&key, &value), name + "-readback");
  if (value.vt != VT_BOOL) {
    VariantClear(&value);
    Fail(name + "-readback-type", "codec property did not return VT_BOOL");
  }
  bool result = value.boolVal != VARIANT_FALSE;
  VariantClear(&value);
  return result;
}

void SetU32(ICodecAPI* codec, const GUID& key, UINT32 expected,
            const std::string& name) {
  RequireProperty(codec, key, name);
  VARIANT value;
  VariantInit(&value);
  value.vt = VT_UI4;
  value.ulVal = expected;
  HRESULT set_result = codec->SetValue(&key, &value);
  VariantClear(&value);
  if (set_result != S_OK) {
    if (FAILED(set_result)) {
      Check(set_result, name + "-set");
    }
    Fail(name + "-readonly", "codec property rejected the requested value");
  }
  if (ReadU32(codec, key, name) != expected) {
    Fail(name + "-weakened", "codec property readback changed the requested value");
  }
}

void SetBool(ICodecAPI* codec, const GUID& key, bool expected,
             const std::string& name) {
  RequireProperty(codec, key, name);
  VARIANT value;
  VariantInit(&value);
  value.vt = VT_BOOL;
  value.boolVal = expected ? VARIANT_TRUE : VARIANT_FALSE;
  HRESULT set_result = codec->SetValue(&key, &value);
  VariantClear(&value);
  if (set_result != S_OK) {
    if (FAILED(set_result)) {
      Check(set_result, name + "-set");
    }
    Fail(name + "-readonly", "codec property rejected the requested value");
  }
  if (ReadBool(codec, key, name) != expected) {
    Fail(name + "-weakened", "codec property readback changed the requested value");
  }
}

void ConfigureCodec(ICodecAPI* codec) {
  SetU32(codec, CODECAPI_AVEncCommonRateControlMode,
         eAVEncCommonRateControlMode_CBR, "codec-cbr");
  SetBool(codec, CODECAPI_AVLowLatencyMode, true, "codec-low-latency");
  SetU32(codec, CODECAPI_AVEncCommonMeanBitRate, kBitRate,
         "codec-mean-bitrate");
  SetU32(codec, CODECAPI_AVEncCommonBufferSize, kVbvBytes,
         "codec-vbv-bytes");
  SetU32(codec, CODECAPI_AVEncMPVGOPSize, kGopFrames, "codec-gop");
  RequireProperty(codec, CODECAPI_AVEncVideoForceKeyFrame,
                  "codec-force-keyframe");
}

ComPtr<IMFMediaType> CreateOutputType() {
  ComPtr<IMFMediaType> type;
  Check(MFCreateMediaType(&type), "output-type-create");
  Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
        "output-type-major");
  Check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264),
        "output-type-subtype");
  Check(type->SetUINT32(MF_MT_AVG_BITRATE, kBitRate),
        "output-type-bitrate");
  Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, kWidth, kHeight),
        "output-type-size");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kFrameRate, 1),
        "output-type-framerate");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
        "output-type-pixel-aspect");
  Check(type->SetUINT32(MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive),
        "output-type-interlace");
  Check(type->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base),
        "output-type-profile");
  Check(type->SetUINT32(MF_MT_MPEG2_LEVEL, 31), "output-type-level");
  return type;
}

ComPtr<IMFMediaType> CreateInputType() {
  ComPtr<IMFMediaType> type;
  Check(MFCreateMediaType(&type), "input-type-create");
  Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
        "input-type-major");
  Check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12),
        "input-type-subtype");
  Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, kWidth, kHeight),
        "input-type-size");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kFrameRate, 1),
        "input-type-framerate");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
        "input-type-pixel-aspect");
  Check(type->SetUINT32(MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive),
        "input-type-interlace");
  Check(type->SetUINT32(MF_MT_DEFAULT_STRIDE, kWidth),
        "input-type-stride");
  return type;
}

void RequireTypeU32(IMFAttributes* type, const GUID& key, UINT32 expected,
                    const std::string& stage) {
  UINT32 actual = 0;
  Check(type->GetUINT32(key, &actual), stage + "-readback");
  if (actual != expected) {
    Fail(stage + "-weakened", "media type changed a required value");
  }
}

void ValidateMediaTypes(IMFTransform* transform) {
  ComPtr<IMFMediaType> output;
  Check(transform->GetOutputCurrentType(0, &output),
        "output-type-current");
  GUID subtype = {};
  Check(output->GetGUID(MF_MT_SUBTYPE, &subtype), "output-type-subtype-readback");
  if (subtype != MFVideoFormat_H264) {
    Fail("output-type-subtype-weakened", "output is not H264");
  }
  RequireTypeU32(output.Get(), MF_MT_AVG_BITRATE, kBitRate,
                 "output-type-bitrate");
  RequireTypeU32(output.Get(), MF_MT_MPEG2_PROFILE,
                 eAVEncH264VProfile_Base, "output-type-profile");
  RequireTypeU32(output.Get(), MF_MT_MPEG2_LEVEL, 31, "output-type-level");

  UINT32 width = 0;
  UINT32 height = 0;
  Check(MFGetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, &width, &height),
        "output-type-size-readback");
  if (width != kWidth || height != kHeight) {
    Fail("output-type-size-weakened", "output dimensions changed");
  }
  UINT32 numerator = 0;
  UINT32 denominator = 0;
  Check(MFGetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, &numerator,
                            &denominator),
        "output-type-framerate-readback");
  if (numerator != kFrameRate || denominator != 1) {
    Fail("output-type-framerate-weakened", "output frame rate changed");
  }
}

void ValidateCodecReadback(ICodecAPI* codec) {
  if (ReadU32(codec, CODECAPI_AVEncCommonRateControlMode, "codec-cbr") !=
          eAVEncCommonRateControlMode_CBR ||
      !ReadBool(codec, CODECAPI_AVLowLatencyMode, "codec-low-latency") ||
      ReadU32(codec, CODECAPI_AVEncCommonMeanBitRate,
              "codec-mean-bitrate") != kBitRate ||
      ReadU32(codec, CODECAPI_AVEncCommonBufferSize, "codec-vbv-bytes") !=
          kVbvBytes ||
      ReadU32(codec, CODECAPI_AVEncMPVGOPSize, "codec-gop") != kGopFrames) {
    Fail("codec-final-readback", "one or more codec properties were weakened");
  }
}

#ifdef SCREENER_H264_FIXTURE
std::vector<UINT8> SyntheticNv12(UINT32 frame_index) {
  std::vector<UINT8> pixels(kWidth * kHeight * 3 / 2);
  const UINT32 bar_start = (frame_index * 11) % kWidth;
  for (UINT32 y = 0; y < kHeight; ++y) {
    for (UINT32 x = 0; x < kWidth; ++x) {
      UINT32 distance = (x + kWidth - bar_start) % kWidth;
      UINT8 base = static_cast<UINT8>(16 + ((x / 8 + y / 8 + frame_index) % 180));
      pixels[y * kWidth + x] = distance < 96 ? static_cast<UINT8>(235) : base;
    }
  }
  UINT8* uv = pixels.data() + kWidth * kHeight;
  for (UINT32 y = 0; y < kHeight / 2; ++y) {
    for (UINT32 x = 0; x < kWidth; x += 2) {
      uv[y * kWidth + x] = static_cast<UINT8>(96 + (frame_index % 64));
      uv[y * kWidth + x + 1] = static_cast<UINT8>(160 - (frame_index % 64));
    }
  }
  return pixels;
}

ComPtr<IMFSample> CreateInputSample(ID3D11Device* device, UINT32 frame_index) {
  std::vector<UINT8> pixels = SyntheticNv12(frame_index);
  D3D11_TEXTURE2D_DESC description = {};
  description.Width = kWidth;
  description.Height = kHeight;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_NV12;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;

  D3D11_SUBRESOURCE_DATA initial = {};
  initial.pSysMem = pixels.data();
  initial.SysMemPitch = kWidth;
  initial.SysMemSlicePitch = static_cast<UINT>(pixels.size());

  ComPtr<ID3D11Texture2D> texture;
  Check(device->CreateTexture2D(&description, &initial, &texture),
        "input-texture-create");

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

struct NalSummary final {
  bool annex_b = false;
  bool sps = false;
  bool pps = false;
  bool idr = false;
  std::optional<std::string> profile_level_id;
};

std::optional<std::pair<size_t, size_t>> FindStartCode(
    const std::vector<UINT8>& bytes, size_t from) {
  for (size_t index = from; index + 3 <= bytes.size(); ++index) {
    if (bytes[index] != 0 || bytes[index + 1] != 0) {
      continue;
    }
    if (bytes[index + 2] == 1) {
      return std::pair<size_t, size_t>{index, 3};
    }
    if (index + 4 <= bytes.size() && bytes[index + 2] == 0 &&
        bytes[index + 3] == 1) {
      return std::pair<size_t, size_t>{index, 4};
    }
  }
  return std::nullopt;
}

NalSummary InspectAnnexB(const std::vector<UINT8>& bytes) {
  NalSummary summary;
  std::optional<std::pair<size_t, size_t>> current = FindStartCode(bytes, 0);
  if (!current || current->first != 0) {
    return summary;
  }
  summary.annex_b = true;
  while (current) {
    size_t nal_start = current->first + current->second;
    std::optional<std::pair<size_t, size_t>> next = FindStartCode(bytes, nal_start);
    size_t nal_end = next ? next->first : bytes.size();
    if (nal_start < nal_end) {
      UINT8 nal_type = bytes[nal_start] & 0x1f;
      summary.sps = summary.sps || nal_type == 7;
      summary.pps = summary.pps || nal_type == 8;
      summary.idr = summary.idr || nal_type == 5;
      if (nal_type == 7 && nal_end - nal_start >= 4) {
        std::string value = ProfileLevelId(bytes[nal_start + 1],
                                           bytes[nal_start + 2],
                                           bytes[nal_start + 3]);
        if (summary.profile_level_id && *summary.profile_level_id != value) {
          Fail("bitstream-sps-consistency",
               "one access unit contained conflicting SPS profile bytes");
        }
        summary.profile_level_id = value;
      }
    }
    current = next;
  }
  return summary;
}

std::vector<UINT8> ReadSample(IMFSample* sample) {
  DWORD total_length = 0;
  Check(sample->GetTotalLength(&total_length), "output-total-length");
  if (total_length == 0 || total_length > kMaxEncodedSampleBytes) {
    Fail("output-buffer-bounds", "encoded output size is empty or unbounded");
  }

  ComPtr<IMFMediaBuffer> buffer;
  Check(sample->ConvertToContiguousBuffer(&buffer), "output-contiguous-buffer");
  DWORD length = 0;
  Check(buffer->GetCurrentLength(&length), "output-buffer-length");
  if (length != total_length) {
    Fail("output-buffer-length", "contiguous output length changed unexpectedly");
  }
  std::vector<UINT8> bytes(length);
  UINT8* raw = nullptr;
  DWORD maximum = 0;
  DWORD current = 0;
  Check(buffer->Lock(&raw, &maximum, &current), "output-buffer-lock");
  if (raw == nullptr || current != length || current > kMaxEncodedSampleBytes) {
    buffer->Unlock();
    Fail("output-buffer-lock-bounds",
         "locked output length is inconsistent or unbounded");
  }
  std::copy(raw, raw + current, bytes.begin());
  Check(buffer->Unlock(), "output-buffer-unlock");
  return bytes;
}

#ifdef SCREENER_H264_FIXTURE
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
  std::vector<double> latencies_ms;
  std::vector<double> video_encode;
  std::string profile_level_id;
  ULONGLONG cpu_100ns = 0;
  double wall_seconds = 0.0;
};
#endif

void ForceKeyFrame(ICodecAPI* codec) {
  VARIANT value;
  VariantInit(&value);
  value.vt = VT_UI4;
  value.ulVal = 1;
  HRESULT set_result =
      codec->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &value);
  VariantClear(&value);
  if (set_result != S_OK) {
    if (FAILED(set_result)) {
      Check(set_result, "codec-force-keyframe-set");
    }
    Fail("codec-force-keyframe-readonly",
         "force-key-frame command was not accepted");
  }
}

ComPtr<IMFSample> CreateCallerOutputSample(const MFT_OUTPUT_STREAM_INFO& info) {
  if (info.cbSize > kMaxEncodedSampleBytes) {
    Fail("output-buffer-contract",
         "hardware MFT requested an output buffer larger than four MiB");
  }
  ComPtr<IMFSample> sample;
  Check(MFCreateSample(&sample), "output-sample-create");
  ComPtr<IMFMediaBuffer> buffer;
  Check(MFCreateMemoryBuffer(kMaxEncodedSampleBytes, &buffer),
        "output-memory-buffer");
  Check(sample->AddBuffer(buffer.Get()), "output-sample-buffer");
  return sample;
}

ComPtr<IMFSample> PullOutput(IMFTransform* transform,
                             const MFT_OUTPUT_STREAM_INFO& info) {
  bool transform_provides =
      (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES |
                       MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
  ComPtr<IMFSample> caller_sample;
  if (!transform_provides) {
    caller_sample = CreateCallerOutputSample(info);
  }

  MFT_OUTPUT_DATA_BUFFER output = {};
  output.dwStreamID = 0;
  output.pSample = caller_sample.Get();
  DWORD status = 0;
  HRESULT result = transform->ProcessOutput(0, 1, &output, &status);

  ComPtr<IMFCollection> events;
  if (output.pEvents != nullptr) {
    events.Attach(output.pEvents);
  }
  Check(result, "mft-process-output");
  if ((output.dwStatus & MFT_OUTPUT_DATA_BUFFER_FORMAT_CHANGE) != 0 ||
      (status & MFT_PROCESS_OUTPUT_STATUS_NEW_STREAMS) != 0) {
    Fail("mft-output-format-change",
         "hardware MFT changed format during the fixed run");
  }

  if (caller_sample) {
    if (output.pSample != caller_sample.Get()) {
      if (output.pSample != nullptr) {
        output.pSample->Release();
      }
      Fail("mft-output-allocation",
           "hardware MFT replaced the caller-owned output sample");
    }
    return caller_sample;
  }
  if (output.pSample == nullptr) {
    Fail("mft-output-sample", "hardware MFT produced no output sample");
  }
  ComPtr<IMFSample> produced;
  produced.Attach(output.pSample);
  return produced;
}

#ifdef SCREENER_H264_FIXTURE
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
  constexpr const char* default_pion_fmtp[] = {
      "42001f", "42e01f", "4d001f", "64001f",
  };
  if (std::find(std::begin(default_pion_fmtp), std::end(default_pion_fmtp),
                *observed_profile) == std::end(default_pion_fmtp)) {
    Fail("bitstream-pinned-fmtp",
         "SPS profile-level-id is not in the default Pion mode-1 fmtp set");
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

#ifndef SCREENER_H264_FIXTURE
constexpr DWORD kMaxProductAccessUnitBytes = 1 * 1024 * 1024;
constexpr DWORD kMaxStatusBytes = 4 * 1024;
constexpr UINT64 kEnvelopeFrameDuration100ns =
    (static_cast<UINT64>(kFrameDuration100ns) / 10) * 10;

enum class OutputKind : UINT8 {
  pcm = 1,
  h264 = 2,
  status = 3,
};

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

void PutUint32BE(BYTE* output, UINT32 value) {
  for (int index = 3; index >= 0; --index) {
    output[index] = static_cast<BYTE>(value & 0xff);
    value >>= 8;
  }
}

void PutUint64BE(BYTE* output, UINT64 value) {
  for (int index = 7; index >= 0; --index) {
    output[index] = static_cast<BYTE>(value & 0xff);
    value >>= 8;
  }
}

class ProtocolWriter final {
 public:
  HRESULT Write(OutputKind kind, UINT8 flags, UINT64 timestamp100ns,
                UINT64 duration100ns, const BYTE* data, DWORD size) {
    DWORD maximum = kind == OutputKind::status ? kMaxStatusBytes
                                                : kMaxProductAccessUnitBytes;
    if (data == nullptr || size == 0 || size > maximum ||
        (kind != OutputKind::status && duration100ns == 0)) {
      return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
    }
    std::array<BYTE, 28> header{};
    header[0] = 'S';
    header[1] = 'M';
    header[2] = 'E';
    header[3] = 'D';
    header[4] = 1;
    header[5] = static_cast<BYTE>(kind);
    header[6] = flags;
    PutUint64BE(header.data() + 8, timestamp100ns);
    PutUint64BE(header.data() + 16, duration100ns);
    PutUint32BE(header.data() + 24, size);

    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT result = WriteAll(header.data(), static_cast<DWORD>(header.size()));
    return SUCCEEDED(result) ? WriteAll(data, size) : result;
  }

  HRESULT WriteStatus(const std::string& value) {
    return Write(OutputKind::status, 0, 0, 0,
                 reinterpret_cast<const BYTE*>(value.data()),
                 static_cast<DWORD>(value.size()));
  }

 private:
  HRESULT WriteAll(const BYTE* data, DWORD size) {
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    while (size > 0) {
      DWORD written = 0;
      if (!WriteFile(output, data, size, &written, nullptr)) {
        return HRESULT_FROM_WIN32(GetLastError());
      }
      if (written == 0) return HRESULT_FROM_WIN32(ERROR_WRITE_FAULT);
      data += written;
      size -= written;
    }
    return S_OK;
  }

  std::mutex mutex_;
};

ComPtr<IMFSample> CreateSurfaceSample(ID3D11Texture2D* texture,
                                      LONGLONG timestamp100ns,
                                      LONGLONG duration100ns) {
  ComPtr<IMFMediaBuffer> buffer;
  Check(MFCreateDXGISurfaceBuffer(IID_ID3D11Texture2D, texture, 0, FALSE,
                                  &buffer),
        "input-dxgi-buffer");
  ComPtr<IMFSample> sample;
  Check(MFCreateVideoSampleFromSurface(nullptr, &sample),
        "input-video-sample");
  Check(sample->AddBuffer(buffer.Get()), "input-sample-buffer");
  Check(sample->SetSampleTime(timestamp100ns), "input-sample-time");
  Check(sample->SetSampleDuration(duration100ns), "input-sample-duration");
  return sample;
}

struct EncodedAccessUnit final {
  UINT64 timestamp100ns = 0;
  bool key_frame = false;
  std::vector<UINT8> bytes;
};

class LiveEncoder final {
 public:
  explicit LiveEncoder(SelectedTransform selected)
      : selected_(std::move(selected)) {
    ConfigureCodec(selected_.codec.Get());
    ComPtr<IMFMediaType> output_type = CreateOutputType();
    Check(selected_.transform->SetOutputType(0, output_type.Get(), 0),
          "mft-set-output-type");
    ComPtr<IMFMediaType> input_type = CreateInputType();
    Check(selected_.transform->SetInputType(0, input_type.Get(), 0),
          "mft-set-input-type");
    ValidateMediaTypes(selected_.transform.Get());
    ValidateCodecReadback(selected_.codec.Get());
    Check(selected_.transform->GetOutputStreamInfo(0, &output_info_),
          "mft-output-stream-info");
    Check(selected_.transform->ProcessMessage(
              MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0),
          "mft-begin-streaming");
    Check(selected_.transform->ProcessMessage(
              MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0),
          "mft-start-stream");
    started_ = true;
  }

  LiveEncoder(const LiveEncoder&) = delete;
  LiveEncoder& operator=(const LiveEncoder&) = delete;

  ~LiveEncoder() {
    if (started_) {
      selected_.transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
      selected_.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
    }
  }

  const SelectedTransform& selected() const { return selected_; }

  EncodedAccessUnit Encode(ID3D11Texture2D* texture, UINT64 timestamp100ns,
                           bool force_key_frame) {
    WaitForInput();
    if (force_key_frame) ForceKeyFrame(selected_.codec.Get());
    ComPtr<IMFSample> sample = CreateSurfaceSample(
        texture, static_cast<LONGLONG>(timestamp100ns), kFrameDuration100ns);
    Check(selected_.transform->ProcessInput(0, sample.Get(), 0),
          "mft-process-input");
    --input_requests_;

    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(2);
    while (std::chrono::steady_clock::now() < deadline) {
      MediaEventType type = NextEvent(deadline);
      if (type == METransformNeedInput) {
        ++input_requests_;
        continue;
      }
      if (type != METransformHaveOutput) continue;

      ComPtr<IMFSample> output = PullOutput(selected_.transform.Get(),
                                            output_info_);
      LONGLONG output_time = -1;
      Check(output->GetSampleTime(&output_time), "output-sample-time");
      if (output_time != static_cast<LONGLONG>(timestamp100ns)) {
        Fail("output-order", "hardware MFT changed or reordered a live timestamp");
      }
      std::vector<UINT8> bytes = ReadSample(output.Get());
      NalSummary nal = InspectAnnexB(bytes);
      if (!nal.annex_b) {
        Fail("bitstream-annexb", "live output is not Annex-B H264");
      }
      if (nal.profile_level_id) {
        if (*nal.profile_level_id != "42c01f") {
          Fail("bitstream-profile", "hardware MFT did not emit profile-level-id 42c01f");
        }
        if (profile_level_id_ && *profile_level_id_ != *nal.profile_level_id) {
          Fail("bitstream-profile-change", "hardware MFT changed SPS profile");
        }
        profile_level_id_ = nal.profile_level_id;
      }
      if (force_key_frame && !(nal.sps && nal.pps && nal.idr)) {
        Fail("bitstream-recovery-unit",
             "requested live recovery unit lacks SPS, PPS, or IDR");
      }
      if (!profile_level_id_) {
        Fail("bitstream-sps", "first live access unit did not carry an SPS");
      }
      return EncodedAccessUnit{timestamp100ns, nal.idr, std::move(bytes)};
    }
    Fail("mft-output-timeout", "hardware MFT did not produce live output in time");
  }

 private:
  MediaEventType NextEvent(std::chrono::steady_clock::time_point deadline) {
    while (std::chrono::steady_clock::now() < deadline) {
      ComPtr<IMFMediaEvent> event;
      HRESULT result = selected_.events->GetEvent(MF_EVENT_FLAG_NO_WAIT,
                                                   &event);
      if (result == MF_E_NO_EVENTS_AVAILABLE) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        continue;
      }
      Check(result, "mft-get-event");
      HRESULT status = S_OK;
      Check(event->GetStatus(&status), "mft-event-status-read");
      Check(status, "mft-event-status");
      MediaEventType type = MEUnknown;
      Check(event->GetType(&type), "mft-event-type");
      if (type == MEError) Fail("mft-error-event", "hardware MFT emitted MEError");
      return type;
    }
    Fail("mft-event-timeout", "hardware MFT did not request input in time");
  }

  void WaitForInput() {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(2);
    while (input_requests_ == 0) {
      MediaEventType type = NextEvent(deadline);
      if (type == METransformNeedInput) {
        ++input_requests_;
      } else if (type == METransformHaveOutput) {
        Fail("mft-unexpected-output", "hardware MFT produced output without live input");
      }
    }
  }

  SelectedTransform selected_;
  MFT_OUTPUT_STREAM_INFO output_info_ = {};
  UINT32 input_requests_ = 0;
  std::optional<std::string> profile_level_id_;
  bool started_ = false;
};

class FrameConverter final {
 public:
  explicit FrameConverter(ID3D11Device* device) : device_(device) {
    Check(device_->QueryInterface(IID_PPV_ARGS(&video_device_)),
          "video-processor-device");
    ComPtr<ID3D11DeviceContext> context;
    device_->GetImmediateContext(&context);
    Check(context.As(&video_context_), "video-processor-context");
  }

  ComPtr<ID3D11Texture2D> Convert(ID3D11Texture2D* source, UINT32 width,
                                  UINT32 height) {
    if (source == nullptr || width == 0 || height == 0 ||
        width > 16'384 || height > 16'384) {
      Fail("capture-size", "captured window dimensions are invalid");
    }
    if (!enumerator_ || width != input_width_ || height != input_height_) {
      Configure(width, height);
    }

    D3D11_TEXTURE2D_DESC output_description = {};
    output_description.Width = kWidth;
    output_description.Height = kHeight;
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
    double scale = std::min(static_cast<double>(kWidth) / width,
                            static_cast<double>(kHeight) / height);
    LONG target_width = std::max<LONG>(
        2, static_cast<LONG>(std::llround(width * scale)) & ~1L);
    LONG target_height = std::max<LONG>(
        2, static_cast<LONG>(std::llround(height * scale)) & ~1L);
    target_width = std::min<LONG>(target_width, kWidth);
    target_height = std::min<LONG>(target_height, kHeight);
    LONG left = (static_cast<LONG>(kWidth) - target_width) / 2;
    LONG top = (static_cast<LONG>(kHeight) - target_height) / 2;
    RECT target_rect = {left, top, left + target_width, top + target_height};
    RECT output_rect = {0, 0, static_cast<LONG>(kWidth),
                        static_cast<LONG>(kHeight)};

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
    description.InputFrameRate = {kFrameRate, 1};
    description.InputWidth = width;
    description.InputHeight = height;
    description.OutputFrameRate = {kFrameRate, 1};
    description.OutputWidth = kWidth;
    description.OutputHeight = kHeight;
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

bool ConsumeKeyFrameRequest() {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  DWORD available = 0;
  if (input == INVALID_HANDLE_VALUE || input == nullptr ||
      !PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) ||
      available == 0) {
    return false;
  }
  std::array<BYTE, 64> bytes{};
  DWORD read = 0;
  if (!ReadFile(input, bytes.data(),
                std::min<DWORD>(available, static_cast<DWORD>(bytes.size())),
                &read, nullptr)) {
    return false;
  }
  return std::find(bytes.begin(), bytes.begin() + read,
                   static_cast<BYTE>('K')) != bytes.begin() + read;
}

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

struct ProductArguments final {
  enum class Mode { list, audio, window } mode = Mode::list;
  DWORD pid = 0;
  UINT64 creation_time = 0;
  UINT64 window_handle = 0;
  UINT adapter_index = 0;
  UINT mft_index = 0;
};

ProductArguments ParseProductArguments(int count, wchar_t** values) {
  ProductArguments arguments;
  if (count == 2 && std::wstring(values[1]) == L"--list") return arguments;
  if (count == 4 && std::wstring(values[1]) == L"--capture-audio") {
    arguments.mode = ProductArguments::Mode::audio;
  } else if (count == 10 && std::wstring(values[1]) == L"--capture-window" &&
             std::wstring(values[5]) == L"--adapter-index" &&
             std::wstring(values[7]) == L"--mft-index" &&
             std::wstring(values[9]) == L"--protocol-v1") {
    arguments.mode = ProductArguments::Mode::window;
    arguments.window_handle = ParseUint64(values[4], "argument-window");
    arguments.adapter_index = ParseIndex(values[6], "argument-adapter");
    arguments.mft_index = ParseIndex(values[8], "argument-mft");
  } else {
    Fail("arguments", "unsupported or incomplete command-line argument");
  }
  UINT64 pid = ParseUint64(values[2], "argument-pid");
  if (pid > std::numeric_limits<DWORD>::max()) {
    Fail("argument-pid", "PID is outside the Windows process range");
  }
  arguments.pid = static_cast<DWORD>(pid);
  arguments.creation_time = ParseUint64(values[3], "argument-creation-time");
  return arguments;
}

HRESULT RunAudioCapture(const ProductArguments& arguments) {
  UniqueHandle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (stop.get() == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  ProtocolWriter writer;
  return screener::capture::CaptureProcessAudio(
      arguments.pid, arguments.creation_time, stop.get(),
      [&writer](UINT64 timestamp100ns, const BYTE* data, DWORD size) {
        return writer.Write(OutputKind::pcm, 0, timestamp100ns,
                            screener::capture::kAudioChunkDuration100ns, data,
                            size);
      });
}

void RunWindowCapture(const ProductArguments& arguments) {
  HRESULT identity = screener::capture::ValidateWindowTarget(
      arguments.window_handle, arguments.pid, arguments.creation_time);
  Check(identity, "target-identity");

  std::vector<Adapter> adapters = EnumerateAdapters();
  const Adapter& adapter = SelectAdapter(adapters, arguments.adapter_index);
  DeviceContext device = CreateDevice(adapter);
  ActivationList activations = EnumerateHardwareEncoders(adapter);
  SelectedTransform selected = ActivateTransform(
      activations, arguments.mft_index, device.manager.Get());
  LiveEncoder encoder(std::move(selected));
  FrameConverter converter(device.device.Get());
  ProtocolWriter writer;

  using namespace winrt::Windows::Graphics::Capture;
  using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
  if (!GraphicsCaptureSession::IsSupported()) {
    Fail("capture-support", "Windows Graphics Capture is unavailable");
  }
  UniqueHandle process(OpenProcess(SYNCHRONIZE, FALSE, arguments.pid));
  if (process.get() == nullptr) {
    Check(HRESULT_FROM_WIN32(GetLastError()), "target-process-handle");
  }
  Check(screener::capture::ValidateWindowTarget(
            arguments.window_handle, arguments.pid, arguments.creation_time),
        "target-identity-before-capture");
  HWND window = reinterpret_cast<HWND>(
      static_cast<UINT_PTR>(arguments.window_handle));
  auto capture_device = CreateCaptureDevice(device.device.Get());
  GraphicsCaptureItem item = CreateCaptureItem(window);
  Check(screener::capture::ValidateWindowTarget(
            arguments.window_handle, arguments.pid, arguments.creation_time),
        "target-identity-after-item");
  auto initial_size = item.Size();
  if (initial_size.Width <= 0 || initial_size.Height <= 0) {
    Fail("capture-size", "selected window has no capturable content");
  }
  Direct3D11CaptureFramePool pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      capture_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2,
      initial_size);
  GraphicsCaptureSession capture_session = pool.CreateCaptureSession(item);

  UniqueHandle shutdown(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  UniqueHandle frame_ready(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (shutdown.get() == nullptr || frame_ready.get() == nullptr) {
    Check(HRESULT_FROM_WIN32(GetLastError()), "capture-events");
  }

  std::atomic<LONG> audio_result{S_OK};
  std::atomic<bool> audio_finished{false};
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
  std::thread audio([&]() {
    HRESULT result = screener::capture::CaptureProcessAudio(
        arguments.pid, arguments.creation_time, shutdown.get(),
        [&writer](UINT64 timestamp100ns, const BYTE* data, DWORD size) {
          return writer.Write(OutputKind::pcm, 0, timestamp100ns,
                              screener::capture::kAudioChunkDuration100ns,
                              data, size);
        });
    audio_result.store(result);
    audio_finished.store(true);
    SetEvent(shutdown.get());
  });

  auto cleanup = [&]() noexcept {
    SetEvent(shutdown.get());
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
    if (audio.joinable()) audio.join();
  };

  try {
    std::ostringstream starting;
    starting << "{\"state\":\"starting\",\"hardwareOnly\":true,"
             << "\"adapterIndex\":" << adapter.index
             << ",\"adapterName\":"
             << JSONString(NarrowAscii(adapter.description.Description))
             << ",\"adapterLuid\":"
             << JSONString(LuidString(adapter.description.AdapterLuid))
             << ",\"mftIndex\":" << arguments.mft_index
             << ",\"mftName\":"
             << JSONString(encoder.selected().name)
             << ",\"mftClsid\":"
             << JSONString(encoder.selected().clsid) << '}';
    Check(writer.WriteStatus(starting.str()), "capture-status-starting");
    capture_session.StartCapture();

    UINT64 previous_timestamp = 0;
    UINT64 encoded_frames = 0;
    bool active_status_written = false;
    auto pool_size = initial_size;
    const HANDLE waits[] = {process.get(), shutdown.get(), frame_ready.get()};
    for (;;) {
      DWORD wait = WaitForMultipleObjects(3, waits, FALSE, 5'000);
      if (wait == WAIT_OBJECT_0) {
        Fail("target-exited", "selected target process exited");
      }
      if (wait == WAIT_OBJECT_0 + 1) {
        if (item_closed.load()) {
          Fail("capture-closed", "selected window stopped capture");
        }
        HRESULT result = static_cast<HRESULT>(audio_result.load());
        if (audio_finished.load() && result != HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
          throw GateFailure("process-audio", "target process audio stopped",
                            result);
        }
        Fail("capture-stopped", "window capture stopped");
      }
      if (wait == WAIT_TIMEOUT) {
        Fail("capture-frame-timeout", "selected window produced no frame in five seconds");
      }
      if (wait != WAIT_OBJECT_0 + 2) {
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
      if (previous_timestamp != 0 &&
          timestamp - previous_timestamp <
              static_cast<UINT64>(kFrameDuration100ns) * 19 / 20) {
        continue;
      }
      auto content_size = latest.ContentSize();
      if (content_size.Width <= 0 || content_size.Height <= 0) continue;
      if (content_size.Width != pool_size.Width ||
          content_size.Height != pool_size.Height) {
        latest.Close();
        latest = nullptr;
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
      ComPtr<ID3D11Texture2D> nv12 = converter.Convert(
          source.Get(), content_width, content_height);
      bool requested_key_frame = ConsumeKeyFrameRequest();
      bool key_frame = encoded_frames == 0 || encoded_frames % kGopFrames == 0 ||
                       requested_key_frame;
      EncodedAccessUnit access_unit = encoder.Encode(nv12.Get(), timestamp,
                                                      key_frame);
      if (access_unit.bytes.size() > kMaxProductAccessUnitBytes) {
        Fail("output-buffer-bounds", "live H264 access unit exceeded one MiB");
      }
      UINT64 wire_timestamp = (access_unit.timestamp100ns / 10) * 10;
      Check(writer.Write(OutputKind::h264, access_unit.key_frame ? 1 : 0,
                         wire_timestamp, kEnvelopeFrameDuration100ns,
                         access_unit.bytes.data(),
                         static_cast<DWORD>(access_unit.bytes.size())),
            "capture-video-output");
      previous_timestamp = timestamp;
      ++encoded_frames;
      if (!active_status_written) {
        std::string active =
            "{\"state\":\"active\",\"hardwareOnly\":true,"
            "\"profileLevelId\":\"42c01f\",\"width\":1280,"
            "\"height\":720,\"fps\":30}";
        Check(writer.WriteStatus(active), "capture-status-active");
        active_status_written = true;
      }
    }
  } catch (...) {
    cleanup();
    throw;
  }
}
#endif

#ifdef SCREENER_H264_FIXTURE
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

#ifdef SCREENER_H264_FIXTURE
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

#ifndef SCREENER_H264_FIXTURE
int wmain(int argc, wchar_t** argv) {
  try {
    ProductArguments arguments = ParseProductArguments(argc, argv);
    if (arguments.mode == ProductArguments::Mode::list) {
      return screener::capture::WriteWindowList();
    }
    if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
      Fail("stdout-binary", "could not switch stdout to binary mode");
    }
    if (arguments.mode == ProductArguments::Mode::audio) {
      Check(RunAudioCapture(arguments), "process-audio-capture");
      return 0;
    }
    Runtime runtime;
    RunWindowCapture(arguments);
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
  } catch (const std::exception& error) {
    std::cerr << "result=window-capture-failed\n"
              << "stage=unclassified\n"
              << "detail=" << error.what() << '\n';
    return 3;
  }
}
#endif
