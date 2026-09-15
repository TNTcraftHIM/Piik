#define NOMINMAX
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <fcntl.h>
#include <io.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <wrl/implements.h>

#include "capture_target.h"
#include "process_audio.h"

#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace piik::capture {
namespace {
class ActivationHandler final : public RuntimeClass<
    RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  explicit ActivationHandler(HANDLE completed) : completed_(completed) {}

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    ComPtr<IUnknown> activated;
    HRESULT activationResult = E_UNEXPECTED;
    result_ = operation->GetActivateResult(&activationResult, &activated);
    if (SUCCEEDED(result_)) result_ = activationResult;
    if (SUCCEEDED(result_)) result_ = activated.As(&client_);
    SetEvent(completed_);
    return S_OK;
  }

  HRESULT Result() const { return result_; }
  ComPtr<IAudioClient> Client() const { return client_; }

 private:
  HANDLE completed_ = nullptr;
  HRESULT result_ = E_UNEXPECTED;
  ComPtr<IAudioClient> client_;
};

HRESULT ActivateProcessLoopback(DWORD pid, HANDLE completed,
                                ComPtr<IAudioClient>* client) {
  AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
  parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  parameters.ProcessLoopbackParams.TargetProcessId = pid;
  parameters.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT variant{};
  variant.vt = VT_BLOB;
  variant.blob.cbSize = sizeof(parameters);
  variant.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);

  auto handler = Make<ActivationHandler>(completed);
  if (!handler) return E_OUTOFMEMORY;
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT result = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                                __uuidof(IAudioClient), &variant,
                                                handler.Get(), &operation);
  if (FAILED(result)) return result;
  if (WaitForSingleObject(completed, 10'000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
  result = handler->Result();
  if (SUCCEEDED(result)) *client = handler->Client();
  return result;
}

HRESULT ActivateSystemLoopback(ComPtr<IAudioClient>* client) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT result = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                    CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  ComPtr<IMMDevice> device;
  if (SUCCEEDED(result)) {
    result = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  }
  if (SUCCEEDED(result)) {
    result = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(client->GetAddressOf()));
  }
  return result;
}

HRESULT CaptureLoopbackAudio(ComPtr<IAudioClient> client, HANDLE process,
                             HANDLE stop_event, const StopProbe& stop_probe,
                             const ReadyWriter& ready_writer,
                             const PCMWriter& writer) {
  if (stop_event == nullptr || !stop_probe || !ready_writer || !writer) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (sampleReady == nullptr) {
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
    return result;
  }
  HRESULT result = S_OK;
  ComPtr<IAudioCaptureClient> capture;
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kAudioChannels;
  format.nSamplesPerSec = kAudioSampleRate;
  format.wBitsPerSample = kAudioBytesPerSample * 8;
  format.nBlockAlign = kAudioChannels * kAudioBytesPerSample;
  format.nAvgBytesPerSec = kAudioSampleRate * format.nBlockAlign;
  if (SUCCEEDED(result)) {
    result = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0, 0, &format, nullptr);
  }
  if (SUCCEEDED(result)) result = client->GetService(IID_PPV_ARGS(&capture));
  if (SUCCEEDED(result)) result = client->SetEventHandle(sampleReady);
  if (SUCCEEDED(result)) result = client->Start();
  if (SUCCEEDED(result)) result = ready_writer();
  if (SUCCEEDED(result)) {
    std::array<BYTE, kAudioBytesPerChunk> silence{};
    result = writer(0, silence.data(), static_cast<DWORD>(silence.size()));
  }

  std::vector<BYTE> pending;
  size_t consumed = 0;
  UINT64 nextTimestamp = 0;
  const HANDLE process_waits[] = {process, sampleReady, stop_event};
  const HANDLE system_waits[] = {sampleReady, stop_event};
  while (SUCCEEDED(result)) {
    if (stop_probe()) {
      result = S_OK;
      break;
    }
    const DWORD wait = process != nullptr
                           ? WaitForMultipleObjects(3, process_waits, FALSE,
                                                    1'000)
                           : WaitForMultipleObjects(2, system_waits, FALSE,
                                                    1'000);
    if (process != nullptr && wait == WAIT_OBJECT_0) {
      result = HRESULT_FROM_WIN32(ERROR_PROCESS_ABORTED);
      break;
    }
    if (wait == WAIT_TIMEOUT) continue;
    const DWORD sample_index = process != nullptr ? WAIT_OBJECT_0 + 1
                                                  : WAIT_OBJECT_0;
    const DWORD stop_index = process != nullptr ? WAIT_OBJECT_0 + 2
                                                : WAIT_OBJECT_0 + 1;
    if (wait == stop_index) {
      result = S_OK;
      break;
    }
    if (wait != sample_index) {
      result = HRESULT_FROM_WIN32(GetLastError());
      break;
    }
    UINT32 frames = 0;
    while (SUCCEEDED(result = capture->GetNextPacketSize(&frames)) && frames > 0) {
      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition = 0;
      result = capture->GetBuffer(&data, &frames, &flags, &devicePosition, &qpcPosition);
      if (FAILED(result)) break;
      const size_t bytes = static_cast<size_t>(frames) * format.nBlockAlign;
      if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0) {
        capture->ReleaseBuffer(frames);
        continue;
      }
      if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
        pending.clear();
        consumed = 0;
      }
      if (pending.size() == consumed) {
        pending.clear();
        consumed = 0;
        nextTimestamp = qpcPosition;
      }
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
        pending.insert(pending.end(), bytes, 0);
      } else {
        pending.insert(pending.end(), data, data + bytes);
      }
      capture->ReleaseBuffer(frames);
      while (pending.size() - consumed >= kAudioBytesPerChunk) {
        result = writer(nextTimestamp, pending.data() + consumed,
                        kAudioBytesPerChunk);
        if (FAILED(result)) break;
        consumed += kAudioBytesPerChunk;
        nextTimestamp += kAudioChunkDuration100ns;
      }
      if (FAILED(result)) break;
      if (consumed > kAudioBytesPerChunk * 4) {
        pending.erase(pending.begin(), pending.begin() + static_cast<ptrdiff_t>(consumed));
        consumed = 0;
      }
    }
  }
  if (client) client->Stop();
  CloseHandle(sampleReady);
  return result;
}

}  // namespace

