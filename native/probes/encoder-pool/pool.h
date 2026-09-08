#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <iostream>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

#include "api/environment/environment.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "rtc_base/checks.h"
#include "video/encoder_bitrate_adjuster.h"

// A one-source, single-stream experiment, not a product encoder registry.
// H264 uses the shared-pipeline control, not per-sender cache adaptation.
// Matching requests share only one last completed access unit. No warm cache.
// ponytail: one mutex serializes groups; validate per-group workers before production.
class PoolFactory final : public webrtc::VideoEncoderFactory {
 public:
  explicit PoolFactory(bool pooled, bool group_adjuster = false, bool unsafe_skip = false,
                       std::unique_ptr<webrtc::VideoEncoderFactory> backend = nullptr)
      : pooled_(pooled), group_adjuster_(group_adjuster), unsafe_skip_(unsafe_skip),
        builtin_(backend ? std::move(backend) : webrtc::CreateBuiltinVideoEncoderFactory()),
        format_(builtin_->GetSupportedFormats().front()) {}
  std::atomic<int> encodes{0}, hits{0}, splits{0}, live{0}, maxLive{0}, callbacks{0};
  std::atomic<int> dependencySplits{0}, rateSplits{0};
  std::atomic<int> created{0}, joins{0};
  std::atomic<int> simulatedLatencyMs{0};

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {format_};
  }

 private:
  struct Group final : webrtc::EncodedImageCallback {
    PoolFactory& owner;
    webrtc::VideoCodec config;
    webrtc::VideoEncoder::Settings settings;
    std::unique_ptr<webrtc::VideoEncoder> codec;
    std::optional<webrtc::VideoEncoder::RateControlParameters> rates;
    std::optional<webrtc::VideoEncoder::RateControlParameters> applied_rates;
    std::unique_ptr<webrtc::EncoderBitrateAdjuster> adjuster;
    float loss = 0;
    int64_t rtt = 0;
    std::optional<uint32_t> timestamp, previous, attempted;
    std::optional<webrtc::EncodedImage> image;
    webrtc::CodecSpecificInfo info;
    bool dropped = false;
    bool pendingKey = false;

    Group(PoolFactory& parent, const webrtc::Environment& env,
          const webrtc::VideoCodec& configuration,
          const webrtc::VideoEncoder::Settings& options)
        : owner(parent), config(configuration), settings(options),
          codec(parent.builtin_->Create(env, parent.format_)) {
      RTC_CHECK(codec);
      RTC_CHECK_EQ(codec->InitEncode(&config, settings), 0);
      codec->RegisterEncodeCompleteCallback(this);
      if (owner.group_adjuster_) {
        adjuster = std::make_unique<webrtc::EncoderBitrateAdjuster>(config, env.field_trials(), env.clock());
        adjuster->OnEncoderInfo(codec->GetEncoderInfo());
      }
      ++owner.created;
      const int count = ++owner.live;
      owner.maxLive.store(std::max(owner.maxLive.load(), count));
    }
    ~Group() override {
      codec->RegisterEncodeCompleteCallback(nullptr);
      codec->Release();
      --owner.live;
    }
    Result OnEncodedImage(const webrtc::EncodedImage& output,
                          const webrtc::CodecSpecificInfo* details) override {
      RTC_CHECK(!image.has_value());
      image = output;
      if (details) info = *details;
      if (adjuster) adjuster->OnEncodedFrame(webrtc::DataSize::Bytes(output.size()), 0, 0);
      return Result(Result::OK);
    }
    void OnFrameDropped(uint32_t, int, bool) override {
      dropped = true;
    }
    void UpdateCodecRates() {
      if (!rates) return;
      auto adjusted = *rates;
      if (adjuster) adjusted.bitrate = adjuster->AdjustRateAllocation(*rates);
      if (applied_rates != adjusted) codec->SetRates(adjusted);
      applied_rates = adjusted;
    }
  };

  static bool SameConfig(const Group& group, const webrtc::VideoCodec& c,
                         const webrtc::VideoEncoder::Settings& s) {
    const auto& a = group.config;
    return a.width == c.width && a.height == c.height &&
           a.startBitrate == c.startBitrate && a.maxBitrate == c.maxBitrate &&
           a.minBitrate == c.minBitrate && a.maxFramerate == c.maxFramerate &&
           a.qpMax == c.qpMax && a.mode == c.mode && a.active == c.active &&
           a.GetFrameDropEnabled() == c.GetFrameDropEnabled() &&
           a.GetVideoEncoderComplexity() == c.GetVideoEncoderComplexity() &&
           a.GetScalabilityMode() == c.GetScalabilityMode() && a.codecType == c.codecType &&
           (a.codecType == webrtc::kVideoCodecVP8 ? a.VP8() == c.VP8() : a.H264() == c.H264()) &&
           group.settings.number_of_cores == s.number_of_cores &&
           group.settings.max_payload_size == s.max_payload_size &&
           group.settings.encoder_thread_limit == s.encoder_thread_limit;
  }

  class Encoder final : public webrtc::VideoEncoder {
   public:
    Encoder(PoolFactory& owner, const webrtc::Environment& env)
        : owner_(owner), env_(env),
          metadata_(owner.builtin_->Create(env, owner.format_)) {}
    ~Encoder() override { Release(); }
    int InitEncode(const webrtc::VideoCodec* c, const Settings& s) override {
      RTC_CHECK(c->codecType == webrtc::kVideoCodecVP8 || c->codecType == webrtc::kVideoCodecH264);
      RTC_CHECK_LE(c->numberOfSimulcastStreams, 1);
      RTC_CHECK_EQ(c->codecType == webrtc::kVideoCodecVP8 ? c->VP8().numberOfTemporalLayers : c->H264().numberOfTemporalLayers, 1);
      RTC_CHECK_EQ(c->mode, webrtc::VideoCodecMode::kRealtimeVideo);
      std::lock_guard lock(owner_.mutex_);
      group_.reset();
      last_.reset();
      config_ = *c;
      settings_ = s;
      rates_.reset();
      group_ = FindOrCreate(false, 0);
      return 0;
    }
    int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) override {
      callback_ = callback;
      return 0;
    }
    int32_t Release() override {
      std::lock_guard lock(owner_.mutex_);
      group_.reset();
      last_.reset();
      return 0;
    }
    void SetRates(const RateControlParameters& rates) override { rates_ = rates; }
    void OnPacketLossRateUpdate(float loss) override { loss_ = loss; }
    void OnRttUpdate(int64_t rtt) override { rtt_ = rtt; }
    EncoderInfo GetEncoderInfo() const override {
      std::lock_guard lock(owner_.mutex_);
      return group_ ? group_->codec->GetEncoderInfo() : metadata_->GetEncoderInfo();
    }
    int32_t Encode(const webrtc::VideoFrame& frame,
                   const std::vector<webrtc::VideoFrameType>* requested) override {
      std::optional<webrtc::EncodedImage> output;
      webrtc::CodecSpecificInfo info;
      bool dropped = false;
      int result = 0;
      {
        std::lock_guard lock(owner_.mutex_);
        const uint32_t ts = frame.rtp_timestamp();
        bool key = requested && std::find(requested->begin(), requested->end(),
            webrtc::VideoFrameType::kVideoFrameKey) != requested->end();
        const auto before = group_;
        if (!Compatible(*group_)) {
          // Single-owner rate changes must retain the encoder's adaptation history.
          if (group_.use_count() == 2) {
            ApplyRates(*group_);
          } else {
            if (owner_.rateSplits.load() < 8 && group_->rates && rates_) {
              std::cerr << "rate split " << group_->rates->bitrate.get_sum_bps()
                        << '/' << rates_->bitrate.get_sum_bps() << " fps "
                        << group_->rates->framerate_fps << '/' << rates_->framerate_fps
                        << " target " << group_->rates->target_bitrate.get_sum_bps()
                        << '/' << rates_->target_bitrate.get_sum_bps()
                        << " allocation " << group_->rates->bandwidth_allocation.bps()
                        << '/' << rates_->bandwidth_allocation.bps()
                        << " rtt " << group_->rtt << '/' << rtt_
                        << " loss " << group_->loss << '/' << loss_ << '\n';
            }
            group_.reset();
            group_ = FindOrCreate(true, ts);
            ++owner_.rateSplits;
          }
        }
        if (owner_.pooled_) {
          for (auto& reference : owner_.groups_) {
            const auto candidate = reference.lock();
            if (candidate && candidate != group_ && Compatible(*candidate)) {
              if (candidate->attempted == ts && candidate->image &&
                  candidate->image->_frameType == webrtc::VideoFrameType::kVideoFrameKey) {
                group_ = candidate;
                ++owner_.joins;
                break;
              }
              // Demand has reconverged; request normal keyframe recovery once.
              candidate->pendingKey = true;
            }
          }
        }
        bool cached = group_->attempted == ts;
        bool continuous = cached ? last_ == group_->previous : last_ == group_->timestamp;
        if (!owner_.unsafe_skip_ && !continuous && !(cached && group_->image &&
                            group_->image->_frameType == webrtc::VideoFrameType::kVideoFrameKey)) {
          group_.reset();
          group_ = FindOrCreate(true, ts);
          cached = group_->attempted == ts;
          key = true;
          ++owner_.dependencySplits;
        }
        if (key && cached && group_->image &&
            group_->image->_frameType != webrtc::VideoFrameType::kVideoFrameKey) {
          group_.reset();
          group_ = NewGroup();
          cached = false;
        }
        if (before != group_) {
          ++owner_.splits;
          last_.reset();
          key = true;
        }
        if (cached) {
          ++owner_.hits;
        } else {
          key = key || group_->pendingKey;
          group_->pendingKey = false;
          group_->previous = group_->timestamp;
          group_->attempted = ts;
          group_->image.reset();
          group_->dropped = false;
          const std::vector<webrtc::VideoFrameType> types{
              key ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta};
          ++owner_.encodes;
          group_->UpdateCodecRates();
          const int64_t latency_us = static_cast<int64_t>(owner_.simulatedLatencyMs.load()) *
              1000 * group_->config.width * group_->config.height / (640 * 360);
          if (latency_us > 0) std::this_thread::sleep_for(std::chrono::microseconds(latency_us));
          result = group_->codec->Encode(frame, &types);
          if (group_->image) group_->timestamp = ts;
        }
        output = group_->image;
        info = group_->info;
        dropped = group_->dropped;
        if (output) last_ = ts;
      }
      if (output) {
        output->SetRtpTimestamp(frame.rtp_timestamp());
        ++owner_.callbacks;
        callback_->OnEncodedImage(*output, &info);
      } else if (dropped) {
        callback_->OnFrameDropped(frame.rtp_timestamp(), 0, true);
      }
      return result;
    }

   private:
    bool Compatible(const Group& group) const {
      // Upstream DefaultTemporalLayers ignores RTT/loss for this L1T1 codec.
      return SameConfig(group, *config_, *settings_) && group.rates == rates_;
    }
    void ApplyRates(Group& group) {
      group.rates = rates_;
      group.UpdateCodecRates();
      group.codec->OnPacketLossRateUpdate(loss_);
      group.codec->OnRttUpdate(rtt_);
      group.loss = loss_;
      group.rtt = rtt_;
    }
    std::shared_ptr<Group> NewGroup() {
      std::erase_if(owner_.groups_, [](const auto& group) { return group.expired(); });
      auto group = std::make_shared<Group>(owner_, env_, *config_, *settings_);
      ApplyRates(*group);
      owner_.groups_.push_back(group);
      return group;
    }
    std::shared_ptr<Group> FindOrCreate(bool encoding, uint32_t ts) {
      if (owner_.pooled_) {
        for (auto it = owner_.groups_.begin(); it != owner_.groups_.end();) {
          auto group = it->lock();
          if (!group) { it = owner_.groups_.erase(it); continue; }
          ++it;
          if (!Compatible(*group)) continue;
          if (!encoding && !group->timestamp) return group;
          if (encoding && group->attempted == ts && group->image &&
              group->image->_frameType == webrtc::VideoFrameType::kVideoFrameKey) return group;
          if (encoding && !group->timestamp) return group;
        }
      }
      return NewGroup();
    }
    PoolFactory& owner_;
    webrtc::Environment env_;
    std::unique_ptr<webrtc::VideoEncoder> metadata_;
    std::optional<webrtc::VideoCodec> config_;
    std::optional<Settings> settings_;
    std::optional<RateControlParameters> rates_;
    float loss_ = 0;
    int64_t rtt_ = 0;
    std::shared_ptr<Group> group_;
    std::optional<uint32_t> last_;
    webrtc::EncodedImageCallback* callback_ = nullptr;
  };

 public:
  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env, const webrtc::SdpVideoFormat&) override {
    return std::make_unique<Encoder>(*this, env);
  }

 private:
  bool pooled_;
  bool group_adjuster_;
  bool unsafe_skip_;
  std::unique_ptr<webrtc::VideoEncoderFactory> builtin_;
  webrtc::SdpVideoFormat format_;
  std::mutex mutex_;
  std::vector<std::weak_ptr<Group>> groups_;
};
