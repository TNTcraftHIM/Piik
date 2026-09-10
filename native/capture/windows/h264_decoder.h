#pragma once

#include "capture_input.h"

#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wmcodecdsp.h>
#include <wrl/client.h>

#include <algorithm>
#include <functional>
#include <stdexcept>
#include <string>
#include <utility>

namespace piik::capture {

// One inbox decoder owns the compressed reference chain. Consumers must finish
// copying/retaining an output sample before the callback returns.
class H264Decoder final {
 public:
  using Consumer = std::function<void(IMFSample*, UINT32, UINT32, LONG)>;

  explicit H264Decoder(IMFDXGIDeviceManager* manager) {
    Check(CoCreateInstance(__uuidof(CMSH264DecoderMFT), nullptr, CLSCTX_INPROC_SERVER,
                           IID_PPV_ARGS(&decoder_)), "create");
    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    Check(decoder_->GetAttributes(&attributes), "attributes");
    UINT32 aware = FALSE;
    if (manager && SUCCEEDED(attributes->GetUINT32(MF_SA_D3D11_AWARE, &aware)) && aware) {
      Check(decoder_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
              reinterpret_cast<ULONG_PTR>(manager)), "device-manager");
    }
    Microsoft::WRL::ComPtr<ICodecAPI> codec;
    Check(decoder_.As(&codec), "codec-api");
    for (const auto& setting : {
             std::pair<GUID, ULONG>{CODECAPI_AVLowLatencyMode, TRUE},
             std::pair<GUID, ULONG>{CODECAPI_AVDecVideoMaxCodedWidth, 2560},
             std::pair<GUID, ULONG>{CODECAPI_AVDecVideoMaxCodedHeight, 1440}}) {
      VARIANT value;
      VariantInit(&value);
      value.vt = VT_UI4;
      value.ulVal = setting.second;
      Check(codec->SetValue(&setting.first, &value), "codec-setting");
    }
  }

  ~H264Decoder() {
    if (configured_) (void)decoder_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  }
  H264Decoder(const H264Decoder&) = delete;
  H264Decoder& operator=(const H264Decoder&) = delete;

  void Decode(const InputEnvelope& input, const Consumer& consume) {
    if (input.kind != 2 || input.data.empty() || input.data.size() > 4 * 1024 * 1024)
      throw std::runtime_error("Invalid H264 decoder input");
    if (!configured_) {
      if (!input.recovery) throw std::runtime_error("H264 decoder needs an independent recovery input");
      Microsoft::WRL::ComPtr<IMFMediaType> type;
      Check(MFCreateMediaType(&type), "input-type");
      Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "input-major");
      Check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264), "input-subtype");
      Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, input.width, input.height), "input-size");
      Check(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "input-progressive");
      Check(decoder_->SetInputType(0, type.Get(), 0), "set-input");
      SelectOutput();
      Check(decoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "begin");
      Check(decoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "start");
      configured_ = true;
    }
    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(static_cast<DWORD>(input.data.size()), &buffer), "input-buffer");
    BYTE* bytes = nullptr;
    Check(buffer->Lock(&bytes, nullptr, nullptr), "input-lock");
    std::copy(input.data.begin(), input.data.end(), bytes);
    Check(buffer->Unlock(), "input-unlock");
    Check(buffer->SetCurrentLength(static_cast<DWORD>(input.data.size())), "input-length");
    Microsoft::WRL::ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "input-sample");
    Check(sample->AddBuffer(buffer.Get()), "input-sample-buffer");
    Check(sample->SetSampleTime(static_cast<LONGLONG>(input.timestamp)), "input-timestamp");
    Check(sample->SetSampleDuration(static_cast<LONGLONG>(input.duration)), "input-duration");
    HRESULT result = decoder_->ProcessInput(0, sample.Get(), 0);
    if (result == MF_E_NOTACCEPTING) {
      Drain(consume);
      result = decoder_->ProcessInput(0, sample.Get(), 0);
    }
    Check(result, "process-input");
    Drain(consume);
  }

 private:
  static void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) throw std::runtime_error(std::string("H264 decoder ") + operation + " failed");
  }

  void SelectOutput() {
    for (DWORD index = 0; index < 64; ++index) {
      Microsoft::WRL::ComPtr<IMFMediaType> type;
      const HRESULT result = decoder_->GetOutputAvailableType(0, index, &type);
      if (result == MF_E_NO_MORE_TYPES) break;
      Check(result, "output-type");
      GUID subtype{};
      Check(type->GetGUID(MF_MT_SUBTYPE, &subtype), "output-subtype");
      if (subtype != MFVideoFormat_NV12) continue;
      UINT32 width = 0, height = 0;
      Check(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height), "output-size");
      if (width < 2 || height < 2 || width > 2560 || height > 1440 || (width & 1) || (height & 1)) {
        throw std::runtime_error("H264 decoder output dimensions exceed the source bound");
      }
      Check(decoder_->SetOutputType(0, type.Get(), 0), "set-output");
      UINT32 stride = 0;
      if (FAILED(type->GetUINT32(MF_MT_DEFAULT_STRIDE, &stride))) {
        LONG fallback = 0;
        Check(MFGetStrideForBitmapInfoHeader(MFVideoFormat_NV12.Data1, width, &fallback), "output-stride");
        stride = static_cast<UINT32>(fallback);
      }
      if (static_cast<LONG>(stride) < static_cast<LONG>(width)) throw std::runtime_error("H264 decoder returned an invalid NV12 stride");
      width_ = width;
      height_ = height;
      stride_ = static_cast<LONG>(stride);
      return;
    }
    throw std::runtime_error("H264 decoder has no NV12 output");
  }

  void Drain(const Consumer& consume) {
    for (unsigned iteration = 0; iteration < 64; ++iteration) {
      MFT_OUTPUT_STREAM_INFO info{};
      Check(decoder_->GetOutputStreamInfo(0, &info), "output-info");
      Microsoft::WRL::ComPtr<IMFSample> owned;
      if (!(info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES))) {
        const DWORD expected = static_cast<DWORD>(stride_) * height_ * 3 / 2;
        const DWORD size = std::max(info.cbSize, expected);
        if (size > 2560 * 1440 * 2) throw std::runtime_error("H264 decoder output allocation exceeds its bound");
        Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
        Check(MFCreateAlignedMemoryBuffer(size, info.cbAlignment ? info.cbAlignment - 1 : 0, &buffer), "output-buffer");
        Check(MFCreateSample(&owned), "output-sample");
        Check(owned->AddBuffer(buffer.Get()), "output-sample-buffer");
      }
      MFT_OUTPUT_DATA_BUFFER output{};
      output.pSample = owned.Get();
      DWORD status = 0;
      const HRESULT result = decoder_->ProcessOutput(0, 1, &output, &status);
      Microsoft::WRL::ComPtr<IMFCollection> events;
      events.Attach(output.pEvents);
      if (!owned) owned.Attach(output.pSample);
      if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) return;
      if (result == MF_E_TRANSFORM_STREAM_CHANGE) {
        SelectOutput();
        continue;
      }
      Check(result, "process-output");
      if (owned && !(output.dwStatus & MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE)) {
        consume(owned.Get(), width_, height_, stride_);
      }
    }
    throw std::runtime_error("H264 decoder exceeded its bounded output pump");
  }

  Microsoft::WRL::ComPtr<IMFTransform> decoder_;
  UINT32 width_ = 0;
  UINT32 height_ = 0;
  LONG stride_ = 0;
  bool configured_ = false;
};

}  // namespace piik::capture
