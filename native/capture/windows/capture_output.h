#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <mutex>
#include <string>

namespace piik::capture {

constexpr DWORD kMaxProductAccessUnitBytes = 4 * 1024 * 1024;
constexpr DWORD kMaxStatusBytes = 4 * 1024;
enum class OutputKind : UINT8 { pcm = 1, h264 = 2, status = 3, vp8 = 4, begin = 5, unavailable = 6 };

// The caller owns the handle. One lock keeps each SMED envelope contiguous.
class ProtocolWriter final {
 public:
  explicit ProtocolWriter(HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE)) : output_(output) {}
  void Stop() { stopped_.store(true); }

  HRESULT Write(OutputKind kind, UINT8 flags, UINT64 timestamp100ns,
                UINT64 duration100ns, const BYTE* data, DWORD size,
                UINT8 layer = 0, UINT16 width = 0, UINT16 height = 0) {
    const bool diagnostic = kind == OutputKind::status || kind == OutputKind::unavailable;
    const DWORD maximum = diagnostic ? kMaxStatusBytes : kMaxProductAccessUnitBytes;
    if (size > maximum || (kind == OutputKind::begin ? size != 0 : data == nullptr || size == 0) ||
        (!diagnostic && duration100ns == 0)) return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
    std::array<BYTE, 32> header{'S', 'M', 'E', 'D', 2, static_cast<BYTE>(kind), flags, layer};
    PutBE(header.data() + 8, timestamp100ns, 8);
    PutBE(header.data() + 16, duration100ns, 8);
    PutBE(header.data() + 24, width, 2);
    PutBE(header.data() + 26, height, 2);
    PutBE(header.data() + 28, size, 4);
    std::lock_guard<std::mutex> lock(mutex_);
    const HRESULT result = WriteAll(header.data(), static_cast<DWORD>(header.size()));
    return SUCCEEDED(result) ? WriteAll(data, size) : result;
  }

  HRESULT WriteStatus(const std::string& value) {
    return Write(OutputKind::status, 0, 0, 0, reinterpret_cast<const BYTE*>(value.data()),
                 static_cast<DWORD>(value.size()));
  }

  HRESULT WriteBegin(UINT64 timestamp100ns, UINT64 duration100ns) {
    return Write(OutputKind::begin, 0, timestamp100ns, duration100ns, nullptr, 0);
  }

  HRESULT WriteUnavailable(UINT8 layer, std::string detail) {
    detail.resize(std::min<size_t>(detail.size(), kMaxStatusBytes));
    for (char& value : detail) {
      if (static_cast<unsigned char>(value) < 32 || static_cast<unsigned char>(value) > 126) value = '?';
    }
    if (detail.empty()) detail = "Output encoder is unavailable";
    return Write(OutputKind::unavailable, 0, 0, 0, reinterpret_cast<const BYTE*>(detail.data()),
                 static_cast<DWORD>(detail.size()), layer);
  }

 private:
  static void PutBE(BYTE* output, UINT64 value, int size) {
    for (int index = size - 1; index >= 0; --index) {
      output[index] = static_cast<BYTE>(value & 0xff);
      value >>= 8;
    }
  }

  HRESULT WriteAll(const BYTE* data, DWORD size) {
    while (size > 0) {
      if (stopped_.load()) return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
      DWORD written = 0;
      if (!WriteFile(output_, data, size, &written, nullptr)) return HRESULT_FROM_WIN32(GetLastError());
      if (written == 0) return HRESULT_FROM_WIN32(ERROR_WRITE_FAULT);
      data += written;
      size -= written;
    }
    return S_OK;
  }

  const HANDLE output_;
  std::mutex mutex_;
  std::atomic<bool> stopped_{false};
};

}  // namespace piik::capture
