// Explicit synthetic experiment. Not part of Client, Server, unit tests or CI.
#include "pool.h"
#include "h264_encoder_adapter.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <exception>
#include <fstream>
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

#include "api/environment/environment_factory.h"
#include "api/field_trials_view.h"
#include "api/make_ref_counted.h"
#include "api/task_queue/task_queue_base.h"
#include "api/task_queue/task_queue_factory.h"
#include "api/video/builtin_video_bitrate_allocator_factory.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_adapter.h"
#include "api/video/video_frame.h"
#include "api/video/video_stream_encoder_settings.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/video_decoder.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "call/video_send_stream.h"
#include "system_wrappers/include/clock.h"
#include "video/adaptation/overuse_frame_detector.h"
#include "video/frame_cadence_adapter.h"
#include "video/send_statistics_proxy.h"
#include "video/video_stream_encoder.h"
#include "vpx/vpx_decoder.h"
#include "vpx/vp8dx.h"

namespace {
using namespace webrtc;
constexpr int kWidth = 640;
constexpr int kHeight = 360;
constexpr int kFps = 30;

class Trials final : public FieldTrialsView {
 public:
  explicit Trials(bool disable) : disable_(disable) {}
  std::string Lookup(absl::string_view key) const override {
    return disable_ && key == "WebRTC-VideoRateControl" ? "bitrate_adjuster:false" : "";
  }
 private:
  bool disable_;
};

template <typename F>
void Sync(TaskQueueBase* queue, F fn) {
  auto completion = std::make_shared<std::promise<void>>();
  auto future = completion->get_future();
  queue->PostTask([completion, fn = std::move(fn)]() mutable {
    try {
      fn();
      completion->set_value();
    } catch (...) {
      completion->set_exception(std::current_exception());
    }
  });
  if (future.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
    throw std::runtime_error("task queue deadline exceeded");
  future.get();
}

uint64_t HashBytes(uint64_t hash, const uint8_t* bytes, size_t count) {
  for (size_t i = 0; i < count; ++i) hash = (hash ^ bytes[i]) * 1099511628211ULL;
  return hash;
}

struct FrameProof {
  uint64_t payload = 0;
  uint64_t pixels = 0;
  int width = 0;
  int height = 0;
};

class SharedProof {
 public:
  void Observe(int consumer, uint32_t timestamp, FrameProof proof) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& row = pending_[timestamp];
    row[consumer] = proof;
    if (row[0].payload && row[1].payload) {
      if (row[0].payload == row[1].payload) {
        ++compared;
        if (row[0].pixels && row[1].pixels) {
          ++decodedCompared;
          if (row[0].pixels != row[1].pixels || row[0].width != row[1].width ||
              row[0].height != row[1].height) ++mismatches;
        }
      }
      pending_.erase(timestamp);
    }
    while (pending_.size() > 64) pending_.erase(pending_.begin());
  }
  std::atomic<int> compared{0};
  std::atomic<int> decodedCompared{0};
  std::atomic<int> mismatches{0};

 private:
  std::mutex mutex_;
  std::map<uint32_t, std::array<FrameProof, 2>> pending_;
};

struct Counts {
  int encoded = 0;
  int decoded = 0;
  int errors = 0;
  int keyframes = 0;
  int width = 0;
  int height = 0;
  int min_width = kWidth;
  int min_height = kHeight;
  uint64_t bytes = 0;
  double first_full_ms = -1;
  double first_reduced_ms = -1;
};

class Sink final : public VideoStreamEncoderInterface::EncoderSink,
                   public DecodedImageCallback {
 public:
  Sink(const Environment& env, int consumer, SharedProof& proof, bool h264 = false)
      : consumer_(consumer), proof_(proof) {
    if (h264) return;  // The pinned SDK has no H264 decoder; export to Browser WebCodecs.
    auto factory = CreateBuiltinVideoDecoderFactory();
    decoder_ = factory->Create(env, SdpVideoFormat("VP8"));
    VideoDecoder::Settings settings;
    settings.set_codec_type(kVideoCodecVP8);
    settings.set_number_of_cores(1);
    if (!decoder_ || !decoder_->Configure(settings) ||
        decoder_->RegisterDecodeCompleteCallback(this) != 0)
      throw std::runtime_error("VP8 decoder initialization failed");
    vpx_codec_dec_cfg_t raw_config{1, 0, 0};
    if (vpx_codec_dec_init(&raw_, vpx_codec_vp8_dx(), &raw_config, 0) != VPX_CODEC_OK)
      throw std::runtime_error("raw VP8 decoder initialization failed");
  }

  ~Sink() override {
    if (decoder_) { decoder_->Release(); vpx_codec_destroy(&raw_); }
  }

  void OnEncoderConfigurationChanged(std::vector<VideoStream>, bool,
                                    VideoEncoderConfig::ContentType, int) override {}
  void OnBitrateAllocationUpdated(const VideoBitrateAllocation&) override {}
  void OnVideoLayersAllocationUpdated(VideoLayersAllocation) override {}
  void OnFrameDropped(uint32_t, int, bool) override {}

  Result OnEncodedImage(const EncodedImage& image,
                        const CodecSpecificInfo*) override {
    std::lock_guard<std::mutex> lock(mutex_);
    ++counts_.encoded;
    counts_.bytes += image.size();
    counts_.keyframes += image.IsKey();
    if (export_.is_open() && counts_.encoded <= 180) {
      constexpr char hex[] = "0123456789abcdef";
      std::string data;
      data.reserve(image.size() * 2);
      for (uint8_t byte : image) {
        data.push_back(hex[byte >> 4]);
        data.push_back(hex[byte & 15]);
      }
      export_ << "{\"index\":" << counts_.encoded - 1
              << ",\"width\":" << image._encodedWidth
              << ",\"height\":" << image._encodedHeight
              << ",\"recovery\":" << (image.IsKey() ? "true" : "false")
              << ",\"dataHex\":\"" << data << "\"}\n";
      if (!export_) ++counts_.errors;
    }
    current_timestamp_ = image.RtpTimestamp();
    current_payload_ = HashBytes(1469598103934665603ULL, image.data(), image.size());
    if (!decoder_) {
      RecordSize(image._encodedWidth, image._encodedHeight);
      proof_.Observe(consumer_, current_timestamp_,
          {current_payload_, 0, static_cast<int>(image._encodedWidth), static_cast<int>(image._encodedHeight)});
    } else if (decoder_->Decode(image, 0) < 0) ++counts_.errors;
    if (decoder_ && vpx_codec_decode(&raw_, image.data(), static_cast<unsigned>(image.size()), nullptr, 0) != VPX_CODEC_OK) {
      ++counts_.errors;
    } else if (decoder_) {
      vpx_codec_iter_t iterator = nullptr;
      if (const auto* raw = vpx_codec_get_frame(&raw_, &iterator)) {
        uint64_t hash = 1469598103934665603ULL;
        for (int plane = 0; plane < 3; ++plane) {
          const unsigned width = plane ? (raw->d_w + 1) / 2 : raw->d_w;
          const unsigned height = plane ? (raw->d_h + 1) / 2 : raw->d_h;
          for (unsigned y = 0; y < height; ++y)
            hash = HashBytes(hash, raw->planes[plane] + y * raw->stride[plane], width);
        }
        proof_.Observe(consumer_, current_timestamp_,
            {current_payload_, hash, static_cast<int>(raw->d_w), static_cast<int>(raw->d_h)});
      } else ++counts_.errors;
    }
    if (duplicate_) duplicate_->OnEncodedImage(image, nullptr);
    return Result(Result::OK);
  }

  // The selected built-in VP8 decoder completes synchronously inside Decode.
  int32_t Decoded(VideoFrame& frame) override {
    ++counts_.decoded;
    RecordSize(frame.width(), frame.height());
    return 0;
  }

  void RecordSize(int width, int height) {
    counts_.width = width;
    counts_.height = height;
    counts_.min_width = std::min(counts_.min_width, width);
    counts_.min_height = std::min(counts_.min_height, height);
    const double elapsed = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - phase_started_).count();
    if (width == kWidth && height == kHeight && counts_.first_full_ms < 0)
      counts_.first_full_ms = elapsed;
    if (width < kWidth && counts_.first_reduced_ms < 0)
      counts_.first_reduced_ms = elapsed;
  }

