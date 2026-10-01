#pragma once

#include "capture_error.h"
#include "capture_target.h"

#include <d2d1_1.h>
#include <d2d1effects_2.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

namespace piik::capture::windows {

struct CaptureColor final {
  bool hdr = false;
  float white_nits = 80.0f;
  float peak_nits = 80.0f;

  DXGI_FORMAT Format() const {
    return hdr ? DXGI_FORMAT_R16G16B16A16_FLOAT : DXGI_FORMAT_B8G8R8A8_UNORM;
  }
};

// Windows invalidates the DXGI factory when display color characteristics
// change. Window movement additionally changes the source monitor; neither
// event belongs to encoder or media-route recovery.
class CaptureDisplayColor final {
 public:
  CaptureDisplayColor(TargetKind kind, UINT64 source_id)
      : kind_(kind), source_id_(source_id) {}

  CaptureColor Resolve() {
    const auto handle = static_cast<UINT_PTR>(source_id_);
    const HMONITOR monitor = kind_ == TargetKind::window
        ? MonitorFromWindow(reinterpret_cast<HWND>(handle), MONITOR_DEFAULTTONEAREST)
        : reinterpret_cast<HMONITOR>(handle);
    if (factory_ && factory_->IsCurrent() && monitor == monitor_) return color_;

    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
      return monitor == monitor_ ? color_ : CaptureColor{};
    CaptureColor next;
    for (UINT adapter_index = 0;; ++adapter_index) {
      Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
      if (FAILED(factory->EnumAdapters1(adapter_index, &adapter))) break;
      for (UINT output_index = 0;; ++output_index) {
        Microsoft::WRL::ComPtr<IDXGIOutput> output;
        if (FAILED(adapter->EnumOutputs(output_index, &output))) break;
        Microsoft::WRL::ComPtr<IDXGIOutput6> extended;
        DXGI_OUTPUT_DESC1 description{};
        if (FAILED(output.As(&extended)) || FAILED(extended->GetDesc1(&description)) ||
            description.Monitor != monitor) continue;
        next.hdr = description.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
        if (next.hdr) {
          next.white_nits = ReadWhiteLevel(description.DeviceName);
          // WGC has no per-frame MaxCLL. Use the source display's stable peak;
          // absent usable metadata, retain the HDR10 luminance range.
          const float peak = std::isfinite(description.MaxLuminance) &&
                  description.MaxLuminance > 0.0f
              ? description.MaxLuminance : 10'000.0f;
          next.peak_nits = std::max(next.white_nits, peak);
        }
        factory_ = std::move(factory);
        monitor_ = monitor;
        color_ = next;
        return color_;
      }
    }
    return next;
  }

 private:
  static float ReadWhiteLevel(const wchar_t* device_name) {
    UINT32 path_count = 0, mode_count = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &path_count, &mode_count) !=
        ERROR_SUCCESS) return 80.0f;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(path_count);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(mode_count);
    if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count, paths.data(), &mode_count,
                           modes.data(), nullptr) != ERROR_SUCCESS) return 80.0f;
    for (UINT32 index = 0; index < path_count; ++index) {
      const auto& path = paths[index];
      DISPLAYCONFIG_SOURCE_DEVICE_NAME name{};
      name.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(name),
                     path.sourceInfo.adapterId, path.sourceInfo.id};
      if (DisplayConfigGetDeviceInfo(&name.header) != ERROR_SUCCESS ||
          wcscmp(name.viewGdiDeviceName, device_name) != 0) continue;
      DISPLAYCONFIG_SDR_WHITE_LEVEL white{};
      white.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, sizeof(white),
                      path.targetInfo.adapterId, path.targetInfo.id};
      if (DisplayConfigGetDeviceInfo(&white.header) == ERROR_SUCCESS && white.SDRWhiteLevel > 0)
        return static_cast<float>(white.SDRWhiteLevel) * 80.0f / 1000.0f;
    }
    return 80.0f;
  }

  const TargetKind kind_;
  const UINT64 source_id_;
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory_;
  HMONITOR monitor_ = nullptr;
  CaptureColor color_;
};

// Produces an owned SDR texture before preview or output fanout. Ordinary SDR
// keeps its exact copy path. HDR uses Windows effects on the capture GPU once,
// rather than duplicating tone mapping in each encoder or reading pixels to CPU.
class CaptureSdrConverter final {
 public:
  explicit CaptureSdrConverter(ID3D11Device* device) : device_(device) {
    device_->GetImmediateContext(&context_);
  }

