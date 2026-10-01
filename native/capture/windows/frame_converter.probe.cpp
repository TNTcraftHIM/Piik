// Physical D3D11 check; opt in with build.ps1 -CheckColor. No desktop capture.
#define wmain capture_main
#include "main.cpp"
#undef wmain
#include <DirectXPackedVector.h>

namespace {

constexpr std::array<UINT32, 8> kRgb{
    0xff000000, 0xff202020, 0xff808080, 0xffebebeb,
    0xffffffff, 0xffff0000, 0xff00ff00, 0xff0000ff};
constexpr std::array<std::array<int, 3>, 8> kYuv{{
    {16, 128, 128}, {44, 128, 128}, {126, 128, 128}, {218, 128, 128},
    {235, 128, 128}, {82, 90, 240}, {145, 54, 34}, {41, 240, 110}}};
constexpr std::array<std::array<int, 3>, 8> kYuv709{{
    {16, 128, 128}, {44, 128, 128}, {126, 128, 128}, {218, 128, 128},
    {235, 128, 128}, {63, 102, 240}, {173, 42, 26}, {32, 240, 118}}};
constexpr std::array<std::array<int, 3>, 8> kYuvFull{{
    {0, 128, 128}, {32, 128, 128}, {128, 128, 128}, {235, 128, 128},
    {255, 128, 128}, {76, 85, 255}, {150, 44, 21}, {29, 255, 107}}};
constexpr std::array<std::array<int, 3>, 8> kYuv709Full{{
    {0, 128, 128}, {32, 128, 128}, {128, 128, 128}, {235, 128, 128},
    {255, 128, 128}, {54, 99, 255}, {182, 30, 12}, {18, 255, 116}}};

ComPtr<ID3D11Texture2D> ColorBars(const DeviceContext& device, UINT width,
                                UINT height, DXGI_COLOR_SPACE_TYPE color) {
  const bool rgb = color == kDesktopColor;
  const auto& yuv = color == DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709 ? kYuv709
      : color == DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709 ? kYuv709Full
      : color == DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P601 ? kYuvFull : kYuv;
  std::vector<UINT8> pixels(static_cast<size_t>(width) * height * (rgb ? 4 : 2));
  for (UINT row = 0; row < height; ++row) {
    for (UINT column = 0; column < width; ++column) {
      const size_t bar = column * kRgb.size() / width;
      const size_t index = static_cast<size_t>(row) * width + column;
      if (rgb) {
        for (UINT channel = 0; channel < 4; ++channel)
          pixels[index * 4 + channel] = static_cast<UINT8>(kRgb[bar] >> (channel * 8));
      } else {
        pixels[index] = static_cast<UINT8>(yuv[bar][0]);
        if (row < height / 2)
          pixels[static_cast<size_t>(width) * height + index] =
              static_cast<UINT8>(yuv[bar][1 + column % 2]);
      }
    }
  }
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = description.ArraySize = description.SampleDesc.Count = 1;
  description.Format = rgb ? DXGI_FORMAT_B8G8R8A8_UNORM : DXGI_FORMAT_NV12;
  description.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  D3D11_SUBRESOURCE_DATA data{};
  data.pSysMem = pixels.data();
  data.SysMemPitch = width * (rgb ? 4 : 1);
  ComPtr<ID3D11Texture2D> texture;
  Check(device.device->CreateTexture2D(&description, &data, &texture), "color-source");
  return texture;
}

void CheckColors(const DeviceContext& device, ID3D11Texture2D* texture) {
  D3D11_TEXTURE2D_DESC description{};
  texture->GetDesc(&description);
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  Check(device.device->CreateTexture2D(&description, nullptr, &staging), "color-readback");
  device.context->CopyResource(staging.Get(), texture);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  Check(device.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "color-map");
  const auto* bytes = static_cast<const UINT8*>(mapped.pData);
  bool correct = true;
  for (size_t bar = 0; bar < kYuv.size(); ++bar) {
    const auto x = description.Width * (2 * bar + 1) / (2 * kYuv.size());
    const size_t y = description.Height / 2;
    const size_t uv = (description.Height + y / 2) * mapped.RowPitch + (x & ~size_t{1});
    const std::array<int, 3> actual{bytes[y * mapped.RowPitch + x], bytes[uv], bytes[uv + 1]};
    for (size_t channel = 0; channel < 3; ++channel) {
      if (std::abs(actual[channel] - kYuv[bar][channel]) > 2) {
        std::cerr << "bar=" << bar << " channel=" << channel
                  << " expected=" << kYuv[bar][channel] << " actual=" << actual[channel] << '\n';
        correct = false;
      }
    }
  }
  device.context->Unmap(staging.Get(), 0);
  if (!correct) throw std::runtime_error("SDR range or matrix changed");
}

ComPtr<ID3D11Texture2D> LinearBars(const DeviceContext& device, UINT width,
                                 UINT height, const std::array<float, 8>& nits) {
  std::vector<UINT16> pixels(static_cast<size_t>(width) * height * 4);
  for (size_t pixel = 0; pixel < static_cast<size_t>(width) * height; ++pixel) {
    const auto value = DirectX::PackedVector::XMConvertFloatToHalf(nits[(pixel % width) * 8 / width] / 80.0f);
    for (size_t channel = 0; channel < 3; ++channel) pixels[pixel * 4 + channel] = value;
    pixels[pixel * 4 + 3] = DirectX::PackedVector::XMConvertFloatToHalf(1.0f);
  }
  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = description.ArraySize = description.SampleDesc.Count = 1;
  description.Format = DXGI_FORMAT_R16G16B16A16_FLOAT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  D3D11_SUBRESOURCE_DATA data{};
  data.pSysMem = pixels.data();
  data.SysMemPitch = width * 8;
  ComPtr<ID3D11Texture2D> texture;
  Check(device.device->CreateTexture2D(&description, &data, &texture), "hdr-source");
  return texture;
}

std::array<int, 8> ReadGrayBars(const DeviceContext& device, ID3D11Texture2D* texture) {
  D3D11_TEXTURE2D_DESC description{};
  texture->GetDesc(&description);
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  Check(device.device->CreateTexture2D(&description, nullptr, &staging), "hdr-readback");
  device.context->CopyResource(staging.Get(), texture);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  Check(device.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "hdr-map");
  const auto* bytes = static_cast<const UINT8*>(mapped.pData);
  std::array<int, 8> result{};
  bool neutral = true;
  for (size_t bar = 0; bar < result.size(); ++bar) {
    const size_t pixel = description.Height / 2 * mapped.RowPitch +
        description.Width * (2 * bar + 1) / 16 * 4;
    result[bar] = bytes[pixel];
    neutral = neutral && std::abs(result[bar] - bytes[pixel + 1]) <= 1 &&
        std::abs(result[bar] - bytes[pixel + 2]) <= 1;
  }
  device.context->Unmap(staging.Get(), 0);
  if (!neutral) throw std::runtime_error("HDR gray acquired a color cast");
  return result;
}

void CheckHdr(const DeviceContext& device) {
  CaptureSdrConverter capture(device.device.Get());
  VideoProfile profile;
  profile.width = 256;
  profile.height = 128;
  FrameConverter converter(device.device.Get(), profile);
  for (const UINT width : {256u, 512u, 256u}) {
    // SDR must retain the old pixels after an HDR frame, with the same owner.
    auto sdr = ColorBars(device, width, width / 2, kDesktopColor);
    auto owned = capture.Convert(sdr.Get(), {});
    CheckColors(device, converter.Convert(owned.Get(), width, width / 2,
        {static_cast<LONG>(width), static_cast<LONG>(width / 2)}, kDesktopColor).Get());
    auto hdr = LinearBars(device, width, width / 2, {0, 5, 20, 80, 200, 400, 700, 1000});
    for (const float white : {80.0f, 240.0f, 80.0f}) {
      auto mapped = capture.Convert(hdr.Get(), {true, white, 1000.0f});
      const auto levels = ReadGrayBars(device, mapped.Get());
      std::cout << "HDR white=" << white << " levels=";
      for (const auto level : levels) std::cout << level << ',';
      std::cout << '\n';
      if (levels.front() > 1 || levels.back() < 245)
        throw std::runtime_error("HDR black/peak mapping is incorrect");
      for (size_t index = 1; index < levels.size(); ++index)
        if (levels[index] <= levels[index - 1])
          throw std::runtime_error("HDR luminance detail was clipped before tone mapping");
      auto next = capture.Convert(sdr.Get(), {});
      if (ReadGrayBars(device, mapped.Get()) != levels)
        throw std::runtime_error("Capture replacement modified a retained frame");
      CheckColors(device, converter.Convert(next.Get(), width, width / 2,
          {static_cast<LONG>(width), static_cast<LONG>(width / 2)}, kDesktopColor).Get());
    }
  }
}

}  // namespace

