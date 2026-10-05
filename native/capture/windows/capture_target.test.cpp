#include "capture_target.h"

#include <cassert>
#include <iostream>
#include <sstream>
#include <string>

namespace {

void CheckOwnedApplicationWindow() {
  HWND owner = CreateWindowExW(0, L"STATIC", L"Piik enumeration owner",
      WS_OVERLAPPEDWINDOW, 0, 0, 320, 180, nullptr, nullptr, nullptr, nullptr);
  assert(owner != nullptr);
  HWND application = CreateWindowExW(WS_EX_APPWINDOW, L"STATIC", L"Piik owned application",
      WS_OVERLAPPEDWINDOW, 0, 0, 320, 180, owner, nullptr, nullptr, nullptr);
  HWND dialog = CreateWindowExW(0, L"STATIC", L"Piik owned dialog",
      WS_OVERLAPPEDWINDOW, 0, 0, 320, 180, owner, nullptr, nullptr, nullptr);
  assert(application != nullptr && dialog != nullptr);
  ShowWindow(application, SW_SHOWNOACTIVATE);
  ShowWindow(dialog, SW_SHOWNOACTIVATE);

  // Enumerate from a child: the real picker excludes its own process.
  wchar_t executable[MAX_PATH]{};
  assert(GetModuleFileNameW(nullptr, executable, MAX_PATH) > 0);
  std::wstring command = L"\"" + std::wstring(executable) + L"\" --check-enumeration " +
      std::to_wstring(reinterpret_cast<UINT_PTR>(application)) + L" " +
      std::to_wstring(reinterpret_cast<UINT_PTR>(dialog));
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  assert(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process));
  const DWORD wait = WaitForSingleObject(process.hProcess, 5000);
  if (wait != WAIT_OBJECT_0) {
    TerminateProcess(process.hProcess, 1);
    WaitForSingleObject(process.hProcess, 1000);
  }
  DWORD exit_code = 1;
  assert(GetExitCodeProcess(process.hProcess, &exit_code));
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  DestroyWindow(owner);
  assert(wait == WAIT_OBJECT_0 && exit_code == 0);
}

}  // namespace

int wmain(int count, wchar_t** arguments) {
  if (count == 4 && std::wstring(arguments[1]) == L"--check-enumeration") {
    std::ostringstream sources;
    auto* output = std::cout.rdbuf(sources.rdbuf());
    const int result = piik::capture::WriteSourceList();
    std::cout.rdbuf(output);
    const auto listed = [&](const wchar_t* id) {
      return sources.str().find("\"sourceId\":\"" +
          std::to_string(std::stoull(id)) + "\"") != std::string::npos;
    };
    return result == 0 && listed(arguments[2]) && !listed(arguments[3]) ? 0 : 1;
  }
  CheckOwnedApplicationWindow();
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
  assert(SUCCEEDED(piik::capture::ValidateProcessTarget(GetCurrentProcess(), creation_time)));
  assert(FAILED(piik::capture::ValidateProcessTarget(GetCurrentProcess(), creation_time + 1)));
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
  std::cout << "Capture enumeration and preview failure cleanup passed.\n";
}
