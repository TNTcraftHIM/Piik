#pragma once

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace piik::capture {

// One codec worker consumes raw inputs; only its not-yet-encoded input is replaceable.
template <typename Frame>
class OutputMailbox final {
 public:
  enum class Action { frame, retire, stop };
  struct Work final {
    Action action = Action::stop;
    std::shared_ptr<const Frame> input;
    uint64_t generation = 0;
    uint32_t bitrate = 0;
    bool recovery = false;
  };

  explicit OutputMailbox(uint32_t ceiling, bool active = true)
      : ceiling_(ceiling), bitrate_(ceiling), active_(active) {}

  void Submit(std::shared_ptr<const Frame> input) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_ && !stopped_ && !failed_) {
      pending_ = std::move(input);
      changed_.notify_one();
    }
  }

  Work Take() {
    std::unique_lock<std::mutex> lock(mutex_);
    changed_.wait(lock, [&]() { return stopped_ || retire_ || pending_; });
    if (stopped_) return {};
    if (retire_) {
      retire_ = false;
      return {Action::retire, {}, generation_, bitrate_, false};
    }
    return {Action::frame, std::exchange(pending_, {}), generation_, bitrate_,
            std::exchange(key_requested_, false)};
  }

  // Only a fresh activation needs a retained capture frame.
  bool SetActive(bool active) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_ == active || failed_) return false;
    active_ = active;
    ++generation_;
    key_requested_ = true;
    if (!active) {
      pending_.reset();
      retire_ = true;
    }
    changed_.notify_one();
    return active;
  }

  void RequestKeyFrame() {
    std::lock_guard<std::mutex> lock(mutex_);
    key_requested_ = true;
  }

  void SetBitrate(uint32_t bitrate) {
    if (bitrate < 1'000 || bitrate > ceiling_) throw std::runtime_error("Output bitrate exceeds its codec bounds");
    std::lock_guard<std::mutex> lock(mutex_);
    bitrate_ = bitrate;
  }

  bool Accept(uint64_t generation) {
    std::lock_guard<std::mutex> lock(mutex_);
    return !stopped_ && !failed_ && active_ && generation == generation_;
  }

  bool Fail(bool recovery) {
    std::lock_guard<std::mutex> lock(mutex_);
    key_requested_ = key_requested_ || recovery;
    failed_ = true;
    pending_.reset();
    return !stopped_;
  }

  void Stop() {
    std::lock_guard<std::mutex> lock(mutex_);
    stopped_ = true;
    pending_.reset();
    changed_.notify_one();
  }

 private:
  const uint32_t ceiling_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::shared_ptr<const Frame> pending_;
  uint32_t bitrate_;
  uint64_t generation_ = 0;
  bool active_ = true;
  bool stopped_ = false;
  bool failed_ = false;
  bool retire_ = false;
  bool key_requested_ = true;
};

}  // namespace piik::capture
