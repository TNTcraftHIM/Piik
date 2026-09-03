#define NOMINMAX
#include <windows.h>

#include "capture_target.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace screener::capture {
namespace {

constexpr size_t kMaxSources = 100;
constexpr LONG kPreviewWidth = 160;
constexpr LONG kPreviewHeight = 90;
constexpr DWORD kBitmapHeaderBytes = 54;

struct SourceTarget {
  TargetKind kind;
  UINT64 source_id;
  DWORD pid;
  UINT64 creation_time;
  std::string title;
  bool primary;
};

HRESULT ReadProcessCreationTime(HANDLE process, UINT64* creation_time) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  ULARGE_INTEGER value{};
  value.LowPart = created.dwLowDateTime;
  value.HighPart = created.dwHighDateTime;
  if (value.QuadPart == 0) return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  *creation_time = value.QuadPart;
  return S_OK;
}

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), size,
                          nullptr, nullptr) != size) {
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
  auto* targets = reinterpret_cast<std::vector<SourceTarget>*>(parameter);
  if (targets->size() >= kMaxSources) return FALSE;
  if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != nullptr) {
    return TRUE;
  }
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
  HANDLE process =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return TRUE;
  UINT64 creation_time = 0;
  const HRESULT result = ReadProcessCreationTime(process, &creation_time);
  CloseHandle(process);
  if (SUCCEEDED(result)) {
    targets->push_back({
        TargetKind::window,
        static_cast<UINT64>(reinterpret_cast<UINT_PTR>(window)), pid,
        creation_time, std::move(utf8), false});
  }
  return TRUE;
}

BOOL CALLBACK CollectDisplay(HMONITOR monitor, HDC, LPRECT, LPARAM parameter) {
  auto* targets = reinterpret_cast<std::vector<SourceTarget>*>(parameter);
  if (targets->size() >= kMaxSources) return FALSE;
  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return TRUE;
  std::string title = Utf8(info.szDevice);
  if (title.empty()) return TRUE;
  targets->push_back({
      TargetKind::display,
      static_cast<UINT64>(reinterpret_cast<UINT_PTR>(monitor)), 0, 0,
      std::move(title), (info.dwFlags & MONITORINFOF_PRIMARY) != 0});
  return TRUE;
}

void PutUint16LE(BYTE* output, UINT16 value) {
  output[0] = static_cast<BYTE>(value & 0xff);
  output[1] = static_cast<BYTE>((value >> 8) & 0xff);
}

void PutUint32LE(BYTE* output, UINT32 value) {
  for (size_t index = 0; index < 4; ++index) {
    output[index] = static_cast<BYTE>(value & 0xff);
    value >>= 8;
  }
}

HRESULT SourceRect(TargetKind kind, UINT64 source_id, RECT* rect) {
  if (rect == nullptr || source_id == 0 ||
      source_id > static_cast<UINT64>(
                      std::numeric_limits<UINT_PTR>::max())) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  if (kind == TargetKind::window) {
    HWND window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(source_id));
    if (!IsWindow(window) || IsIconic(window) || !GetWindowRect(window, rect)) {
      return HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE);
    }
    return S_OK;
  }
  HMONITOR monitor =
      reinterpret_cast<HMONITOR>(static_cast<UINT_PTR>(source_id));
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_MONITOR_HANDLE);
  }
  *rect = info.rcMonitor;
  return S_OK;
}

HRESULT CapturePreview(TargetKind kind, UINT64 source_id,
                       std::vector<BYTE>* output) {
  RECT source{};
  HRESULT result = SourceRect(kind, source_id, &source);
  if (FAILED(result)) return result;
  const LONG source_width = source.right - source.left;
  const LONG source_height = source.bottom - source.top;
  if (source_width <= 0 || source_height <= 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }

  HDC screen = GetDC(nullptr);
  if (screen == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  HDC target = CreateCompatibleDC(screen);
  if (target == nullptr) {
    result = HRESULT_FROM_WIN32(GetLastError());
    ReleaseDC(nullptr, screen);
    return result;
  }
  BITMAPINFO bitmap{};
  bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap.bmiHeader.biWidth = kPreviewWidth;
  bitmap.bmiHeader.biHeight = -kPreviewHeight;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  bitmap.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  HBITMAP image = CreateDIBSection(screen, &bitmap, DIB_RGB_COLORS, &pixels,
                                   nullptr, 0);
  if (image == nullptr || pixels == nullptr) {
    result = HRESULT_FROM_WIN32(GetLastError());
    if (image != nullptr) DeleteObject(image);
    DeleteDC(target);
    ReleaseDC(nullptr, screen);
    return result;
  }
  HGDIOBJ previous = SelectObject(target, image);
  RECT background{0, 0, kPreviewWidth, kPreviewHeight};
  FillRect(target, &background, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));

  const double scale = std::min(
      static_cast<double>(kPreviewWidth) / source_width,
      static_cast<double>(kPreviewHeight) / source_height);
  const LONG width = std::max<LONG>(1, static_cast<LONG>(source_width * scale));
  const LONG height =
      std::max<LONG>(1, static_cast<LONG>(source_height * scale));
  const LONG left = (kPreviewWidth - width) / 2;
  const LONG top = (kPreviewHeight - height) / 2;
  SetStretchBltMode(target, HALFTONE);
  SetBrushOrgEx(target, 0, 0, nullptr);
  if (!StretchBlt(target, left, top, width, height, screen, source.left,
                  source.top, source_width, source_height,
                  SRCCOPY | CAPTUREBLT)) {
    result = HRESULT_FROM_WIN32(GetLastError());
  }

  if (SUCCEEDED(result)) {
    constexpr UINT32 row_bytes = static_cast<UINT32>(kPreviewWidth) * 3;
    constexpr UINT32 pixel_bytes = row_bytes * kPreviewHeight;
    output->assign(kBitmapHeaderBytes + pixel_bytes, 0);
    BYTE* bytes = output->data();
    bytes[0] = 'B';
    bytes[1] = 'M';
    PutUint32LE(bytes + 2, static_cast<UINT32>(output->size()));
    PutUint32LE(bytes + 10, kBitmapHeaderBytes);
    PutUint32LE(bytes + 14, 40);
    PutUint32LE(bytes + 18, static_cast<UINT32>(kPreviewWidth));
    PutUint32LE(bytes + 22, static_cast<UINT32>(-kPreviewHeight));
    PutUint16LE(bytes + 26, 1);
    PutUint16LE(bytes + 28, 24);
    PutUint32LE(bytes + 34, pixel_bytes);
    const auto* bgra = static_cast<const BYTE*>(pixels);
    BYTE* bgr = bytes + kBitmapHeaderBytes;
    for (LONG index = 0; index < kPreviewWidth * kPreviewHeight; ++index) {
      bgr[index * 3] = bgra[index * 4];
      bgr[index * 3 + 1] = bgra[index * 4 + 1];
      bgr[index * 3 + 2] = bgra[index * 4 + 2];
    }
  }

  SelectObject(target, previous);
  DeleteObject(image);
  DeleteDC(target);
  ReleaseDC(nullptr, screen);
  return result;
}

}  // namespace

