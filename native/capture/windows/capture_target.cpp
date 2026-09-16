#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>
#include <wrl/client.h>

#include "capture_target.h"
#include "capture_border.h"
#include "capture_geometry.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace piik::capture {
namespace {

using Microsoft::WRL::ComPtr;

constexpr size_t kMaxSources = 100;
constexpr LONG kPreviewWidth = 320;
constexpr LONG kPreviewHeight = 180;
constexpr LONG kMaxPreviewSourceDimension = 2'048;
constexpr DWORD kBitmapHeaderBytes = 54;
constexpr wchar_t kPreviewWindowClass[] = L"PiikPreviewWindow";

SIZE ReadDisplayPresentation(const wchar_t* device_name, SIZE captured) {
  UINT32 path_count = 0;
  UINT32 mode_count = 0;
  constexpr UINT32 flags = QDC_ONLY_ACTIVE_PATHS;
  if (GetDisplayConfigBufferSizes(flags, &path_count, &mode_count) !=
      ERROR_SUCCESS) return captured;
  std::vector<DISPLAYCONFIG_PATH_INFO> paths(path_count);
  std::vector<DISPLAYCONFIG_MODE_INFO> modes(mode_count);
  if (QueryDisplayConfig(flags, &path_count, paths.data(), &mode_count,
                         modes.data(), nullptr) != ERROR_SUCCESS) return captured;

  const DISPLAYCONFIG_PATH_INFO* matched = nullptr;
  for (UINT32 index = 0; index < path_count; ++index) {
    const auto& path = paths[index];
    DISPLAYCONFIG_SOURCE_DEVICE_NAME name{};
    name.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(name),
                   path.sourceInfo.adapterId, path.sourceInfo.id};
    if (DisplayConfigGetDeviceInfo(&name.header) != ERROR_SUCCESS) return captured;
    if (wcscmp(name.viewGdiDeviceName, device_name) != 0) continue;
    // A cloned desktop has no single physical presentation to reproduce.
    if (matched != nullptr) return captured;
    matched = &path;
  }
  if (matched == nullptr ||
      !matched->targetInfo.targetAvailable ||
      (matched->flags & DISPLAYCONFIG_PATH_SUPPORT_VIRTUAL_MODE) != 0 ||
      matched->sourceInfo.modeInfoIdx >= mode_count ||
      matched->targetInfo.modeInfoIdx >= mode_count) return captured;
  const auto& source = modes[matched->sourceInfo.modeInfoIdx];
  const auto& target = modes[matched->targetInfo.modeInfoIdx];
  const auto same_adapter = [](LUID first, LUID second) {
    return first.HighPart == second.HighPart && first.LowPart == second.LowPart;
  };
  if (source.infoType != DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE ||
      target.infoType != DISPLAYCONFIG_MODE_INFO_TYPE_TARGET ||
      source.id != matched->sourceInfo.id || target.id != matched->targetInfo.id ||
      !same_adapter(source.adapterId, matched->sourceInfo.adapterId) ||
      !same_adapter(target.adapterId, matched->targetInfo.adapterId)) return captured;
  const auto active = target.targetMode.targetVideoSignalInfo.activeSize;
  return DisplayedFrameSize(
      captured,
      {static_cast<LONG>(source.sourceMode.width),
       static_cast<LONG>(source.sourceMode.height)},
      {static_cast<LONG>(active.cx), static_cast<LONG>(active.cy)},
      matched->targetInfo.scaling, matched->targetInfo.rotation);
}

