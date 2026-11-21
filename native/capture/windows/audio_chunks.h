#pragma once

#include "process_audio.h"

#include <audioclient.h>
#include <mfidl.h>

#include <vector>

namespace piik::capture {

class AudioChunks {
 public:
  void Append(const BYTE* data, UINT32 frames, DWORD flags, UINT64 qpc) {
    if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
      pending_.clear();
      consumed_ = 0;
      timestamp_ = 0;
    }
    if (pending_.size() == consumed_) {
      pending_.clear();
      consumed_ = 0;
      if ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0) {
        timestamp_ = qpc;
      } else if (timestamp_ == 0) {
        // Estimate the first sample's time using the packet duration and QPC.
        const auto now = static_cast<UINT64>(MFGetSystemTime());
        const auto duration = static_cast<UINT64>(frames) * 10'000'000 / kAudioSampleRate;
        timestamp_ = now > duration ? now - duration : 1;
      }
    }
    const auto bytes = static_cast<size_t>(frames) * kAudioChannels * kAudioBytesPerSample;
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
      pending_.insert(pending_.end(), bytes, 0);
    } else {
      pending_.insert(pending_.end(), data, data + bytes);
    }
  }

  const BYTE* Next() const {
    return pending_.size() - consumed_ >= kAudioBytesPerChunk
               ? pending_.data() + consumed_
               : nullptr;
  }

  UINT64 Timestamp() const { return timestamp_; }

  void Consume() {
    consumed_ += kAudioBytesPerChunk;
    timestamp_ += kAudioChunkDuration100ns;
  }

  void Compact() {
    if (consumed_ > kAudioBytesPerChunk * 4) {
      pending_.erase(pending_.begin(), pending_.begin() + static_cast<ptrdiff_t>(consumed_));
      consumed_ = 0;
    }
  }

 private:
  std::vector<BYTE> pending_;
  size_t consumed_ = 0;
  UINT64 timestamp_ = 0;
};

}  // namespace piik::capture
