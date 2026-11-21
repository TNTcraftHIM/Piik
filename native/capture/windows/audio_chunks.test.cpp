#include "audio_chunks.h"

#include <array>
#include <cassert>

using namespace piik::capture;

int main() {
  constexpr auto timestamp_error = AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR;
  constexpr auto silent = AUDCLNT_BUFFERFLAGS_SILENT;
  constexpr auto discontinuity = AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY;
  constexpr auto half_frames = kAudioFramesPerChunk / 2;
  constexpr auto half_bytes = kAudioBytesPerChunk / 2;
  constexpr auto half_duration = kAudioChunkDuration100ns / 2;
  std::array<BYTE, kAudioBytesPerChunk> pcm;
  pcm.fill(42);
  AudioChunks chunks;

  const auto before = static_cast<UINT64>(MFGetSystemTime());
  chunks.Append(pcm.data(), half_frames, timestamp_error, 1);
  const auto after = static_cast<UINT64>(MFGetSystemTime());
  const auto first = chunks.Timestamp();
  assert(first + half_duration >= before && first + half_duration <= after);
  assert(chunks.Next() == nullptr);

  chunks.Append(nullptr, half_frames, silent | timestamp_error, 2);
  const auto* chunk = chunks.Next();
  assert(chunk != nullptr && chunks.Timestamp() == first);
  for (size_t i = 0; i < kAudioBytesPerChunk; ++i) {
    assert(chunk[i] == (i < half_bytes ? 42 : 0));
  }
  chunks.Consume();
  chunks.Append(pcm.data(), kAudioFramesPerChunk, timestamp_error, 3);
  assert(chunks.Next() != nullptr && chunks.Timestamp() == first + kAudioChunkDuration100ns);
  chunks.Consume();

  chunks.Append(pcm.data(), half_frames, timestamp_error, 4);
  pcm.fill(7);
  const auto reset_before = static_cast<UINT64>(MFGetSystemTime());
  chunks.Append(pcm.data(), kAudioFramesPerChunk, discontinuity | timestamp_error, 5);
  const auto reset_after = static_cast<UINT64>(MFGetSystemTime());
  chunk = chunks.Next();
  assert(chunk != nullptr && chunk[0] == 7 && chunk[kAudioBytesPerChunk - 1] == 7);
  const auto restarted = chunks.Timestamp();
  assert(restarted + kAudioChunkDuration100ns >= reset_before &&
         restarted + kAudioChunkDuration100ns <= reset_after);
  chunks.Consume();
  assert(chunks.Next() == nullptr);

  const auto trusted_qpc = restarted + kAudioChunkDuration100ns + 1'000;
  chunks.Append(pcm.data(), kAudioFramesPerChunk, 0, trusted_qpc);
  assert(chunks.Next() != nullptr && chunks.Timestamp() == trusted_qpc);
}
