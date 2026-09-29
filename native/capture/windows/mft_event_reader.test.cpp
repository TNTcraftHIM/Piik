#include "mft_event_reader.h"

#include <mfapi.h>
#include <mferror.h>
#include <cassert>
#include <future>
#include <thread>

using namespace piik::capture::windows;
using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;

class Generator final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFMediaEventGenerator> {
 public:
  Generator() { Check(MFCreateEventQueue(&queue), "fixture-queue"); }
  ~Generator() { if (destroyed) destroyed->set_value(); }
  HRESULT STDMETHODCALLTYPE GetEvent(DWORD flags, IMFMediaEvent** event) override {
    return queue->GetEvent(flags, event);
  }
  HRESULT STDMETHODCALLTYPE BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override {
    ++begins;
    if (FAILED(begin_error)) return begin_error;
    if (hold) { held = callback; return S_OK; }
    return queue->BeginGetEvent(callback, state);
  }
  HRESULT STDMETHODCALLTYPE EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override {
    ++ends;
    const HRESULT status = queue->EndGetEvent(result, event);
    if (end_entered) { end_entered->set_value(); release_end.wait(); }
    return FAILED(end_error) ? end_error : status;
  }
  HRESULT STDMETHODCALLTYPE QueueEvent(MediaEventType type, REFGUID extended,
      HRESULT status, const PROPVARIANT* payload) override {
    return queue->QueueEventParamVar(type, extended, status, payload);
  }
  void Push(MediaEventType type) { Check(QueueEvent(type, GUID_NULL, S_OK, nullptr), "fixture-push"); }
  ComPtr<IMFMediaEventQueue> queue;
  ComPtr<IMFAsyncCallback> held;
  HRESULT begin_error = S_OK;
  HRESULT end_error = S_OK;
  bool hold = false;
  unsigned begins = 0;
  unsigned ends = 0;
  std::promise<void>* end_entered = nullptr;
  std::promise<void>* destroyed = nullptr;
  std::shared_future<void> release_end;
};

template <typename F>
void ExpectFailure(F action, const char* stage) {
  try { action(); assert(false); }
  catch (const GateFailure& failure) { assert(failure.stage() == stage); }
}

int main() {
  Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "fixture-com");
  Check(MFStartup(MF_VERSION), "fixture-mf");
  {
    auto source = Microsoft::WRL::Make<Generator>();
    MftEventReader reader(source.Get());
    source->Push(METransformNeedInput);
    auto event = reader.Read(std::chrono::steady_clock::now() + 1s, "fixture-timeout");
    MediaEventType type = MEUnknown;
    Check(event->GetType(&type), "fixture-type");
    assert(type == METransformNeedInput);
    std::thread delayed([&] { std::this_thread::sleep_for(20ms); source->Push(METransformHaveOutput); });
    event = reader.Read(std::chrono::steady_clock::now() + 1s, "fixture-timeout");
    delayed.join();
    Check(event->GetType(&type), "fixture-type");
    assert(type == METransformHaveOutput);
    assert(source->begins == 2 && source->ends == 2);
    source->queue->Shutdown();
  }
  for (bool begin : {false, true}) {
    auto source = Microsoft::WRL::Make<Generator>();
    if (begin) source->begin_error = E_FAIL;
    else { source->end_error = E_FAIL; source->Push(MEError); }
    MftEventReader reader(source.Get());
    ExpectFailure([&] { reader.Read(std::chrono::steady_clock::now() + 1s, "fixture-timeout"); },
                  begin ? "mft-begin-get-event" : "mft-get-event");
    source->queue->Shutdown();
  }
  {
    auto source = Microsoft::WRL::Make<Generator>();
    source->hold = true;
    {
      MftEventReader reader(source.Get());
      ExpectFailure([&] { reader.Read(std::chrono::steady_clock::now() - 1ms, "fixture-timeout"); }, "fixture-timeout");
      assert(source->begins == 0);
      ExpectFailure([&] { reader.Read(std::chrono::steady_clock::now() + 20ms, "fixture-timeout"); }, "fixture-timeout");
      assert(source->begins == 1);
    }
    // Late callback must neither access the dead reader nor retain its source.
    ComPtr<IMFAsyncCallback> late = source->held;
    source->queue->Shutdown();
    assert(source.Reset() == 0);
    Check(late->Invoke(nullptr), "fixture-late-callback");
  }
  {
    auto source = Microsoft::WRL::Make<Generator>();
    {
      MftEventReader reader(source.Get());
      ExpectFailure([&] { reader.Read(std::chrono::steady_clock::now() + 20ms, "fixture-timeout"); }, "fixture-timeout");
    }
    source->queue->Shutdown();
    assert(source.Reset() == 0);
  }
  {
    std::promise<void> entered, release, destroyed;
    auto began = entered.get_future();
    auto retired = destroyed.get_future();
    auto source = Microsoft::WRL::Make<Generator>();
    source->end_entered = &entered;
    source->destroyed = &destroyed;
    source->release_end = release.get_future().share();
    source->Push(METransformHaveOutput);
    {
      MftEventReader reader(source.Get());
      ExpectFailure([&] { reader.Read(std::chrono::steady_clock::now() + 500ms, "fixture-timeout"); }, "fixture-timeout");
      assert(began.wait_for(1s) == std::future_status::ready);
    }
    source->queue->Shutdown();
    source.Reset();
    // EndGetEvent was already running when Close detached the source. Its
    // local reference keeps the generator alive, then releases it without join.
    assert(retired.wait_for(0ms) == std::future_status::timeout);
    release.set_value();
    assert(retired.wait_for(1s) == std::future_status::ready);
  }
  MFShutdown();
  CoUninitialize();
}
