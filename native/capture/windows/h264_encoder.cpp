#include "h264_encoder.h"

#include "capture_output.h"

#include <d3d10_1.h>
#include <evr.h>
#include <mferror.h>
#include <propvarutil.h>

#include <algorithm>
#include <thread>

namespace piik::capture::windows {

namespace {
constexpr DWORD kMaxEncodedSampleBytes = 4 * 1024 * 1024;
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

std::string HexByte(UINT8 value) {
  std::ostringstream output;
  output << std::hex << std::setfill('0') << std::setw(2)
         << static_cast<UINT32>(value);
  return output.str();
}

std::string ProfileLevelId(UINT8 profile, UINT8 constraints, UINT8 level) {
  return HexByte(profile) + HexByte(constraints) + HexByte(level);
}

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

ActivationList EnumerateHardwareEncoders(const Adapter& adapter,
                                         bool require_candidate) {
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
  if (require_candidate && list.count == 0) {
    Fail("mft-hardware-enumeration",
         "selected adapter exposed no hardware NV12-to-H264 MFT");
  }
  return list;
}

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
  selected.activation = activation;
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

void SetOptionalU32(ICodecAPI* codec, const GUID& key, UINT32 value) {
  if (codec->IsSupported(&key) != S_OK) return;
  VARIANT requested;
  VariantInit(&requested);
  requested.vt = VT_UI4;
  requested.ulVal = value;
  (void)codec->SetValue(&key, &requested);
  VariantClear(&requested);
}

void ConfigureCodec(
    ICodecAPI* codec,
    const VideoProfile& profile) {
  SetU32(codec, CODECAPI_AVEncCommonRateControlMode,
         eAVEncCommonRateControlMode_CBR, "codec-cbr");
  SetBool(codec, CODECAPI_AVLowLatencyMode, true, "codec-low-latency");
  SetU32(codec, CODECAPI_AVEncCommonMeanBitRate, profile.bit_rate,
         "codec-mean-bitrate");
  SetU32(codec, CODECAPI_AVEncMPVGOPSize, profile.gop_frames(), "codec-gop");
  SetOptionalU32(codec, CODECAPI_AVEncCommonQualityVsSpeed,
                 profile.quality_vs_speed());
  RequireProperty(codec, CODECAPI_AVEncVideoForceKeyFrame,
                  "codec-force-keyframe");
}

ComPtr<IMFMediaType> CreateOutputType(
    const VideoProfile& profile) {
  ComPtr<IMFMediaType> type;
  Check(MFCreateMediaType(&type), "output-type-create");
  Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
        "output-type-major");
  Check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264),
        "output-type-subtype");
  Check(type->SetUINT32(MF_MT_AVG_BITRATE, profile.bit_rate),
        "output-type-bitrate");
  Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, profile.width,
                           profile.height),
        "output-type-size");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, profile.frame_rate, 1),
        "output-type-framerate");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
        "output-type-pixel-aspect");
  Check(type->SetUINT32(MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive),
        "output-type-interlace");
  Check(type->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base),
        "output-type-profile");
  Check(type->SetUINT32(MF_MT_MPEG2_LEVEL, profile.h264_level()),
        "output-type-level");
  return type;
}

ComPtr<IMFMediaType> CreateInputType(
    const VideoProfile& profile) {
  ComPtr<IMFMediaType> type;
  Check(MFCreateMediaType(&type), "input-type-create");
  Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
        "input-type-major");
  Check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12),
        "input-type-subtype");
  Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, profile.width,
                           profile.height),
        "input-type-size");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, profile.frame_rate, 1),
        "input-type-framerate");
  Check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
        "input-type-pixel-aspect");
  Check(type->SetUINT32(MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive),
        "input-type-interlace");
  Check(type->SetUINT32(MF_MT_DEFAULT_STRIDE, profile.width),
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

void ValidateMediaTypes(
    IMFTransform* transform,
    const VideoProfile& profile) {
  ComPtr<IMFMediaType> output;
  Check(transform->GetOutputCurrentType(0, &output),
        "output-type-current");
  GUID subtype = {};
  Check(output->GetGUID(MF_MT_SUBTYPE, &subtype), "output-type-subtype-readback");
  if (subtype != MFVideoFormat_H264) {
    Fail("output-type-subtype-weakened", "output is not H264");
  }
  RequireTypeU32(output.Get(), MF_MT_AVG_BITRATE, profile.bit_rate,
                 "output-type-bitrate");
  RequireTypeU32(output.Get(), MF_MT_MPEG2_PROFILE,
                 eAVEncH264VProfile_Base, "output-type-profile");
  RequireTypeU32(output.Get(), MF_MT_MPEG2_LEVEL, profile.h264_level(),
                 "output-type-level");

  UINT32 width = 0;
  UINT32 height = 0;
  Check(MFGetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, &width, &height),
        "output-type-size-readback");
  if (width != profile.width || height != profile.height) {
    Fail("output-type-size-weakened", "output dimensions changed");
  }
  UINT32 numerator = 0;
  UINT32 denominator = 0;
  Check(MFGetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, &numerator,
                            &denominator),
        "output-type-framerate-readback");
  if (numerator != profile.frame_rate || denominator != 1) {
    Fail("output-type-framerate-weakened", "output frame rate changed");
  }
}