  Counts Snapshot() {
    std::lock_guard<std::mutex> lock(mutex_);
    return counts_;
  }
  void Export(const std::string& path) {
    export_.open(path, std::ios::binary | std::ios::trunc);
    if (!export_) throw std::runtime_error("fixture export unavailable");
  }
  void SetDuplicate(Sink* sink) {
    std::lock_guard<std::mutex> lock(mutex_);
    duplicate_ = sink;
  }
  void FinishExport() {
    if (!export_.is_open()) return;
    export_.flush();
    export_.close();
    if (!export_ || counts_.encoded < 180)
      throw std::runtime_error("fixture export incomplete");
  }
  void ResetMinimum() {
    std::lock_guard<std::mutex> lock(mutex_);
    counts_.min_width = kWidth;
    counts_.min_height = kHeight;
    counts_.first_full_ms = -1;
    counts_.first_reduced_ms = -1;
    phase_started_ = std::chrono::steady_clock::now();
  }

 private:
  const int consumer_;
  SharedProof& proof_;
  std::mutex mutex_;
  std::unique_ptr<VideoDecoder> decoder_;
  vpx_codec_ctx_t raw_{};
  std::ofstream export_;
  Sink* duplicate_ = nullptr;
  Counts counts_;
  uint32_t current_timestamp_ = 0;
  uint64_t current_payload_ = 0;
  std::chrono::steady_clock::time_point phase_started_ = std::chrono::steady_clock::now();
};

