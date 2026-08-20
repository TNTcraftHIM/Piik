#define NOMINMAX
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <fcntl.h>
#include <io.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <wrl/implements.h>

#include <array>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace {
constexpr UINT32 kSampleRate = 48'000;
constexpr UINT16 kChannels = 2;
constexpr UINT16 kBytesPerSample = 2;
constexpr UINT32 kFramesPerChunk = 960;
constexpr DWORD kBytesPerChunk = kFramesPerChunk * kChannels * kBytesPerSample;
constexpr UINT64 kChunkDuration100ns = 200'000;
constexpr size_t kMaxWindows = 100;

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

struct WindowTarget {
  DWORD pid;
  UINT64 creationTime;
  std::string title;
};

HRESULT ReadProcessCreationTime(HANDLE process, UINT64* creationTime) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  ULARGE_INTEGER value{};
  value.LowPart = created.dwLowDateTime;
  value.HighPart = created.dwHighDateTime;
  if (value.QuadPart == 0) return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  *creationTime = value.QuadPart;
  return S_OK;
}

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size) {
    return {};
  }
  return result;
}

std::string JsonString(const std::string& value) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string result = "\"";
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (character < 0x20) {
          result += "\\u00";
          result += hex[character >> 4];
          result += hex[character & 0xf];
        } else {
          result.push_back(static_cast<char>(character));
        }
    }
  }
  result += '"';
  return result;
}

BOOL CALLBACK CollectWindow(HWND window, LPARAM parameter) {
  auto* targets = reinterpret_cast<std::vector<WindowTarget>*>(parameter);
  if (targets->size() >= kMaxWindows) return FALSE;
  if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != nullptr) return TRUE;
  const int length = GetWindowTextLengthW(window);
  if (length <= 0 || length > 512) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0 || pid == GetCurrentProcessId()) return TRUE;
  std::wstring title(static_cast<size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(window, title.data(), length + 1);
  if (copied <= 0) return TRUE;
  title.resize(static_cast<size_t>(copied));
  std::string utf8 = Utf8(title);
  if (utf8.empty()) return TRUE;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return TRUE;
  UINT64 creationTime = 0;
  const HRESULT result = ReadProcessCreationTime(process, &creationTime);
  CloseHandle(process);
  if (SUCCEEDED(result)) targets->push_back({pid, creationTime, std::move(utf8)});
  return TRUE;
}

int ListWindows() {
  std::vector<WindowTarget> targets;
  if (!EnumWindows(CollectWindow, reinterpret_cast<LPARAM>(&targets))) return 2;
  std::cout << '[';
  for (size_t index = 0; index < targets.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << "{\"pid\":" << targets[index].pid << ",\"creationTime\":"
              << targets[index].creationTime << ",\"title\":"
              << JsonString(targets[index].title) << '}';
  }
  std::cout << ']';
  return std::cout.good() ? 0 : 2;
}

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

HRESULT WriteAll(HANDLE output, const BYTE* data, DWORD size) {
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(output, data, size, &written, nullptr) || written == 0) {
      return HRESULT_FROM_WIN32(GetLastError());
    }
    data += written;
    size -= written;
  }
  return S_OK;
}

HRESULT WritePCM(HANDLE output, UINT64 timestamp100ns, const BYTE* data) {
  std::array<BYTE, 28> header{};
  header[0] = 'S'; header[1] = 'P'; header[2] = 'C'; header[3] = 'M';
  header[4] = 1;
  PutUint64BE(header.data() + 8, timestamp100ns);
  PutUint64BE(header.data() + 16, kChunkDuration100ns);
  PutUint32BE(header.data() + 24, kBytesPerChunk);
  HRESULT result = WriteAll(output, header.data(), static_cast<DWORD>(header.size()));
  return SUCCEEDED(result) ? WriteAll(output, data, kBytesPerChunk) : result;
}

HRESULT ActivateProcessLoopback(DWORD pid, HANDLE completed, ComPtr<IAudioClient>* client) {
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

HRESULT Capture(DWORD pid, UINT64 expectedCreationTime) {
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  HANDLE completed = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (completed == nullptr || sampleReady == nullptr) {
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
    if (completed != nullptr) CloseHandle(completed);
    if (sampleReady != nullptr) CloseHandle(sampleReady);
    CloseHandle(process);
    return result;
  }
  UINT64 creationTime = 0;
  HRESULT result = ReadProcessCreationTime(process, &creationTime);
  if (SUCCEEDED(result) && creationTime != expectedCreationTime) {
    result = HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  ComPtr<IAudioClient> client;
  if (SUCCEEDED(result)) result = ActivateProcessLoopback(pid, completed, &client);
  ComPtr<IAudioCaptureClient> capture;
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBytesPerSample * 8;
  format.nBlockAlign = kChannels * kBytesPerSample;
  format.nAvgBytesPerSec = kSampleRate * format.nBlockAlign;
  if (SUCCEEDED(result)) {
    result = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0, 0, &format, nullptr);
  }
  if (SUCCEEDED(result)) result = client->GetService(IID_PPV_ARGS(&capture));
  if (SUCCEEDED(result)) result = client->SetEventHandle(sampleReady);
  if (SUCCEEDED(result)) result = client->Start();

  std::vector<BYTE> pending;
  size_t consumed = 0;
  UINT64 nextTimestamp = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  const HANDLE waits[] = {process, sampleReady};
  while (SUCCEEDED(result)) {
    const DWORD wait = WaitForMultipleObjects(2, waits, FALSE, 1'000);
    if (wait == WAIT_OBJECT_0) {
      result = HRESULT_FROM_WIN32(ERROR_PROCESS_ABORTED);
      break;
    }
    if (wait == WAIT_TIMEOUT) continue;
    if (wait != WAIT_OBJECT_0 + 1) {
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
      while (pending.size() - consumed >= kBytesPerChunk) {
        result = WritePCM(output, nextTimestamp, pending.data() + consumed);
        if (FAILED(result)) break;
        consumed += kBytesPerChunk;
        nextTimestamp += kChunkDuration100ns;
      }
      if (FAILED(result)) break;
      if (consumed > kBytesPerChunk * 4) {
        pending.erase(pending.begin(), pending.begin() + static_cast<ptrdiff_t>(consumed));
        consumed = 0;
      }
    }
  }
  if (client) client->Stop();
  CloseHandle(sampleReady);
  CloseHandle(completed);
  CloseHandle(process);
  return result;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--list") return ListWindows();
  if (argc != 4 || std::wstring(argv[1]) != L"--capture") return 2;
  wchar_t* pidEnd = nullptr;
  const unsigned long parsedPID = wcstoul(argv[2], &pidEnd, 10);
  wchar_t* creationEnd = nullptr;
  const unsigned long long parsedCreationTime = wcstoull(argv[3], &creationEnd, 10);
  if (parsedPID == 0 || pidEnd == argv[2] || *pidEnd != L'\0' ||
      parsedCreationTime == 0 || creationEnd == argv[3] || *creationEnd != L'\0') return 2;
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 2;
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(result)) return 2;
  result = Capture(static_cast<DWORD>(parsedPID), static_cast<UINT64>(parsedCreationTime));
  CoUninitialize();
  if (FAILED(result)) std::cerr << "process_audio_capture_failed hresult=0x" << std::hex << result << '\n';
  return SUCCEEDED(result) ? 0 : 2;
}
