#pragma once

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>

#include <iostream>
#include <syncstream>

namespace piik::capture {

// Sharing defaults and source previews request borderless capture. Windows owns
// consent and visibility; an optional access request must not delay frames/stop.
class CaptureBorder final {
 public:
  CaptureBorder() = default;
  CaptureBorder(const CaptureBorder&) = delete;
  CaptureBorder& operator=(const CaptureBorder&) = delete;
  ~CaptureBorder() { Close(); }

  static bool Supported() noexcept {
    using winrt::Windows::Foundation::Metadata::ApiInformation;
    try {
      return ApiInformation::IsPropertyPresent(
                 L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired") &&
             ApiInformation::IsMethodPresent(
                 L"Windows.Graphics.Capture.GraphicsCaptureAccess", L"RequestAccessAsync");
    } catch (const winrt::hresult_error&) {
      return false;
    }
  }

  void Start(const winrt::Windows::Graphics::Capture::GraphicsCaptureSession& session) {
    using namespace winrt::Windows::Graphics::Capture;
    if (!Supported()) return;
    try {
      access_ = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless);
      Apply(session);
    } catch (const winrt::hresult_error& error) {
      std::osyncstream(std::cerr) << "capture-border-access-failed: " << winrt::to_string(error.message()) << '\n';
    }
  }

  void Apply(const winrt::Windows::Graphics::Capture::GraphicsCaptureSession& session) {
    if (!access_) return;
    try {
      if (access_.Status() == winrt::Windows::Foundation::AsyncStatus::Started) return;
      const auto access = access_.GetResults();
      if (access == AccessStatus::Allowed) session.IsBorderRequired(false);
      std::osyncstream(std::cerr) << "capture-border-access="
          << (access == AccessStatus::Allowed ? "allowed" : "not-allowed")
          << " status=" << static_cast<int>(access) << '\n';
    } catch (const winrt::hresult_error& error) {
      std::osyncstream(std::cerr) << "capture-border-access-failed: " << winrt::to_string(error.message()) << '\n';
    }
    access_ = nullptr;
  }

  void Close() noexcept {
    try {
      if (access_) access_.Cancel();
    } catch (...) {
    }
    access_ = nullptr;
  }

 private:
  using AccessStatus = winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
  winrt::Windows::Foundation::IAsyncOperation<AccessStatus> access_{nullptr};
};

}  // namespace piik::capture