ATOM EnsurePreviewWindowClass() {
  static ATOM atom = [] {
    WNDCLASSEXW window_class{};
    window_class.cbSize = sizeof(window_class);
    window_class.lpfnWndProc = DefWindowProcW;
    window_class.hInstance = GetModuleHandleW(nullptr);
    window_class.lpszClassName = kPreviewWindowClass;
    return RegisterClassExW(&window_class);
  }();
  return atom;
}

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
  const LONG_PTR extended_style = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if ((extended_style & WS_EX_TOOLWINDOW) != 0 ||
      (extended_style & WS_EX_NOACTIVATE) != 0) {
    return TRUE;
  }
  BOOL cloaked = FALSE;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked,
                                      sizeof(cloaked))) &&
      cloaked != FALSE) {
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
    if (!IsWindow(window) || !GetWindowRect(window, rect)) {
      return HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE);
    }
    // A minimized window's screen rectangle is the taskbar icon. Its normal
    // placement is the useful geometry for a one-shot thumbnail request.
    WINDOWPLACEMENT placement{};
    placement.length = sizeof(placement);
    if (GetWindowPlacement(window, &placement) &&
        (placement.showCmd == SW_SHOWMINIMIZED || IsIconic(window)) &&
        placement.rcNormalPosition.right > placement.rcNormalPosition.left &&
        placement.rcNormalPosition.bottom > placement.rcNormalPosition.top) {
      *rect = placement.rcNormalPosition;
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

HRESULT WriteBitmapPreview(HDC source, LONG source_width, LONG source_height,
                           std::vector<BYTE>* output) {
  if (source == nullptr || output == nullptr || source_width <= 0 ||
      source_height <= 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  HDC screen = GetDC(nullptr);
  if (screen == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  HDC target = CreateCompatibleDC(screen);
  if (target == nullptr) {
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
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
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
    if (image != nullptr) DeleteObject(image);
    DeleteDC(target);
    ReleaseDC(nullptr, screen);
    return result;
  }
  HGDIOBJ previous = SelectObject(target, image);
  RECT background{0, 0, kPreviewWidth, kPreviewHeight};
  FillRect(target, &background,
           static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));

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
  HRESULT result = S_OK;
  if (!StretchBlt(target, left, top, width, height, source, 0, 0,
                  source_width, source_height, SRCCOPY)) {
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

HRESULT WriteBgraPreview(const BYTE* pixels, LONG width, LONG height,
                         UINT stride, std::vector<BYTE>* output) {
  if (pixels == nullptr || output == nullptr || width <= 0 || height <= 0 ||
      stride < static_cast<UINT>(width) * 4) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  HDC screen = GetDC(nullptr);
  if (screen == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  HDC source = CreateCompatibleDC(screen);
  if (source == nullptr) {
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
    ReleaseDC(nullptr, screen);
    return result;
  }
  BITMAPINFO bitmap{};
  bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap.bmiHeader.biWidth = width;
  bitmap.bmiHeader.biHeight = -height;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  bitmap.bmiHeader.biCompression = BI_RGB;
  void* dib_pixels = nullptr;
  HBITMAP image = CreateDIBSection(screen, &bitmap, DIB_RGB_COLORS,
                                   &dib_pixels, nullptr, 0);
  if (image == nullptr || dib_pixels == nullptr) {
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
    if (image != nullptr) DeleteObject(image);
    DeleteDC(source);
    ReleaseDC(nullptr, screen);
    return result;
  }
  HGDIOBJ previous = SelectObject(source, image);
  auto* destination = static_cast<BYTE*>(dib_pixels);
  for (LONG row = 0; row < height; ++row) {
    std::memcpy(destination + static_cast<size_t>(row) * width * 4,
                pixels + static_cast<size_t>(row) * stride,
                static_cast<size_t>(width) * 4);
  }
  const HRESULT result = WriteBitmapPreview(source, width, height, output);
  SelectObject(source, previous);
  DeleteObject(image);
  DeleteDC(source);
  ReleaseDC(nullptr, screen);
  return result;
}

HRESULT CreateWgcDevice(
    ComPtr<ID3D11Device>* device, ComPtr<ID3D11DeviceContext>* context,
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice* capture_device) {
  if (device == nullptr || context == nullptr || capture_device == nullptr) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  }
  constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1,
                                          D3D_FEATURE_LEVEL_11_0,
                                          D3D_FEATURE_LEVEL_10_1,
                                          D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL selected = D3D_FEATURE_LEVEL_10_0;
  HRESULT result = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
      D3D11_SDK_VERSION, device->GetAddressOf(), &selected,
      context->GetAddressOf());
  if (FAILED(result)) {
    result = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
        D3D11_SDK_VERSION, device->GetAddressOf(), &selected,
        context->GetAddressOf());
  }
  if (FAILED(result)) return result;
  ComPtr<IDXGIDevice> dxgi_device;
  result = (*device)->QueryInterface(IID_PPV_ARGS(&dxgi_device));
  if (FAILED(result)) return result;
  winrt::com_ptr<IInspectable> inspectable;
  result = CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(),
                                                inspectable.put());
  if (FAILED(result)) return result;
  try {
    *capture_device = inspectable.as<
        winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
  } catch (const winrt::hresult_error& error) {
    return error.code();
  }
  return S_OK;
}

HRESULT CreateWgcItem(
    TargetKind kind, UINT64 source_id,
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem* item) {
  if (item == nullptr) return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
  try {
    auto interop = winrt::get_activation_factory<GraphicsCaptureItem,
                                                  IGraphicsCaptureItemInterop>();
    if (kind == TargetKind::window) {
      return interop->CreateForWindow(
          reinterpret_cast<HWND>(static_cast<UINT_PTR>(source_id)),
          winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(*item));
    }
    return interop->CreateForMonitor(
        reinterpret_cast<HMONITOR>(static_cast<UINT_PTR>(source_id)),
        winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(*item));
  } catch (const winrt::hresult_error& error) {
    return error.code();
  }
}

HRESULT CaptureWithWgc(TargetKind kind, UINT64 source_id,
                       std::vector<BYTE>* output) {
  using namespace winrt::Windows::Graphics::Capture;
  using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
  if (output == nullptr) return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
  const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitialize = SUCCEEDED(apartment);
  if (FAILED(apartment) && apartment != RPC_E_CHANGED_MODE) return apartment;
  try {
    if (!GraphicsCaptureSession::IsSupported()) {
      if (uninitialize) CoUninitialize();
      return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
    }
  } catch (const winrt::hresult_error& error) {
    if (uninitialize) CoUninitialize();
    return error.code();
  }

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice capture_device{
      nullptr};
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  CaptureBorder border;
  HANDLE frame_ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  winrt::event_token frame_token{};
  bool subscribed = false;
  HRESULT result = S_OK;
  try {
    result = CreateWgcDevice(&device, &context, &capture_device);
    if (SUCCEEDED(result)) result = CreateWgcItem(kind, source_id, &item);
    if (SUCCEEDED(result)) {
      auto size = item.Size();
      if (size.Width <= 0 || size.Height <= 0 || frame_ready == nullptr) {
        result = HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
      } else {
        pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            capture_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1,
            size);
        session = pool.CreateCaptureSession(item);
        frame_token = pool.FrameArrived(
            [frame_ready](const Direct3D11CaptureFramePool&,
                          const winrt::Windows::Foundation::IInspectable&) {
              if (frame_ready != nullptr) SetEvent(frame_ready);
            });
        subscribed = true;
        border.Start(session);
        session.StartCapture();
        const DWORD wait = WaitForSingleObject(frame_ready, 1'500);
        border.Apply(session);
        if (wait != WAIT_OBJECT_0) {
          result = wait == WAIT_TIMEOUT
                       ? HRESULT_FROM_WIN32(ERROR_TIMEOUT)
                       : HRESULT_FROM_WIN32(GetLastError());
        } else {
          Direct3D11CaptureFrame frame{nullptr};
          for (;;) {
            Direct3D11CaptureFrame next = pool.TryGetNextFrame();
            if (!next) break;
            frame = std::move(next);
          }
          if (!frame) {
            result = HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
          } else {
            auto content = frame.ContentSize();
            auto access = frame.Surface().as<
                ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
            ComPtr<ID3D11Texture2D> texture;
            result = access->GetInterface(IID_PPV_ARGS(&texture));
            D3D11_TEXTURE2D_DESC description{};
            if (SUCCEEDED(result)) texture->GetDesc(&description);
            if (SUCCEEDED(result) &&
                (description.Format != DXGI_FORMAT_B8G8R8A8_UNORM ||
                 content.Width <= 0 || content.Height <= 0)) {
              result = HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
            }
            if (SUCCEEDED(result)) {
              D3D11_TEXTURE2D_DESC staging = description;
              staging.Usage = D3D11_USAGE_STAGING;
              staging.BindFlags = 0;
              staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
              staging.MiscFlags = 0;
              ComPtr<ID3D11Texture2D> readable;
              result = device->CreateTexture2D(&staging, nullptr, &readable);
              if (SUCCEEDED(result)) {
                context->CopyResource(readable.Get(), texture.Get());
                context->Flush();
                D3D11_MAPPED_SUBRESOURCE mapped{};
                result = context->Map(readable.Get(), 0, D3D11_MAP_READ, 0,
                                       &mapped);
                if (SUCCEEDED(result)) {
                  const LONG width = std::min<LONG>(
                      content.Width, static_cast<LONG>(description.Width));
                  const LONG height = std::min<LONG>(
                      content.Height, static_cast<LONG>(description.Height));
                  result = WriteBgraPreview(
                      static_cast<const BYTE*>(mapped.pData), width, height,
                      mapped.RowPitch, output);
                  context->Unmap(readable.Get(), 0);
                }
              }
            }
          }
        }
      }
    }
  } catch (const winrt::hresult_error& error) {
    result = error.code();
  } catch (...) {
    result = E_FAIL;
  }
  if (subscribed) {
    try {
      pool.FrameArrived(frame_token);
    } catch (...) {
    }
  }
  border.Close();
  try {
    session.Close();
  } catch (...) {
  }
  try {
    pool.Close();
  } catch (...) {
  }
  // Release all WinRT/D3D wrappers before leaving the COM apartment. Their
  // destructors may query the apartment even after Close() succeeds.
  session = nullptr;
  pool = nullptr;
  item = nullptr;
  capture_device = nullptr;
  context.Reset();
  device.Reset();
  if (frame_ready != nullptr) {
    CloseHandle(frame_ready);
  }
  if (uninitialize) {
    CoUninitialize();
  }
  return result;
}

bool BitmapHasContent(const std::vector<BYTE>& bitmap) {
  if (bitmap.size() < kBitmapHeaderBytes + 4) return false;
  for (size_t index = kBitmapHeaderBytes; index + 3 < bitmap.size();
       index += 16) {
    if (bitmap[index] > 8 || bitmap[index + 1] > 8 || bitmap[index + 2] > 8) {
      return true;
    }
  }
  return false;
}

HICON WindowIcon(HWND window, bool* owned) {
  if (owned != nullptr) *owned = false;
  auto message_icon = [window](WPARAM kind) -> HICON {
    DWORD_PTR value = 0;
    if (SendMessageTimeoutW(window, WM_GETICON, kind, 0,
                            SMTO_ABORTIFHUNG | SMTO_BLOCK, 100, &value) != 0) {
      return reinterpret_cast<HICON>(value);
    }
    return nullptr;
  };
  if (HICON icon = message_icon(ICON_BIG); icon != nullptr) return icon;
  if (HICON icon = message_icon(ICON_SMALL2); icon != nullptr) return icon;
  if (HICON icon = message_icon(ICON_SMALL); icon != nullptr) return icon;
  if (HICON icon = reinterpret_cast<HICON>(GetClassLongPtrW(
          window, GCLP_HICON));
      icon != nullptr) {
    return icon;
  }
  if (HICON icon = reinterpret_cast<HICON>(GetClassLongPtrW(
          window, GCLP_HICONSM));
      icon != nullptr) {
    return icon;
  }

  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0) return nullptr;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return nullptr;
  std::wstring path(32'768, L'\0');
  DWORD length = static_cast<DWORD>(path.size());
  const BOOL read = QueryFullProcessImageNameW(process, 0, path.data(), &length);
  CloseHandle(process);
  if (!read || length == 0) return nullptr;
  path.resize(length);
  HICON large = nullptr;
  HICON small_icon = nullptr;
  if (ExtractIconExW(path.c_str(), 0, &large, &small_icon, 1) == 0) return nullptr;
  HICON icon = large != nullptr ? large : small_icon;
  if (icon == nullptr) {
    if (large != nullptr) DestroyIcon(large);
    if (small_icon != nullptr) DestroyIcon(small_icon);
    return nullptr;
  }
  if (owned != nullptr) *owned = true;
  if (icon == large && small_icon != nullptr) {
    DestroyIcon(small_icon);
  } else if (icon == small_icon && large != nullptr) {
    DestroyIcon(large);
  }
  return icon;
}

HRESULT CaptureWindowIconPreview(HWND window, std::vector<BYTE>* output) {
  HDC screen = GetDC(nullptr);
  if (screen == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  HDC source = CreateCompatibleDC(screen);
  if (source == nullptr) {
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
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
    const HRESULT result = HRESULT_FROM_WIN32(GetLastError());
    if (image != nullptr) DeleteObject(image);
    DeleteDC(source);
    ReleaseDC(nullptr, screen);
    return result;
  }
  HGDIOBJ previous = SelectObject(source, image);
  RECT area{0, 0, kPreviewWidth, kPreviewHeight};
  FillRect(source, &area, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
  bool owned = false;
  HICON icon = WindowIcon(window, &owned);
  const int icon_size = 96;
  if (icon != nullptr) {
    DrawIconEx(source, (kPreviewWidth - icon_size) / 2,
               (kPreviewHeight - icon_size) / 2, icon, icon_size, icon_size, 0,
               nullptr, DI_NORMAL);
  } else {
    Rectangle(source, 104, 48, 216, 132);
    MoveToEx(source, 144, 144, nullptr);
    LineTo(source, 176, 144);
    MoveToEx(source, 176, 144, nullptr);
    LineTo(source, 176, 136);
  }
  const HRESULT result = WriteBitmapPreview(source, kPreviewWidth,
                                            kPreviewHeight, output);
  if (owned && icon != nullptr) DestroyIcon(icon);
  SelectObject(source, previous);
  DeleteObject(image);
  DeleteDC(source);
  ReleaseDC(nullptr, screen);
  return result;
}

HRESULT CaptureDisplayPreview(UINT64 source_id, std::vector<BYTE>* output) {
  RECT source{};
  HRESULT result = SourceRect(TargetKind::display, source_id, &source);
  if (FAILED(result)) return result;
  const LONG source_width = source.right - source.left;
  const LONG source_height = source.bottom - source.top;
  if (source_width <= 0 || source_height <= 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }

  std::vector<BYTE> wgc_bitmap;
  if (SUCCEEDED(CaptureWithWgc(TargetKind::display, source_id, &wgc_bitmap)) &&
      BitmapHasContent(wgc_bitmap)) {
    *output = std::move(wgc_bitmap);
    return S_OK;
  }

  HDC screen = GetDC(nullptr);
  if (screen == nullptr) return HRESULT_FROM_WIN32(GetLastError());
  HDC source_dc = CreateCompatibleDC(screen);
  if (source_dc == nullptr) {
    result = HRESULT_FROM_WIN32(GetLastError());
    ReleaseDC(nullptr, screen);
    return result;
  }
  BITMAPINFO bitmap{};
  bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap.bmiHeader.biWidth = source_width;
  bitmap.bmiHeader.biHeight = -source_height;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  bitmap.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  HBITMAP image = CreateDIBSection(screen, &bitmap, DIB_RGB_COLORS, &pixels,
                                   nullptr, 0);
  if (image == nullptr || pixels == nullptr) {
    result = HRESULT_FROM_WIN32(GetLastError());
    if (image != nullptr) DeleteObject(image);
    DeleteDC(source_dc);
    ReleaseDC(nullptr, screen);
    return result;
  }
  HGDIOBJ previous = SelectObject(source_dc, image);
  if (!StretchBlt(source_dc, 0, 0, source_width, source_height, screen,
                  source.left, source.top, source_width, source_height,
                  SRCCOPY | CAPTUREBLT)) {
    result = HRESULT_FROM_WIN32(GetLastError());
  } else {
    result = WriteBitmapPreview(source_dc, source_width, source_height, output);
  }
  SelectObject(source_dc, previous);
  DeleteObject(image);
  DeleteDC(source_dc);
  ReleaseDC(nullptr, screen);
  return result;
}

HRESULT CaptureWindowPreview(UINT64 source_id, std::vector<BYTE>* output) {
  RECT source{};
  HRESULT result = SourceRect(TargetKind::window, source_id, &source);
  if (FAILED(result)) return result;
  LONG source_width = source.right - source.left;
  LONG source_height = source.bottom - source.top;
  if (source_width <= 0 || source_height <= 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  const double limit = std::min(
      1.0, static_cast<double>(kMaxPreviewSourceDimension) /
               std::max(source_width, source_height));
  source_width = std::max<LONG>(1, static_cast<LONG>(source_width * limit));
  source_height = std::max<LONG>(1, static_cast<LONG>(source_height * limit));

  HWND window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(source_id));
  // A minimized window has no current composited frame. Returning a stale
  // DWM/PrintWindow fragment is worse than an explicit app identity marker.
  if (IsIconic(window)) return CaptureWindowIconPreview(window, output);

  std::vector<BYTE> wgc_bitmap;
  if (SUCCEEDED(CaptureWithWgc(TargetKind::window, source_id, &wgc_bitmap)) &&
      BitmapHasContent(wgc_bitmap)) {
    *output = std::move(wgc_bitmap);
    return S_OK;
  }

  // DWM owns the same per-window thumbnails used by the task switcher. It is
  // independent of desktop occlusion (including our picker). Keep this as a
  // fallback for window classes WGC declines; minimized windows already took
  // the explicit identity path above.
  if (EnsurePreviewWindowClass() != 0) {
    HWND destination = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kPreviewWindowClass, L"",
        WS_POPUP, -32'768, -32'768, kPreviewWidth, kPreviewHeight, nullptr,
        nullptr, GetModuleHandleW(nullptr), nullptr);
    if (destination != nullptr) {
      HTHUMBNAIL thumbnail = nullptr;
      HRESULT thumbnail_result =
          DwmRegisterThumbnail(destination, window, &thumbnail);
      if (SUCCEEDED(thumbnail_result) && thumbnail != nullptr) {
        SIZE source_size{};
        thumbnail_result = DwmQueryThumbnailSourceSize(thumbnail, &source_size);
        if (SUCCEEDED(thumbnail_result) && source_size.cx > 0 &&
            source_size.cy > 0) {
          const double scale = std::min(
              static_cast<double>(kPreviewWidth) / source_size.cx,
              static_cast<double>(kPreviewHeight) / source_size.cy);
          const LONG width = std::max<LONG>(
              1, static_cast<LONG>(source_size.cx * scale));
          const LONG height = std::max<LONG>(
              1, static_cast<LONG>(source_size.cy * scale));
          DWM_THUMBNAIL_PROPERTIES properties{};
          properties.dwFlags = DWM_TNP_VISIBLE | DWM_TNP_RECTDESTINATION |
                               DWM_TNP_SOURCECLIENTAREAONLY;
          properties.fVisible = TRUE;
          properties.fSourceClientAreaOnly = FALSE;
          properties.rcDestination = {
              (kPreviewWidth - width) / 2, (kPreviewHeight - height) / 2,
              (kPreviewWidth - width) / 2 + width,
              (kPreviewHeight - height) / 2 + height};
          thumbnail_result = DwmUpdateThumbnailProperties(
              thumbnail, &properties);
          if (SUCCEEDED(thumbnail_result)) {
            SetWindowPos(destination, HWND_TOPMOST, -32'768, -32'768,
                         kPreviewWidth, kPreviewHeight,
                         SWP_NOACTIVATE | SWP_NOSENDCHANGING);
            ShowWindow(destination, SW_SHOWNOACTIVATE);
            UpdateWindow(destination);
            DwmFlush();
            Sleep(12);
            HDC destination_dc = GetDC(destination);
            if (destination_dc != nullptr) {
              thumbnail_result = WriteBitmapPreview(
                  destination_dc, kPreviewWidth, kPreviewHeight, output);
              ReleaseDC(destination, destination_dc);
            } else {
              thumbnail_result = HRESULT_FROM_WIN32(GetLastError());
            }
          }
        }
        DwmUnregisterThumbnail(thumbnail);
      }
      ShowWindow(destination, SW_HIDE);
      DestroyWindow(destination);
      if (SUCCEEDED(thumbnail_result) && BitmapHasContent(*output)) return S_OK;
    }
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
  bitmap.bmiHeader.biWidth = source_width;
  bitmap.bmiHeader.biHeight = -source_height;
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
  RECT background{0, 0, source_width, source_height};
  FillRect(target, &background,
           static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
  if (!PrintWindow(window, target, PW_RENDERFULLCONTENT)) {
    // A few older window classes only implement the original PrintWindow
    // contract; accept that fallback before returning an advisory failure.
    if (!PrintWindow(window, target, 0)) {
      result = HRESULT_FROM_WIN32(ERROR_PARTIAL_COPY);
    }
  }
  if (SUCCEEDED(result)) {
    result = WriteBitmapPreview(target, source_width, source_height, output);
  }
  SelectObject(target, previous);
  DeleteObject(image);
  DeleteDC(target);
  ReleaseDC(nullptr, screen);
  if (SUCCEEDED(result) && BitmapHasContent(*output)) return S_OK;
  output->clear();
  return FAILED(result) ? result : HRESULT_FROM_WIN32(ERROR_PARTIAL_COPY);
}

HRESULT CapturePreview(TargetKind kind, UINT64 source_id,
                       std::vector<BYTE>* output) {
  return kind == TargetKind::window
             ? CaptureWindowPreview(source_id, output)
             : CaptureDisplayPreview(source_id, output);
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

SIZE CapturePresentation::Resolve(UINT32 width, UINT32 height, bool key_frame) {
  const SIZE captured{static_cast<LONG>(width), static_cast<LONG>(height)};
  const HWND window = kind_ == TargetKind::window
                          ? reinterpret_cast<HWND>(static_cast<UINT_PTR>(source_id_))
                          : nullptr;
  const HMONITOR monitor = window != nullptr
                               ? MonitorFromWindow(window, MONITOR_DEFAULTTONULL)
                               : reinterpret_cast<HMONITOR>(
                                     static_cast<UINT_PTR>(source_id_));
  // WGC/CCD use physical pixels; fullscreen eligibility must use them too.
  const auto previous_dpi =
      SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  bool eligible = previous_dpi != nullptr && GetMonitorInfoW(monitor, &info);
  if (eligible && window != nullptr) {
    RECT client{};
    POINT origin{};
    eligible = !IsIconic(window) && GetClientRect(window, &client) &&
               ClientToScreen(window, &origin);
    OffsetRect(&client, origin.x, origin.y);
    eligible = eligible && EqualRect(&client, &info.rcMonitor);
  }
  if (previous_dpi != nullptr) SetThreadDpiAwarenessContext(previous_dpi);
  if (!eligible) {
    monitor_ = nullptr;
    return captured;
  }
  if (key_frame || monitor != monitor_ || !EqualRect(&info.rcMonitor, &bounds_) ||
      captured.cx != captured_.cx || captured.cy != captured_.cy) {
    presentation_ = ReadDisplayPresentation(info.szDevice, captured);
    monitor_ = monitor;
    bounds_ = info.rcMonitor;
    captured_ = captured;
  }
  return presentation_;
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

}  // namespace piik::capture
