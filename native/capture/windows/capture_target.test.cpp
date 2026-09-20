#include "capture_target.h"

#include <cassert>
#include <iostream>

int main() {
  // Enumeration and preview are separate operations. A once-listed window may
  // become hidden before WGC creates its item. Unsupported capture may return
  // an advisory error or a fallback preview, but cleanup must never crash.
  HWND window = CreateWindowExW(0, L"STATIC", L"Piik hidden preview fixture",
                               WS_OVERLAPPEDWINDOW, 0, 0, 320, 180, nullptr,
                               nullptr, GetModuleHandleW(nullptr), nullptr);
  assert(window != nullptr);
  FILETIME created{}, exited{}, kernel{}, user{};
  assert(GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user));
  const UINT64 creation_time = (static_cast<UINT64>(created.dwHighDateTime) << 32) |
                               created.dwLowDateTime;
  HANDLE previous_output = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE sink = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  assert(sink != INVALID_HANDLE_VALUE);
  assert(SetStdHandle(STD_OUTPUT_HANDLE, sink));
  piik::capture::WriteSourcePreview(piik::capture::TargetKind::window,
      static_cast<UINT64>(reinterpret_cast<UINT_PTR>(window)),
      GetCurrentProcessId(), creation_time);
  SetStdHandle(STD_OUTPUT_HANDLE, previous_output);
  CloseHandle(sink);
  DestroyWindow(window);
  std::cout << "Capture preview failure cleanup passed.\n";
}
