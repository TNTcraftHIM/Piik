#pragma once

#include "capture_error.h"

#include <mfobjects.h>
#include <wrl.h>

#include <chrono>
#include <condition_variable>
#include <mutex>

namespace piik::capture::windows {

// One serialized reader, one outstanding request. The callback owns its state
// even when an MFT completes after the encoder's deadline or destruction.
// A failed Read retires the reader; Read and destruction are never concurrent.
class MftEventReader final {
  class Completion final : public Microsoft::WRL::RuntimeClass<
      Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFAsyncCallback> {
   public:
    explicit Completion(IMFMediaEventGenerator* source) : source_(source) {}

    HRESULT STDMETHODCALLTYPE GetParameters(DWORD*, DWORD*) override { return E_NOTIMPL; }

    HRESULT STDMETHODCALLTYPE Invoke(IMFAsyncResult* result) override {
      Microsoft::WRL::ComPtr<IMFMediaEventGenerator> source;
      {
        std::lock_guard lock(mutex_);
        source = source_;
      }
      if (!source) return S_OK;
      Microsoft::WRL::ComPtr<IMFMediaEvent> event;
      const HRESULT status = source->EndGetEvent(result, &event);
      {
        std::lock_guard lock(mutex_);
        if (!source_) return S_OK;
        status_ = status;
        event_ = std::move(event);
        ready_ = true;
      }
      ready_event_.notify_one();
      return S_OK;
    }

    Microsoft::WRL::ComPtr<IMFMediaEvent> Read(
        std::chrono::steady_clock::time_point deadline, const char* timeout_stage) {
      if (std::chrono::steady_clock::now() >= deadline) Timeout(timeout_stage);
      {
        std::lock_guard lock(mutex_);
        ready_ = false;
      }
      Check(source_->BeginGetEvent(this, nullptr), "mft-begin-get-event");
      std::unique_lock lock(mutex_);
      if (!ready_event_.wait_until(lock, deadline, [this] { return ready_; }) ||
          std::chrono::steady_clock::now() >= deadline) {
        Timeout(timeout_stage);
      }
      Check(status_, "mft-get-event");
      return std::move(event_);
    }

    void Close() {
      // Break the generator/callback reference cycle before its existing owner
      // shuts down the MFT. Shutdown need not deliver a final callback.
      Microsoft::WRL::ComPtr<IMFMediaEventGenerator> source;
      {
        std::lock_guard lock(mutex_);
        source.Swap(source_);
      }
    }

   private:
    [[noreturn]] static void Timeout(const char* stage) {
      Fail(stage, "hardware MFT event wait timed out");
    }
    std::mutex mutex_;
    std::condition_variable ready_event_;
    Microsoft::WRL::ComPtr<IMFMediaEventGenerator> source_;
    Microsoft::WRL::ComPtr<IMFMediaEvent> event_;
    HRESULT status_ = S_OK;
    bool ready_ = false;
  };

 public:
  explicit MftEventReader(IMFMediaEventGenerator* source)
      : completion_(Microsoft::WRL::Make<Completion>(source)) {
    Check(completion_ ? S_OK : E_OUTOFMEMORY, "mft-event-reader");
  }
  ~MftEventReader() { completion_->Close(); }
  MftEventReader(const MftEventReader&) = delete;
  MftEventReader& operator=(const MftEventReader&) = delete;

  Microsoft::WRL::ComPtr<IMFMediaEvent> Read(
      std::chrono::steady_clock::time_point deadline, const char* timeout_stage) {
    return completion_->Read(deadline, timeout_stage);
  }

 private:
  Microsoft::WRL::ComPtr<Completion> completion_;
};

}  // namespace piik::capture::windows
