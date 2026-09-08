#include "vp8_encoder.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
using screener::capture::Vp8Encoder;
struct Profile { uint32_t width, height, bitrate; };
// Codec fixtures, not product presets. Layers are L=0, M=1, H=2.
constexpr std::array<Profile, 3> kProfiles{{
    {160, 90, 90'000}, {320, 180, 300'000}, {640, 360, 1'200'000}}};
// Eight source frames per pair: H/H, H/L, L/L, M/M, H/H.
constexpr std::array<std::array<int, 2>, 5> kTargets{{
    {2, 2}, {2, 0}, {0, 0}, {1, 1}, {2, 2}}};

void DrawFrame(std::vector<uint8_t>& pixels, Profile profile, uint32_t frame) {
  pixels.assign(static_cast<size_t>(profile.width) * profile.height * 3 / 2, 128);
  for (uint32_t y = 0; y < profile.height; ++y) {
    for (uint32_t x = 0; x < profile.width; ++x) {
      const uint32_t scene_x = (x * 640 / profile.width + frame * 8) % 640;
      const uint32_t scene_y = y * 360 / profile.height;
      pixels[static_cast<size_t>(y) * profile.width + x] =
          static_cast<uint8_t>(32 + (((scene_x / 16) ^ (scene_y / 16)) % 8) * 24);
    }
  }
}

void WriteFrame(uint32_t index, int layer, Profile profile, uint64_t pts,
                const screener::capture::Vp8Frame& packet) {
  std::cout << "{\"FrameIndex\":" << index << ",\"Layer\":" << layer
            << ",\"Width\":" << profile.width << ",\"Height\":" << profile.height
            << ",\"PTS\":" << pts << ",\"Recovery\":"
            << (packet.key_frame ? "true" : "false") << ",\"DataHex\":\"";
  constexpr char hex[] = "0123456789abcdef";
  for (uint8_t byte : packet.bytes) {
    std::cout.put(hex[byte >> 4]);
    std::cout.put(hex[byte & 15]);
  }
  std::cout << "\"}\n";
  if (!std::cout) throw std::runtime_error("Fixture output failed");
}

}  // namespace

int main() {
  try {
    const auto deadline = Clock::now() + std::chrono::seconds(15);
    std::array<std::unique_ptr<Vp8Encoder>, 3> encoders;
    std::vector<uint8_t> pixels;
    for (uint32_t frame = 0; frame < 40; ++frame) {
      const auto& targets = kTargets[frame / 8];
      const int highest = std::max(targets[0], targets[1]);
      const uint64_t timestamp100ns = (static_cast<uint64_t>(frame) + 1) * 10'000'000 / 30;
      // Serial CPU fixture only; this does not implement production worker isolation.
      for (int layer = 2; layer >= 0; --layer) {
        if (Clock::now() >= deadline) throw std::runtime_error("Fixture deadline exceeded");
        if (layer > highest) {
          encoders[layer].reset();
          continue;
        }
        const auto profile = kProfiles[layer];
        const bool recovery = frame % 8 == 0 || !encoders[layer];
        if (!encoders[layer]) {
          encoders[layer] = std::make_unique<Vp8Encoder>(
              profile.width, profile.height, 30, profile.bitrate);
        }
        DrawFrame(pixels, profile, frame);
        const auto packet = encoders[layer]->Encode(
            pixels.data(), profile.width, timestamp100ns, recovery);
        if (Clock::now() >= deadline) throw std::runtime_error("Fixture deadline exceeded");
        WriteFrame(frame, layer, profile, timestamp100ns * 100, packet);
      }
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
