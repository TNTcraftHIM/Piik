#include "vp8_encoder.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#endif

using Clock = std::chrono::steady_clock;
using piik::capture::Vp8Encoder;

namespace {

constexpr int kFps = 30;
constexpr int kClipFrames = 32;
constexpr double kFrameMs = 1000.0 / kFps;
// Measurement fixtures, not an application bitrate ladder.
struct Profile { unsigned width, height, bitrate; };
constexpr std::array<Profile, 3> kProfiles{{
    {480, 270, 312'500}, {960, 540, 1'250'000}, {1920, 1080, 5'000'000}}};
using Clip = std::vector<std::vector<uint8_t>>;

double Milliseconds(Clock::duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}

double CpuMilliseconds() {
#ifdef _WIN32
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {
    throw std::runtime_error("GetProcessTimes failed");
  }
  auto ticks = [](FILETIME value) {
    return (static_cast<uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
  };
  return static_cast<double>(ticks(kernel) + ticks(user)) / 10'000;
#else
  return 1000.0 * std::clock() / CLOCKS_PER_SEC;
#endif
}

uint64_t CpuCycles() {
#ifdef _WIN32
  ULONG64 cycles = 0;
  if (!QueryProcessCycleTime(GetCurrentProcess(), &cycles)) {
    throw std::runtime_error("QueryProcessCycleTime failed");
  }
  return cycles;
#else
  return 0;
#endif
}

size_t ResidentBytes() {
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS counters{};
  if (!GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters))) {
    throw std::runtime_error("GetProcessMemoryInfo failed");
  }
  return counters.WorkingSetSize;
#else
  return 0;
#endif
}

Clip MakeClip(Profile profile, bool motion) {
  Clip clip(kClipFrames);
  for (int frame = 0; frame < kClipFrames; ++frame) {
    auto& pixels = clip[frame];
    pixels.assign(static_cast<size_t>(profile.width) * profile.height * 3 / 2, 128);
    for (unsigned y = 0; y < profile.height; ++y) {
      for (unsigned x = 0; x < profile.width; ++x) {
        const unsigned shift = motion || (x < profile.width / 16 && y < profile.height / 16)
                                   ? static_cast<unsigned>(frame) * 4 : 0;
        const unsigned u = (x * 1920 / profile.width + shift) % 128;
        const unsigned v = (y * 1080 / profile.height) % 128;
        pixels[static_cast<size_t>(y) * profile.width + x] =
            static_cast<uint8_t>(32 + ((u / 8) ^ (v / 8)) * 8 + ((u ^ v) & 31) * 2);
      }
    }
  }
  return clip;
}

struct Stats {
  std::vector<double> work;
  double cpu_ms = 0;
  uint64_t cpu_cycles = 0;
  double init_ms = 0;
  int creates = 0;
  std::array<int, 4> encodes{};
  std::array<uint64_t, 4> bytes{};
};

template <typename T, size_t N>
void PrintArray(const std::array<T, N>& values) {
  std::cout << '[';
  for (size_t i = 0; i < N; ++i) std::cout << (i ? "," : "") << values[i];
  std::cout << ']';
}

void PrintStats(const Stats& stats) {
  auto sorted = stats.work;
  std::sort(sorted.begin(), sorted.end());
  const double media_ms = static_cast<double>(sorted.size()) * kFrameMs;
  std::cout << "{\"sourceFrames\":" << sorted.size()
            << ",\"workMeanMs\":" << std::accumulate(sorted.begin(), sorted.end(), 0.0) / sorted.size()
            << ",\"workP95Ms\":" << sorted[static_cast<size_t>(std::ceil(sorted.size() * 0.95)) - 1]
            << ",\"workOverFrameBudget\":" << std::count_if(sorted.begin(), sorted.end(), [](double value) { return value > kFrameMs; })
            << ",\"cpuMs\":" << stats.cpu_ms
            << ",\"cpuCyclesPerFrame\":" << static_cast<double>(stats.cpu_cycles) / sorted.size()
            << ",\"cpuCoresAt30Fps\":" << stats.cpu_ms / media_ms
            << ",\"createCount\":" << stats.creates << ",\"createMs\":" << stats.init_ms
            << ",\"encodedFrames\":";
  PrintArray(stats.encodes);
  std::cout << ",\"encodedBytes\":";
  PrintArray(stats.bytes);
  std::cout << '}';
}

struct Transition { int frame, layer; double ready_ms; size_t bytes; };

void Run(const std::string& scenario, const std::string& scene) {
  const bool warm = scenario == "exact-warm" || scenario == "warm-clock-ablation";
  const bool trace = scenario == "envelope" || scenario == "exact-cold" || warm;
  unsigned fixed_mask = 0;
  if (scenario == "high") fixed_mask = 4;
  if (scenario == "two-high") fixed_mask = 12;
  if (scenario == "high-low") fixed_mask = 5;
  if (scenario == "all") fixed_mask = 7;
  if (scenario == "mid-low") fixed_mask = 3;
  if (scenario == "low") fixed_mask = 1;
  if ((!trace && fixed_mask == 0) || (scene != "motion" && scene != "still")) {
    throw std::runtime_error("Unknown scenario or scene");
  }
  // Same scene at each size; preparation is excluded, no scaler is being measured.
  std::array<Clip, 3> clips;
  for (size_t i = 0; i < clips.size(); ++i) clips[i] = MakeClip(kProfiles[i], scene == "motion");
  const size_t input_resident = ResidentBytes();
  std::array<std::unique_ptr<Vp8Encoder>, 4> encoders;
  std::array<uint64_t, 4> codec_frames{};
  constexpr std::array<std::array<int, 2>, 7> demands{{
      {2, 2}, {2, 0}, {0, 0}, {1, 1}, {2, 2}, {2, 0}, {2, 2}}};
  const int frames = trace ? static_cast<int>(demands.size()) * 60 : 120;
  std::array<int, 2> previous_demand{-1, -1};
  unsigned previous_active = 0;
  std::vector<Transition> transitions;
  std::vector<Stats> phases(trace ? demands.size() : 1);
  Stats total;
  const auto started = Clock::now();
  double phase_cpu_start = CpuMilliseconds();
  uint64_t phase_cycles_start = CpuCycles();
  for (int frame = 0; frame < frames; ++frame) {
    if (Clock::now() - started > std::chrono::seconds(30)) throw std::runtime_error("Probe deadline exceeded");
    const size_t phase = trace ? static_cast<size_t>(frame / 60) : 0;
    unsigned active = fixed_mask;
    unsigned switched = 0;
    if (trace) {
      const auto& demand = demands[phase];
      active = (1u << demand[0]) | (1u << demand[1]);
      if (scenario == "envelope") active = (1u << (std::max(demand[0], demand[1]) + 1)) - 1;
      for (size_t child = 0; child < demand.size(); ++child) {
        if (demand[child] != previous_demand[child]) switched |= 1u << demand[child];
      }
      previous_demand = demand;
    }
    const bool measured = trace || frame >= 30;
    const auto tick = Clock::now();
    Stats step;
    // Serial scheduling keeps the probe bounded; parallel encoder scheduling is not measured.
    for (int slot = 3; slot >= 0; --slot) {
      const unsigned bit = 1u << slot;
      if (!(active & bit)) {
        if (!warm) encoders[slot].reset();
        continue;
      }
      const size_t layer = static_cast<size_t>(std::min(slot, 2));
      const auto profile = kProfiles[layer];
      if (!encoders[slot]) {
        const auto init = Clock::now();
        encoders[slot] = std::make_unique<Vp8Encoder>(profile.width, profile.height, kFps, profile.bitrate);
        step.init_ms += Milliseconds(Clock::now() - init);
        ++step.creates;
      }
      const bool keyframe = !(previous_active & bit) || (switched & bit);
      // Isolate codec timestamp-gap effects only; not a proposed media clock policy.
      const uint64_t pts_frame = scenario == "warm-clock-ablation" ? codec_frames[slot] : static_cast<uint64_t>(frame);
      auto packet = encoders[slot]->Encode(clips[layer][frame % kClipFrames].data(), profile.width,
                                          pts_frame * 10'000'000 / kFps, keyframe);
      ++codec_frames[slot];
      ++step.encodes[slot];
      step.bytes[slot] += packet.bytes.size();
      if (switched & bit) {
        if (!packet.key_frame) throw std::runtime_error("Switch lacked a keyframe");
        transitions.push_back({frame, slot, Milliseconds(Clock::now() - tick), packet.bytes.size()});
      }
    }
    const double work_ms = Milliseconds(Clock::now() - tick);
    if (measured) {
      for (Stats* stats : {&total, &phases[phase]}) {
        stats->work.push_back(work_ms);
        stats->init_ms += step.init_ms;
        stats->creates += step.creates;
        for (size_t i = 0; i < step.encodes.size(); ++i) {
          stats->encodes[i] += step.encodes[i];
          stats->bytes[i] += step.bytes[i];
        }
      }
    }
    previous_active = active;
    std::this_thread::sleep_until(started + std::chrono::microseconds(static_cast<int64_t>(frame + 1) * 1'000'000 / kFps));
    // Whole windows include worker spin/wakeup cost and avoid per-call CPU tick quantization.
    if (!trace && frame == 29) {
      phase_cpu_start = CpuMilliseconds();
      phase_cycles_start = CpuCycles();
    }
    if ((trace && (frame + 1) % 60 == 0) || frame + 1 == frames) {
      const double cpu_now = CpuMilliseconds();
      const uint64_t cycles_now = CpuCycles();
      phases[phase].cpu_ms = cpu_now - phase_cpu_start;
      phases[phase].cpu_cycles = cycles_now - phase_cycles_start;
      total.cpu_ms += phases[phase].cpu_ms;
      total.cpu_cycles += phases[phase].cpu_cycles;
      phase_cpu_start = cpu_now;
      phase_cycles_start = cycles_now;
    }
  }
  const size_t active_resident = ResidentBytes();
  for (auto& encoder : encoders) encoder.reset();
  const size_t stopped_resident = ResidentBytes();
  std::cout << std::fixed << std::setprecision(3)
            << "{\"scenario\":\"" << scenario << "\",\"scene\":\"" << scene
            << "\",\"codec\":\"" << Vp8Encoder::Version() << "\",\"summary\":";
  PrintStats(total);
  std::cout << ",\"inputResidentBytes\":" << input_resident << ",\"activeResidentBytes\":" << active_resident
            << ",\"stoppedResidentBytes\":" << stopped_resident << ",\"phases\":[";
  for (size_t i = 0; i < phases.size(); ++i) {
    if (i) std::cout << ',';
    PrintStats(phases[i]);
  }
  std::cout << "],\"transitions\":[";
  for (size_t i = 0; i < transitions.size(); ++i) {
    const auto& value = transitions[i];
    if (i) std::cout << ',';
    std::cout << "{\"frame\":" << value.frame << ",\"layer\":" << value.layer
              << ",\"keyframeReadyMs\":" << value.ready_ms << ",\"keyframeBytes\":" << value.bytes << '}';
  }
  std::cout << "]}\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc != 3) throw std::runtime_error("Usage: encoded-variants.probe <scenario> <still|motion>");
    Run(argv[1], argv[2]);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