  Microsoft::WRL::ComPtr<ID3D11Texture2D> Convert(ID3D11Texture2D* source,
                                                const CaptureColor& color) {
    D3D11_TEXTURE2D_DESC description{};
    source->GetDesc(&description);
    if (description.Format != color.Format())
      Fail("capture-color-format", "Captured frame and display color generation differ");
    description.Usage = D3D11_USAGE_DEFAULT;
    description.CPUAccessFlags = description.MiscFlags = 0;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> owned;
    Check(device_->CreateTexture2D(&description, nullptr, &owned), "capture-owned-input");
    context_->CopyResource(owned.Get(), source);
    if (!color.hdr) return owned;
    if (!drawing_) Initialize();

    Microsoft::WRL::ComPtr<IDXGISurface> surface;
    Check(owned.As(&surface), "capture-hdr-surface");
    const auto input_properties = D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_NONE,
        D2D1::PixelFormat(description.Format, D2D1_ALPHA_MODE_IGNORE));
    Microsoft::WRL::ComPtr<ID2D1Bitmap1> input;
    Check(drawing_->CreateBitmapFromDxgiSurface(surface.Get(), &input_properties, &input),
          "capture-hdr-bitmap");
    Check(tone_map_->SetValue(D2D1_HDRTONEMAP_PROP_INPUT_MAX_LUMINANCE, color.peak_nits),
          "capture-hdr-peak");
    Check(tone_map_->SetValue(D2D1_HDRTONEMAP_PROP_OUTPUT_MAX_LUMINANCE, color.white_nits),
          "capture-sdr-peak");
    Check(white_level_->SetValue(D2D1_WHITELEVELADJUSTMENT_PROP_OUTPUT_WHITE_LEVEL, color.white_nits),
          "capture-sdr-white");

    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> output;
    Check(device_->CreateTexture2D(&description, nullptr, &output), "capture-sdr-texture");
    surface.Reset();
    Check(output.As(&surface), "capture-sdr-surface");
    const auto output_properties = D2D1::BitmapProperties1(
        D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        D2D1::PixelFormat(description.Format, D2D1_ALPHA_MODE_IGNORE));
    Microsoft::WRL::ComPtr<ID2D1Bitmap1> target;
    Check(drawing_->CreateBitmapFromDxgiSurface(surface.Get(), &output_properties, &target),
          "capture-sdr-bitmap");
    tone_map_->SetInput(0, input.Get());
    drawing_->SetTarget(target.Get());
    Microsoft::WRL::ComPtr<ID2D1Image> image;
    srgb_->GetOutput(&image);
    drawing_->BeginDraw();
    drawing_->DrawImage(image.Get(), nullptr, nullptr,
                       D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1_COMPOSITE_MODE_SOURCE_COPY);
    const HRESULT result = drawing_->EndDraw();
    drawing_->SetTarget(nullptr);
    tone_map_->SetInput(0, nullptr);
    Check(result, "capture-hdr-tone-map");
    return output;
  }

 private:
  void Initialize() {
    Microsoft::WRL::ComPtr<ID2D1Factory1> factory;
    Check(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, IID_PPV_ARGS(&factory)),
          "capture-d2d-factory");
    Microsoft::WRL::ComPtr<IDXGIDevice> dxgi;
    Check(device_.As(&dxgi), "capture-d2d-dxgi");
    Microsoft::WRL::ComPtr<ID2D1Device> device;
    Check(factory->CreateDevice(dxgi.Get(), &device), "capture-d2d-device");
    Check(device->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, &drawing_),
          "capture-d2d-context");
    const D2D1_RENDERING_CONTROLS controls{D2D1_BUFFER_PRECISION_16BPC_FLOAT, {0, 0}};
    drawing_->SetRenderingControls(&controls);
    Check(drawing_->CreateEffect(CLSID_D2D1HdrToneMap, &tone_map_), "capture-tone-map-effect");
    Check(tone_map_->SetValue(D2D1_HDRTONEMAP_PROP_DISPLAY_MODE, D2D1_HDRTONEMAP_DISPLAY_MODE_SDR),
          "capture-tone-map-mode");
    Check(drawing_->CreateEffect(CLSID_D2D1WhiteLevelAdjustment, &white_level_), "capture-white-effect");
    Check(white_level_->SetValue(D2D1_WHITELEVELADJUSTMENT_PROP_INPUT_WHITE_LEVEL, 80.0f),
          "capture-input-white");
    white_level_->SetInputEffect(0, tone_map_.Get());
    Check(drawing_->CreateEffect(CLSID_D2D1ColorManagement, &srgb_), "capture-srgb-effect");
    Microsoft::WRL::ComPtr<ID2D1ColorContext> linear, srgb;
    Check(drawing_->CreateColorContext(D2D1_COLOR_SPACE_SCRGB, nullptr, 0, &linear), "capture-linear-color");
    Check(drawing_->CreateColorContext(D2D1_COLOR_SPACE_SRGB, nullptr, 0, &srgb), "capture-srgb-color");
    Check(srgb_->SetValue(D2D1_COLORMANAGEMENT_PROP_SOURCE_COLOR_CONTEXT, linear.Get()), "capture-input-color");
    Check(srgb_->SetValue(D2D1_COLORMANAGEMENT_PROP_DESTINATION_COLOR_CONTEXT, srgb.Get()), "capture-output-color");
    Check(srgb_->SetValue(D2D1_COLORMANAGEMENT_PROP_QUALITY, D2D1_COLORMANAGEMENT_QUALITY_BEST),
          "capture-color-quality");
    srgb_->SetInputEffect(0, white_level_.Get());
  }

  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID2D1DeviceContext> drawing_;
  Microsoft::WRL::ComPtr<ID2D1Effect> tone_map_, white_level_, srgb_;
};

}  // namespace piik::capture::windows
