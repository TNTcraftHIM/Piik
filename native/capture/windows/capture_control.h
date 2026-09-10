#pragma once

#include <cstdint>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace piik::capture {

constexpr int kMaxOutputs = 6;

struct CaptureControl final {
  char kind = 'Q';
  int layer = -1;
  uint32_t value = 0;
};

// Control payload grammar inside one SMED input envelope.
class CaptureControls final {
 public:
  static CaptureControl Parse(std::string_view text) {
    if (text.empty() || text.size() > 64) throw std::runtime_error("Invalid capture control size");
    for (unsigned char byte : text) {
      if (byte < 32 || byte > 126) throw std::runtime_error("Invalid capture control text");
    }
    std::istringstream input{std::string(text)};
    CaptureControl control;
    std::string kind;
    int64_t value = 0;
    bool valid = static_cast<bool>(input >> kind) && kind.size() == 1;
    control.kind = kind.empty() ? 0 : kind.front();
    switch (control.kind) {
      case 'Q': break;
      case 'K':
        valid = valid && static_cast<bool>(input >> control.layer) &&
                control.layer >= -1 && control.layer < kMaxOutputs;
        break;
      case 'A':
        valid = valid && static_cast<bool>(input >> control.layer >> value) &&
                control.layer >= 0 && control.layer < kMaxOutputs && value >= 0 && value <= 1;
        control.value = static_cast<uint32_t>(value);
        break;
      case 'B':
        valid = valid && static_cast<bool>(input >> control.layer >> value) &&
                control.layer >= 0 && control.layer < kMaxOutputs && value >= 1'000 &&
                value <= UINT32_MAX;
        control.value = static_cast<uint32_t>(value);
        break;
      default: valid = false;
    }
    input >> std::ws;
    if (!valid || !input.eof()) throw std::runtime_error("Invalid capture control command");
    return control;
  }
};

}  // namespace piik::capture
