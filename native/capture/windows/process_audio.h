#pragma once

#include <windows.h>

#include <cstdint>
#include <functional>

namespace piik::capture {

constexpr UINT32 kAudioSampleRate = 48'000;
constexpr UINT16 kAudioChannels = 2;
constexpr UINT16 kAudioBytesPerSample = 2;
constexpr UINT32 kAudioFramesPerChunk = 960;
constexpr DWORD kAudioBytesPerChunk =
    kAudioFramesPerChunk * kAudioChannels * kAudioBytesPerSample;
constexpr UINT64 kAudioChunkDuration100ns = 200'000;

using PCMWriter =
    std::function<HRESULT(UINT64 timestamp100ns, const BYTE* data, DWORD size)>;
using ReadyWriter = std::function<HRESULT()>;
using StopProbe = std::function<bool()>;

bool ProcessAudioAvailable();
bool SystemAudioAvailable();
HRESULT CaptureProcessAudio(DWORD pid, UINT64 expected_creation_time,
                            HANDLE stop_event, const StopProbe& stop_probe,
                            const ReadyWriter& ready_writer,
                            const PCMWriter& writer);
HRESULT CaptureSystemAudio(HANDLE stop_event, const StopProbe& stop_probe,
                           const ReadyWriter& ready_writer,
                           const PCMWriter& writer);

}  // namespace piik::capture