int main() {
  try {
    Runtime runtime;
    const auto adapters = EnumerateAdapters();
    if (adapters.empty()) throw std::runtime_error("A physical D3D11 adapter is required");
    for (const auto& adapter : adapters) {
      auto device = CreateDevice(adapter);
      for (const UINT output_width : {256u, 128u}) {
        VideoProfile profile;
        profile.width = output_width;
        profile.height = output_width / 2;
        FrameConverter converter(device.device.Get(), profile);
        // Reuse the same converter across RGB/NV12 and size replacements.
        for (const UINT input_width : {256u, 512u, 256u}) {
          for (const auto color : {kDesktopColor, kSdrVideoColor,
                                  DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
                                  DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P601,
                                  DXGI_COLOR_SPACE_YCBCR_FULL_G22_LEFT_P709, kDesktopColor}) {
            const UINT input_height = input_width / 2;
            auto source = ColorBars(device, input_width, input_height, color);
            auto output = converter.Convert(source.Get(), input_width, input_height,
                {static_cast<LONG>(input_width), static_cast<LONG>(input_height)},
                color);
            try {
              CheckColors(device, output.Get());
            } catch (...) {
              std::cerr << "adapter=" << adapter.index << " color=" << color
                        << " input-width=" << input_width << " output-width=" << output_width << '\n';
              throw;
            }
          }
        }
      }
      std::cout << "SDR conversion passed: " << NarrowAscii(adapter.description.Description) << '\n';
      CheckHdr(device);
      std::cout << "HDR conversion passed: " << NarrowAscii(adapter.description.Description) << '\n';
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    if (const auto* failure = dynamic_cast<const GateFailure*>(&error))
      std::cerr << "stage=" << failure->stage() << " result=" << std::hex << failure->result() << '\n';
    return 1;
  }
}