bool ProcessAudioAvailable() {
  HANDLE completed = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (completed == nullptr) return false;
  ComPtr<IAudioClient> client;
  const HRESULT result =
      ActivateProcessLoopback(GetCurrentProcessId(), completed, &client);
  CloseHandle(completed);
  return SUCCEEDED(result) && client != nullptr;
}

bool SystemAudioAvailable() {
  ComPtr<IAudioClient> client;
  return SUCCEEDED(ActivateSystemLoopback(&client)) && client != nullptr;
}

HRESULT CaptureProcessAudio(DWORD pid, UINT64 expectedCreationTime,
                            HANDLE stop_event, const StopProbe& stop_probe,
                            const ReadyWriter& ready_writer,
                            const PCMWriter& writer) {
  HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com_result)) return com_result;
  HRESULT result = ValidateProcessTarget(pid, expectedCreationTime);
  HANDLE process = nullptr;
  HANDLE completed = nullptr;
  ComPtr<IAudioClient> client;
  if (SUCCEEDED(result)) {
    process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (process == nullptr) result = HRESULT_FROM_WIN32(GetLastError());
  }
  if (SUCCEEDED(result)) {
    completed = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (completed == nullptr) result = HRESULT_FROM_WIN32(GetLastError());
  }
  if (SUCCEEDED(result)) {
    result = ActivateProcessLoopback(pid, completed, &client);
  }
  if (SUCCEEDED(result)) {
    result = CaptureLoopbackAudio(client, process, stop_event, stop_probe,
                                  ready_writer, writer);
  }
  if (completed != nullptr) CloseHandle(completed);
  if (process != nullptr) CloseHandle(process);
  client.Reset();
  CoUninitialize();
  return result;
}

HRESULT CaptureSystemAudio(HANDLE stop_event, const StopProbe& stop_probe,
                           const ReadyWriter& ready_writer,
                           const PCMWriter& writer) {
  HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com_result)) return com_result;
  ComPtr<IAudioClient> client;
  HRESULT result = ActivateSystemLoopback(&client);
  if (SUCCEEDED(result)) {
    result = CaptureLoopbackAudio(client, nullptr, stop_event, stop_probe,
                                  ready_writer, writer);
  }
  client.Reset();
  CoUninitialize();
  return result;
}

}  // namespace piik::capture