// Each sender applies stock VideoAdapter wants to the same original input.
class Source final : public VideoSourceInterface<VideoFrame> {
 public:
  void AddOrUpdateSink(VideoSinkInterface<VideoFrame>* sink,
                       const VideoSinkWants& wants) override {
    sink_ = sink;
    adapter_.OnSinkWants(wants);
    ++wants_updates;
    min_pixels = std::min(min_pixels, wants.max_pixel_count);
  }
  void RemoveSink(VideoSinkInterface<VideoFrame>* sink) override {
    if (sink_ == sink) sink_ = nullptr;
  }
  void Push(const VideoFrame& original) {
    if (!sink_) return;
    int crop_width, crop_height, width, height;
    if (!adapter_.AdaptFrameResolution(original.width(), original.height(),
                                       original.timestamp_us() * 1000,
                                       &crop_width, &crop_height, &width, &height)) {
      ++dropped;
      sink_->OnDiscardedFrame();
      return;
    }
    VideoFrame frame = original;
    if (width != original.width() || height != original.height() ||
        crop_width != original.width() || crop_height != original.height()) {
      auto scaled = I420Buffer::Create(width, height);
      scaled->CropAndScaleFrom(*original.video_frame_buffer()->ToI420(),
                               (original.width() - crop_width) / 2,
                               (original.height() - crop_height) / 2,
                               crop_width, crop_height);
      frame.set_video_frame_buffer(scaled);
    }
    sink_->OnFrame(frame);
  }
  int dropped = 0;
  int wants_updates = 0;
  int min_pixels = kWidth * kHeight;

 private:
  VideoSinkInterface<VideoFrame>* sink_ = nullptr;
  VideoAdapter adapter_{2};
};

struct Pipeline {
  Source source;
  std::unique_ptr<SendStatisticsProxy> stats;
  std::unique_ptr<Sink> sink;
  std::unique_ptr<VideoStreamEncoder> encoder;
  TaskQueueBase* encode_queue = nullptr;
};

VideoEncoderConfig Config(const SdpVideoFormat& format) {
  VideoEncoderConfig config;
  config.codec_type = format.name == "H264" ? kVideoCodecH264 : kVideoCodecVP8;
  config.video_format = format;
  config.content_type = VideoEncoderConfig::ContentType::kRealtimeVideo;
  config.number_of_streams = 1;
  config.max_bitrate_bps = 2'000'000;
  config.frame_drop_enabled = true;
  config.is_quality_scaling_allowed = true;
  config.simulcast_layers.resize(1);
  config.simulcast_layers[0].active = true;
  config.simulcast_layers[0].max_framerate = kFps;
  config.simulcast_layers[0].max_bitrate_bps = 2'000'000;
  config.simulcast_layers[0].num_temporal_layers = 1;
  if (config.codec_type == kVideoCodecVP8) {
    auto vp8 = VideoEncoder::GetDefaultVp8Settings();
    vp8.automaticResizeOn = true;
    config.encoder_specific_settings =
        make_ref_counted<VideoEncoderConfig::Vp8EncoderSpecificSettings>(vp8);
  }
  return config;
}

