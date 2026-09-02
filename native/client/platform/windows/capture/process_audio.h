#pragma once

#include <windows.h>

#include <cstdint>
#include <functional>

namespace screener::capture {

constexpr UINT32 kAudioSampleRate = 48'000;
constexpr UINT16 kAudioChannels = 2;
constexpr UINT16 kAudioBytesPerSample = 2;
constexpr UINT32 kAudioFramesPerChunk = 960;
constexpr DWORD kAudioBytesPerChunk =
    kAudioFramesPerChunk * kAudioChannels * kAudioBytesPerSample;
constexpr UINT64 kAudioChunkDuration100ns = 200'000;

using PCMWriter =
    std::function<HRESULT(UINT64 timestamp100ns, const BYTE* data, DWORD size)>;

int WriteWindowList();
HRESULT ValidateWindowTarget(UINT64 window_handle, DWORD pid,
                             UINT64 expected_creation_time);
HRESULT CaptureProcessAudio(DWORD pid, UINT64 expected_creation_time,
                            HANDLE stop_event, const PCMWriter& writer);

}  // namespace screener::capture