void ValidateCodecReadback(
    ICodecAPI* codec,
    const VideoProfile& profile) {
  if (ReadU32(codec, CODECAPI_AVEncCommonRateControlMode, "codec-cbr") !=
          eAVEncCommonRateControlMode_CBR ||
      !ReadBool(codec, CODECAPI_AVLowLatencyMode, "codec-low-latency") ||
      ReadU32(codec, CODECAPI_AVEncCommonMeanBitRate,
              "codec-mean-bitrate") != profile.bit_rate ||
      ReadU32(codec, CODECAPI_AVEncMPVGOPSize, "codec-gop") !=
          profile.gop_frames()) {
    Fail("codec-final-readback", "one or more codec properties were weakened");
  }
}

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

void RequireEncoderTime(EncoderClock::time_point deadline) {
  if (EncoderClock::now() >= deadline) {
    Fail("codec-probe-timeout", "native codec selection exceeded its time budget");
  }
}

LiveEncoder::LiveEncoder(
    SelectedTransform selected,
    VideoProfile profile)
    : VideoEncoder(OutputKind::h264, selected.name, selected.clsid),
      selected_(std::move(selected)), profile_(profile) {
  ConfigureCodec(selected_.codec.Get(), profile_);
  ComPtr<IMFMediaType> output_type = CreateOutputType(profile_);
  Check(selected_.transform->SetOutputType(0, output_type.Get(), 0),
        "mft-set-output-type");
  ComPtr<IMFMediaType> input_type = CreateInputType(profile_);
  Check(selected_.transform->SetInputType(0, input_type.Get(), 0),
        "mft-set-input-type");
  ValidateMediaTypes(selected_.transform.Get(), profile_);
  ValidateCodecReadback(selected_.codec.Get(), profile_);
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

LiveEncoder::~LiveEncoder() {
  if (started_) {
    selected_.transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    selected_.transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
  }
}

void LiveEncoder::SetBitrate(UINT32 bitrate) {
  SetU32(selected_.codec.Get(), CODECAPI_AVEncCommonMeanBitRate, bitrate,
         "codec-live-bitrate");
  profile_.bit_rate = bitrate;
}

EncodedAccessUnit LiveEncoder::Encode(
    ID3D11Texture2D* texture, UINT64 timestamp100ns, bool force_key_frame,
    EncoderClock::time_point probe_deadline) {
  WaitForInput(probe_deadline);
  if (force_key_frame) ForceKeyFrame(selected_.codec.Get());
  ComPtr<IMFSample> sample = CreateSurfaceSample(
      texture, static_cast<LONGLONG>(timestamp100ns),
      profile_.frame_duration_100ns());
  Check(selected_.transform->ProcessInput(0, sample.Get(), 0),
        "mft-process-input");
  --input_requests_;

  const auto deadline = std::min(probe_deadline,
      EncoderClock::now() + std::chrono::seconds(2));
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
      if (*nal.profile_level_id != profile_.profile_level_id()) {
        Fail("bitstream-profile", "hardware MFT changed the requested H.264 profile level");
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
    RequireEncoderTime(probe_deadline);
    return EncodedAccessUnit{timestamp100ns, nal.idr && nal.sps && nal.pps,
                             std::move(bytes)};
  }
  Fail("mft-output-timeout", "hardware MFT did not produce live output in time");
}

MediaEventType LiveEncoder::NextEvent(std::chrono::steady_clock::time_point deadline) {
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
  Fail("mft-event-timeout", "hardware MFT event wait timed out");
}

void LiveEncoder::WaitForInput(EncoderClock::time_point probe_deadline) {
  const auto deadline = std::min(probe_deadline,
      EncoderClock::now() + std::chrono::seconds(2));
  while (input_requests_ == 0) {
    MediaEventType type = NextEvent(deadline);
    if (type == METransformNeedInput) {
      ++input_requests_;
    } else if (type == METransformHaveOutput) {
      Fail("mft-unexpected-output", "hardware MFT produced output without live input");
    }
  }
}

}  // namespace piik::capture::windows