void Start(Pipeline& pipeline, const Environment& env, PoolFactory& factory,
           VideoBitrateAllocatorFactory* allocator, int consumer, SharedProof& proof) {
  VideoSendStream::Config send_config(nullptr);
  const auto format = factory.GetSupportedFormats().front();
  send_config.rtp.ssrcs = {static_cast<uint32_t>(100 + consumer)};
  send_config.rtp.payload_name = format.name;
  send_config.rtp.payload_type = 96;
  pipeline.stats = std::make_unique<SendStatisticsProxy>(
      &env.clock(), send_config, VideoEncoderConfig::ContentType::kRealtimeVideo,
      env.field_trials());
  pipeline.sink = std::make_unique<Sink>(env, consumer, proof, format.name == "H264");
  VideoStreamEncoderSettings settings(VideoEncoder::Capabilities(false));
  settings.encoder_factory = &factory;
  settings.bitrate_allocator_factory = allocator;
  auto queue = env.task_queue_factory().CreateTaskQueue(
      "PoolProbeEncoder", TaskQueueFactory::Priority::kNormal);
  pipeline.encode_queue = queue.get();
  auto cadence = FrameCadenceAdapterInterface::Create(
      &env.clock(), queue.get(), nullptr, TaskQueueBase::Current(), env.field_trials());
  pipeline.encoder = std::make_unique<VideoStreamEncoder>(
      env, 1, pipeline.stats.get(), settings,
      std::make_unique<OveruseFrameDetector>(env, pipeline.stats.get()),
      std::move(cadence), std::move(queue),
      VideoStreamEncoder::BitrateAllocationCallbackType::kVideoBitrateAllocation);
  pipeline.encoder->SetSink(pipeline.sink.get(), false);
  pipeline.encoder->SetSource(&pipeline.source, DegradationPreference::MAINTAIN_FRAMERATE);
  pipeline.encoder->SetStartBitrate(2'000'000);
  pipeline.encoder->ConfigureEncoder(Config(format), 1200);
  pipeline.encoder->OnBitrateUpdated(DataRate::BitsPerSec(2'000'000),
                                     DataRate::BitsPerSec(2'000'000), 0, 20, 0);
}

VideoFrame MakeFrame(const Environment& env, int index) {
  auto pixels = I420Buffer::Create(kWidth, kHeight);
  for (int y = 0; y < kHeight; ++y) {
    for (int x = 0; x < kWidth; ++x) {
      const int shifted = x + index * 5;
      pixels->MutableDataY()[y * pixels->StrideY() + x] =
          static_cast<uint8_t>(32 + ((shifted * 3 + y * 2 +
                                      (((shifted / 23) ^ (y / 17)) & 7) * 19) % 192));
    }
  }
  for (int y = 0; y < kHeight / 2; ++y) {
    for (int x = 0; x < kWidth / 2; ++x) {
      pixels->MutableDataU()[y * pixels->StrideU() + x] =
          static_cast<uint8_t>(80 + (x + index * 2) % 96);
      pixels->MutableDataV()[y * pixels->StrideV() + x] =
          static_cast<uint8_t>(80 + (y + index) % 96);
    }
  }
  return VideoFrame::Builder().set_video_frame_buffer(pixels)
      .set_timestamp_us(env.clock().TimeInMicroseconds())
      .set_ntp_time_ms(env.clock().CurrentNtpInMilliseconds())
      .set_id(static_cast<uint16_t>(index)).build();
}

void PrintCounts(const Counts& before, const Counts& after, double seconds) {
  std::cout << "{\"encoded\":" << after.encoded - before.encoded
            << ",\"decoded\":" << after.decoded - before.decoded
            << ",\"fps\":" << (after.decoded - before.decoded) / seconds
            << ",\"kbps\":" << (after.bytes - before.bytes) * 0.008 / seconds
            << ",\"errors\":" << after.errors - before.errors
            << ",\"keyframes\":" << after.keyframes - before.keyframes
            << ",\"width\":" << after.width << ",\"height\":" << after.height
            << ",\"minWidth\":" << after.min_width
            << ",\"minHeight\":" << after.min_height
            << ",\"firstFullMs\":" << after.first_full_ms
            << ",\"firstReducedMs\":" << after.first_reduced_ms << '}';
}
}  // namespace