int WriteSourceList() {
  std::vector<SourceTarget> targets;
  if (!EnumDisplayMonitors(nullptr, nullptr, CollectDisplay,
                           reinterpret_cast<LPARAM>(&targets)) ||
      !EnumWindows(CollectWindow, reinterpret_cast<LPARAM>(&targets))) {
    return 2;
  }
  std::stable_sort(targets.begin(), targets.end(),
                   [](const SourceTarget& left, const SourceTarget& right) {
                     if (left.kind != right.kind) {
                       return left.kind == TargetKind::display;
                     }
                     if (left.primary != right.primary) return left.primary;
                     return left.title < right.title;
                   });
  std::cout << '[';
  for (size_t index = 0; index < targets.size(); ++index) {
    if (index != 0) std::cout << ',';
    const SourceTarget& target = targets[index];
    std::cout << "{\"kind\":\""
              << (target.kind == TargetKind::display ? "display" : "window")
              << "\",\"sourceId\":\"" << target.source_id << '\"';
    if (target.kind == TargetKind::window) {
      std::cout << ",\"pid\":" << target.pid << ",\"creationTime\":\""
                << target.creation_time << '\"';
    }
    std::cout << ",\"title\":" << JsonString(target.title) << '}';
  }
  std::cout << ']';
  return std::cout.good() ? 0 : 2;
}

HRESULT WriteSourcePreview(TargetKind kind, UINT64 source_id, DWORD pid,
                           UINT64 expected_creation_time) {
  HRESULT result = kind == TargetKind::window
                       ? ValidateWindowTarget(source_id, pid,
                                              expected_creation_time)
                       : ValidateDisplayTarget(source_id);
  if (FAILED(result)) return result;
  std::vector<BYTE> bitmap;
  result = CapturePreview(kind, source_id, &bitmap);
  if (FAILED(result)) return result;
  DWORD written = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!WriteFile(output, bitmap.data(), static_cast<DWORD>(bitmap.size()),
                 &written, nullptr) || written != bitmap.size()) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  return S_OK;
}

HRESULT ValidateProcessTarget(DWORD pid, UINT64 expected_creation_time) {
  if (pid == 0 || expected_creation_time == 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  UINT64 actual_creation_time = 0;
  HRESULT result = ReadProcessCreationTime(process, &actual_creation_time);
  CloseHandle(process);
  if (SUCCEEDED(result) && actual_creation_time != expected_creation_time) {
    result = HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  return result;
}

HRESULT ValidateWindowTarget(UINT64 source_id, DWORD pid,
                             UINT64 expected_creation_time) {
  if (source_id == 0 ||
      source_id >
          static_cast<UINT64>(std::numeric_limits<UINT_PTR>::max())) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  HWND window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(source_id));
  DWORD window_pid = 0;
  if (!IsWindow(window) || GetWindowThreadProcessId(window, &window_pid) == 0 ||
      window_pid != pid) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE);
  }
  return ValidateProcessTarget(pid, expected_creation_time);
}

HRESULT ValidateDisplayTarget(UINT64 source_id) {
  if (source_id == 0 ||
      source_id >
          static_cast<UINT64>(std::numeric_limits<UINT_PTR>::max())) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  HMONITOR monitor =
      reinterpret_cast<HMONITOR>(static_cast<UINT_PTR>(source_id));
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  return GetMonitorInfoW(monitor, &info)
             ? S_OK
             : HRESULT_FROM_WIN32(ERROR_INVALID_MONITOR_HANDLE);
}

}  // namespace screener::capture
