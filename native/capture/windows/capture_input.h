#pragma once

#include "capture_control.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace screener::capture {

struct InputEnvelope final {
  uint8_t kind = 0;
  bool recovery = false;
  uint64_t timestamp = 0;
  uint64_t duration = 0;
  uint16_t width = 0;
  uint16_t height = 0;
  std::vector<uint8_t> data;

  CaptureControl Control() const {
    if (kind != 7) throw std::runtime_error("Expected a capture control envelope");
    return CaptureControls::Parse(std::string_view(
        reinterpret_cast<const char*>(data.data()), data.size()));
  }
};

// The private stdin contract has one framing format for controls and encoded AUs.
// Retain at most one incomplete, bounded envelope between pipe reads.
class InputEnvelopes final {
 public:
  bool Empty() const { return header_size_ == 0 && frame_.data.empty(); }

  std::vector<InputEnvelope> Feed(std::string_view bytes) {
    std::vector<InputEnvelope> frames;
    while (!bytes.empty()) {
      if (header_size_ < header_.size()) {
        const size_t take = std::min(header_.size() - header_size_, bytes.size());
        std::copy_n(bytes.data(), take, header_.data() + header_size_);
        header_size_ += take;
        bytes.remove_prefix(take);
        if (header_size_ != header_.size()) break;
        ReadHeader();
      }
      const size_t take = std::min(payload_size_ - frame_.data.size(), bytes.size());
      frame_.data.insert(frame_.data.end(), bytes.data(), bytes.data() + take);
      bytes.remove_prefix(take);
      if (frame_.data.size() == payload_size_) {
        if (frame_.kind == 7) (void)frame_.Control();
        frames.push_back(std::move(frame_));
        frame_ = {};
        header_size_ = 0;
      }
    }
    return frames;
  }

 private:
  uint64_t ReadBE(size_t offset, size_t count) const {
    uint64_t result = 0;
    for (size_t index = 0; index < count; ++index) result = result << 8 | header_[offset + index];
    return result;
  }

  void ReadHeader() {
    frame_.kind = header_[5];
    frame_.recovery = header_[6] == 1;
    frame_.timestamp = ReadBE(8, 8);
    frame_.duration = ReadBE(16, 8);
    frame_.width = static_cast<uint16_t>(ReadBE(24, 2));
    frame_.height = static_cast<uint16_t>(ReadBE(26, 2));
    payload_size_ = static_cast<size_t>(ReadBE(28, 4));
    if (header_[0] != 'S' || header_[1] != 'M' || header_[2] != 'E' || header_[3] != 'D' ||
        header_[4] != 2 || header_[7] != 0 || payload_size_ == 0) {
      throw std::runtime_error("Invalid native input envelope");
    }
    if (frame_.kind == 7) {
      if (header_[6] != 0 || frame_.timestamp != 0 || frame_.duration != 0 ||
          frame_.width != 0 || frame_.height != 0 || payload_size_ > 64) {
        throw std::runtime_error("Invalid native control envelope");
      }
    } else if ((frame_.kind != 2 && frame_.kind != 4) || header_[6] > 1 ||
               frame_.duration == 0 || frame_.timestamp > static_cast<uint64_t>(INT64_MAX) / 100 ||
               frame_.duration > static_cast<uint64_t>(INT64_MAX) / 100 ||
               frame_.width < 2 || frame_.height < 2 || frame_.width > 2560 || frame_.height > 1440 ||
               (frame_.width & 1) || (frame_.height & 1) || payload_size_ > 4 * 1024 * 1024) {
      throw std::runtime_error("Invalid native encoded input");
    }
    frame_.data.reserve(payload_size_);
  }

  std::array<uint8_t, 32> header_{};
  size_t header_size_ = 0;
  size_t payload_size_ = 0;
  InputEnvelope frame_;
};

}  // namespace screener::capture