int main(int argc, char** argv) {
  try {
    const std::vector<std::string> args(argv + 1, argv + argc);
    const auto has = [&](const char* flag) { return std::find(args.begin(), args.end(), flag) != args.end(); };
    const bool pooled = has("--pooled");
    const bool group_adjuster = has("--group-adjuster");
    const bool no_adjuster = has("--no-adjuster") || group_adjuster;
    const bool healthy_only = has("--healthy-only");
    const bool realtime = has("--realtime");
    const bool latency_probe = has("--latency-probe");
    if (latency_probe && !realtime)
      throw std::runtime_error("--latency-probe requires --realtime");
    const bool shared_pipeline = has("--shared-pipeline");
    const bool h264 = has("--h264");
    if (h264 && (!shared_pipeline || !healthy_only || !has("--export")))
      throw std::runtime_error("--h264 requires --shared-pipeline --healthy-only --export PATH");
    if (shared_pipeline && (pooled || group_adjuster || no_adjuster || has("--unsafe-skip") ||
                            (!healthy_only && !latency_probe)))
      throw std::runtime_error("shared pipeline control requires a healthy/latency trace with stock VSE settings");
    const auto env = CreateEnvironment(std::make_unique<Trials>(no_adjuster));
    const bool unsafe_skip = has("--unsafe-skip");
    PoolFactory factory(pooled, group_adjuster, unsafe_skip,
        h264 ? piik::probe::CreateHardwareEncoderFactory() : nullptr);
    auto allocator = CreateBuiltinVideoBitrateAllocatorFactory();
    auto worker = env.task_queue_factory().CreateTaskQueue(
        "PoolProbeWorker", TaskQueueFactory::Priority::kNormal);
    SharedProof proof;
    std::array<Pipeline, 2> pipelines;
    Sync(worker.get(), [&] {
      Start(pipelines[0], env, factory, allocator.get(), 0, proof);
      if (shared_pipeline) {
        pipelines[1].sink = std::make_unique<Sink>(env, 1, proof, h264);
        pipelines[0].sink->SetDuplicate(pipelines[1].sink.get());
      } else Start(pipelines[1], env, factory, allocator.get(), 1, proof);
    });
    const auto export_arg = std::find(args.begin(), args.end(), "--export");
    if (export_arg != args.end()) {
      if (export_arg + 1 == args.end()) throw std::runtime_error("--export needs a path");
      pipelines[0].sink->Export(*(export_arg + 1));
    }
    int frame_index = 0;
    auto run = [&](const char* name, int seconds, int weak_bitrate, bool skip, bool retire) {
      Sync(worker.get(), [&] {
        if (retire) {
          if (shared_pipeline) pipelines[0].sink->SetDuplicate(nullptr);
          else {
            pipelines[1].encoder->Stop();
            pipelines[1].encoder.reset();
          }
        }
      });
      const auto a = pipelines[0].sink->Snapshot();
      const auto b = pipelines[1].sink->Snapshot();
      pipelines[0].sink->ResetMinimum();
      pipelines[1].sink->ResetMinimum();
      const int encodes = factory.encodes.load(), hits = factory.hits.load();
      const auto started = std::chrono::steady_clock::now();
      for (int frame = 0; frame < seconds * kFps; ++frame) {
        // Equal feedback cadence for both controllers; only B's budget differs.
        if (frame % 6 == 0) Sync(worker.get(), [&] {
          for (int i = 0; i < 2; ++i) {
            if (!pipelines[i].encoder) continue;
            const auto rate = DataRate::BitsPerSec(i == 0 ? 2'000'000 : weak_bitrate);
            pipelines[i].encoder->OnBitrateUpdated(rate, rate, 0, 20, 0);
          }
        });
        auto original = MakeFrame(env, ++frame_index);
        for (int consumer = 0; consumer < 2; ++consumer) {
          if (!pipelines[consumer].encoder) continue;
          if (consumer == 1 && (retire || (skip && frame == kFps))) continue;
          Sync(worker.get(), [&, consumer] { pipelines[consumer].source.Push(original); });
          if (!realtime) Sync(pipelines[consumer].encode_queue, [] {});
        }
        std::this_thread::sleep_until(started +
            std::chrono::microseconds((frame + 1) * 1'000'000LL / kFps));
      }
      for (auto& pipeline : pipelines) {
        if (pipeline.encoder) Sync(pipeline.encode_queue, [] {});
      }
      Sync(worker.get(), [] {});
      const double elapsed = std::chrono::duration<double>(
          std::chrono::steady_clock::now() - started).count();
      std::cout << "{\"phase\":\"" << name << "\",\"seconds\":" << elapsed
                << ",\"encodes\":" << factory.encodes.load() - encodes
                << ",\"hits\":" << factory.hits.load() - hits << ",\"a\":";
      PrintCounts(a, pipelines[0].sink->Snapshot(), elapsed);
      std::cout << ",\"b\":";
      PrintCounts(b, pipelines[1].sink->Snapshot(), elapsed);
      const auto stats_a = pipelines[0].stats->GetStats();
      const auto stats_b = shared_pipeline ? stats_a : pipelines[1].stats->GetStats();
      std::cout << ",\"aEncodeMs\":" << stats_a.avg_encode_time_ms
                << ",\"bEncodeMs\":" << stats_b.avg_encode_time_ms
                << ",\"aEncodeUsage\":" << stats_a.encode_usage_percent
                << ",\"bEncodeUsage\":" << stats_b.encode_usage_percent
                << ",\"aCpuLimitedResolution\":" << (stats_a.cpu_limited_resolution ? "true" : "false")
                << ",\"bCpuLimitedResolution\":" << (stats_b.cpu_limited_resolution ? "true" : "false")
                << ",\"aCpuLimitedFramerate\":" << (stats_a.cpu_limited_framerate ? "true" : "false")
                << ",\"bCpuLimitedFramerate\":" << (stats_b.cpu_limited_framerate ? "true" : "false")
                << "}\n" << std::flush;
    };
    run("healthy", 6, 2'000'000, false, false);
    if (latency_probe) {
      factory.simulatedLatencyMs = 45;
      run("encoder-delayed", 30, 2'000'000, false, false);
      factory.simulatedLatencyMs = 0;
      run("encoder-released", 30, 2'000'000, false, false);
    } else if (!healthy_only) {
      run("weak", 15, 100'000, false, false);
      run("released", 25, 2'000'000, false, false);
    }
    if (!shared_pipeline) run("skipped-input", 3, 2'000'000, true, false);
    run("retired-b", 2, 2'000'000, false, true);
    Sync(worker.get(), [&] {
      pipelines[0].encoder->Stop();
      pipelines[0].encoder.reset();
    });
    pipelines[0].sink->FinishExport();
    const auto a = pipelines[0].sink->Snapshot(), b = pipelines[1].sink->Snapshot();
    const bool integrity = (h264 ? a.encoded > 0 && b.encoded > 0 : a.decoded > 0 && b.decoded > 0) && factory.live.load() == 0 &&
        a.errors + b.errors + proof.mismatches.load() == 0 &&
        (!pooled || factory.hits.load() > 0 && proof.compared.load() > 0) &&
        (!shared_pipeline || proof.compared.load() > 0);
    std::cout << "{\"integrity\":\"" << (integrity ? "pass" : "fail")
              << "\",\"codec\":\"" << (h264 ? "h264" : "vp8")
              << "\",\"pooled\":" << (pooled ? "true" : "false")
              << ",\"adjuster\":" << (no_adjuster ? "false" : "true")
              << ",\"groupAdjuster\":" << (group_adjuster ? "true" : "false")
              << ",\"unsafeSkip\":" << (unsafe_skip ? "true" : "false")
              << ",\"realtime\":" << (realtime ? "true" : "false")
              << ",\"latencyProbe\":" << (latency_probe ? "true" : "false")
              << ",\"sharedPipeline\":" << (shared_pipeline ? "true" : "false")
              << ",\"encodes\":" << factory.encodes.load()
              << ",\"hits\":" << factory.hits.load()
              << ",\"splits\":" << factory.splits.load()
              << ",\"rateSplits\":" << factory.rateSplits.load()
              << ",\"dependencySplits\":" << factory.dependencySplits.load()
              << ",\"created\":" << factory.created.load()
              << ",\"joins\":" << factory.joins.load()
              << ",\"live\":" << factory.live.load()
              << ",\"maxLive\":" << factory.maxLive.load()
              << ",\"callbacks\":" << factory.callbacks.load()
              << ",\"samePayloadCompared\":" << proof.compared.load()
              << ",\"decodedHashComparisons\":" << proof.decodedCompared.load()
              << ",\"decodedHashMismatches\":" << proof.mismatches.load()
              << ",\"aWantsUpdates\":" << pipelines[0].source.wants_updates
              << ",\"bWantsUpdates\":" << pipelines[1].source.wants_updates
              << ",\"aMinPixels\":" << pipelines[0].source.min_pixels
              << ",\"bMinPixels\":" << pipelines[1].source.min_pixels << "}\n";
    return integrity ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << "pool harness failed: " << error.what() << '\n';
    return 2;
  }
}
