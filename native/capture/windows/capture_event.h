#pragma once

#include <windows.h>
#include <winrt/base.h>

#include <memory>
#include <utility>

namespace piik::capture {

// Revocation does not join an in-flight WinRT callback. Let the delegate retain
// its signal until the final callback returns, without retaining the capture.
inline auto CaptureEventHandler(std::shared_ptr<winrt::handle> event) {
  return [event = std::move(event)](const auto&, const auto&) {
    SetEvent(event->get());
  };
}

}  // namespace piik::capture
