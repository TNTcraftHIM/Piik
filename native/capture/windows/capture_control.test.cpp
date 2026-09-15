#include "capture_control.h"
#include "capture_input.h"
#include "capture_output.h"
#include "output_mailbox.h"
#include "vp8_encoder.h"
#include "vp8_decoder.h"

#include <array>
#include <cassert>
#include <chrono>
#include <future>
#include <thread>
#include <vector>

void CheckOutputPipe() {
  HANDLE input = nullptr, output = nullptr;
  assert(CreatePipe(&input, &output, nullptr, 4096));
  piik::capture::ProtocolWriter writer(output);
  assert(SUCCEEDED(writer.WriteBegin(333'333, 333'333)));
  const std::array<BYTE, 3> payload{1, 2, 3};
  assert(SUCCEEDED(writer.Write(piik::capture::OutputKind::vp8, 1,
      333'333, 333'333, payload.data(), static_cast<DWORD>(payload.size()), 1, 320, 180)));
  std::array<BYTE, 67> data{};
  DWORD received = 0;
  assert(ReadFile(input, data.data(), static_cast<DWORD>(data.size()), &received, nullptr));
  assert(received == data.size() && data[4] == 2 && data[5] == 5 && data[31] == 0);
  assert(data[37] == 4 && data[38] == 1 && data[39] == 1);
  assert(data[56] == 1 && data[57] == 64 && data[58] == 0 && data[59] == 180 && data[63] == 3);

  std::vector<BYTE> large(256 * 1024, 128);
  HRESULT result = S_OK;
  std::thread blocked([&]() {
    result = writer.Write(piik::capture::OutputKind::vp8, 0,
        666'666, 333'333, large.data(), static_cast<DWORD>(large.size()), 1, 320, 180);
  });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  DWORD available = 0;
  while (available <= 32) {
    assert(std::chrono::steady_clock::now() < deadline);
    assert(PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr));
    std::this_thread::yield();
  }
  assert(WaitForSingleObject(blocked.native_handle(), 0) == WAIT_TIMEOUT);
  writer.Stop();
  do {
    CancelSynchronousIo(blocked.native_handle());
    assert(std::chrono::steady_clock::now() < deadline);
  } while (WaitForSingleObject(blocked.native_handle(), 10) == WAIT_TIMEOUT);
  blocked.join();
  assert(FAILED(result));
  CloseHandle(input);
  CloseHandle(output);
}

void CheckWorkers() {
  struct Input { uint32_t index; };
  using Mailbox = piik::capture::OutputMailbox<Input>;
  std::array<Mailbox, 3> mailboxes{Mailbox(90'000), Mailbox(300'000), Mailbox(1'200'000)};
  std::array<std::thread, 3> workers;
  std::array<uint32_t, 3> last{}, count{}, retired{};
  std::array<bool, 3> recovery{};
  std::mutex mutex;
  std::condition_variable changed;
  std::exception_ptr failure;
  std::promise<void> entered, release;
  auto entered_future = entered.get_future();
  auto released = release.get_future().share();
  for (size_t layer = 0; layer < workers.size(); ++layer) {
    workers[layer] = std::thread([&, layer]() {
      try {
        const uint32_t width = 160u << layer;
        const uint32_t height = 90u << layer;
        std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 3 / 2, 128);
        std::unique_ptr<piik::capture::Vp8Encoder> encoder;
        for (;;) {
          const auto work = mailboxes[layer].Take();
          if (work.action == Mailbox::Action::stop) break;
          if (work.action == Mailbox::Action::retire) {
            encoder.reset();
            std::lock_guard<std::mutex> lock(mutex);
            ++retired[layer];
            changed.notify_one();
            continue;
          }
          if (layer == 0 && work.input->index == 1) {
            entered.set_value();
            released.wait();
          }
          if (!encoder) encoder = std::make_unique<piik::capture::Vp8Encoder>(width, height, 30, work.bitrate);
          encoder->SetBitrate(work.bitrate);
          const auto output = encoder->Encode(pixels.data(), width,
              static_cast<uint64_t>(work.input->index) * 10'000'000 / 30, work.recovery);
          if (!mailboxes[layer].Accept(work.generation)) continue;
          std::lock_guard<std::mutex> lock(mutex);
          last[layer] = work.input->index;
          recovery[layer] = output.key_frame;
          ++count[layer];
          changed.notify_one();
        }
      } catch (...) {
        std::lock_guard<std::mutex> lock(mutex);
        failure = std::current_exception();
        changed.notify_one();
      }
    });
  }
  auto submit = [&](uint32_t index) {
    auto input = std::make_shared<Input>(Input{index});
    for (auto& mailbox : mailboxes) mailbox.Submit(input);
  };
  auto wait = [&](auto predicate) {
    std::unique_lock<std::mutex> lock(mutex);
    const bool ready = changed.wait_for(lock, std::chrono::seconds(2), [&]() { return failure || predicate(); });
    assert(ready && !failure);
  };
  submit(1);
  assert(entered_future.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  for (uint32_t index = 2; index <= 4; ++index) submit(index);
  wait([&]() { return last[1] == 4 && last[2] == 4; });
  mailboxes[0].RequestKeyFrame();
  release.set_value();
  wait([&]() { return last[0] == 4; });
  assert(count[0] == 2 && recovery[0]); // New request survived the older keyframe; pending 2/3 were replaced.
  mailboxes[1].SetActive(false);
  mailboxes[2].SetActive(false);
  submit(5);
  wait([&]() { return last[0] == 5 && retired[1] == 1 && retired[2] == 1; });
  assert(last[1] == 4 && last[2] == 4);
  mailboxes[0].SetBitrate(30'000);
  for (auto& mailbox : mailboxes) { mailbox.SetActive(true); mailbox.RequestKeyFrame(); }
  submit(6);
  wait([&]() { return last[0] == 6 && last[1] == 6 && last[2] == 6; });
  assert(recovery[0] && recovery[1] && recovery[2]);
  const auto stopped = std::chrono::steady_clock::now();
  for (auto& mailbox : mailboxes) mailbox.Stop();
  for (auto& worker : workers) worker.join();
  assert(std::chrono::steady_clock::now() - stopped < std::chrono::seconds(2));
}

void CheckDroppedRecoveryInput() {
  using Mailbox = piik::capture::OutputMailbox<int>;
  Mailbox mailbox(90'000);
  mailbox.Submit(std::make_shared<int>(1));
  const auto dropped = mailbox.Take();
  assert(dropped.recovery && *dropped.input == 1);
  // The codec accepted input but produced no AU; preserve its consumed request.
  if (dropped.recovery) mailbox.RequestKeyFrame();
  mailbox.Submit(std::make_shared<int>(2));
  const auto recovery = mailbox.Take();
  assert(recovery.recovery && *recovery.input == 2);
  assert(mailbox.Accept(recovery.generation));
  mailbox.Submit(std::make_shared<int>(3));
  assert(!mailbox.Take().recovery);
  mailbox.Stop();
}

void CheckIndependentActivation() {
  using Mailbox = piik::capture::OutputMailbox<int>;
  Mailbox original(300'000), extra(90'000, false);
  original.Submit(std::make_shared<int>(1));
  const auto original_frame = original.Take();
  extra.Submit(std::make_shared<int>(1));
  auto pending = std::async(std::launch::async, [&]() { return extra.Take(); });
  assert(pending.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout);
  assert(extra.SetActive(true));
  assert(!extra.SetActive(true));
  extra.SetBitrate(30'000);
  extra.Submit(std::make_shared<int>(2));
  assert(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  const auto activated = pending.get();
  assert(activated.action == Mailbox::Action::frame && *activated.input == 2 &&
      activated.recovery && activated.bitrate == 30'000);
  assert(!extra.SetActive(false));
  assert(!extra.Accept(activated.generation) && original.Accept(original_frame.generation));
  assert(extra.Take().action == Mailbox::Action::retire);
  assert(extra.SetActive(true));
  assert(!extra.Fail(activated.generation));
  extra.Submit(std::make_shared<int>(3));
  const auto replacement = extra.Take();
  assert(replacement.recovery && *replacement.input == 3 &&
      replacement.generation != activated.generation);
  assert(extra.Fail(replacement.generation));
  assert(!extra.SetActive(false) && !extra.SetActive(true));
  assert(original.Accept(original_frame.generation));
  original.Stop();
  extra.Stop();
}

void CheckInputEnvelopes() {
  std::string control(32, '\0');
  control.replace(0, 4, "SMED");
  control[4] = 2;
  control[5] = 7;
  control[31] = 4;
  control += "K -1";
  piik::capture::InputEnvelopes parser;
  assert(parser.Feed(std::string_view(control).substr(0, 11)).empty());
  assert(!parser.Empty());
  const auto controls = parser.Feed(std::string_view(control).substr(11));
  assert(controls.size() == 1 && controls[0].Control().kind == 'K' && controls[0].Control().layer == -1);
  assert(parser.Empty());
  auto invalid = control;
  invalid[7] = 1;
  bool rejected = false;
  try { (void)parser.Feed(invalid); } catch (const std::runtime_error&) { rejected = true; }
  assert(rejected);
}

int main() {
  using piik::capture::CaptureControls;
  assert(CaptureControls::Parse("K -1").layer == -1);
  assert(CaptureControls::Parse("A 5 1").layer == 5);
  assert(CaptureControls::Parse("A 5 1").value == 1);
  assert(CaptureControls::Parse("A 0 0").value == 0);
  assert(CaptureControls::Parse("K 5").layer == 5);
  assert(CaptureControls::Parse("B 1 90000").value == 90'000);
  assert(CaptureControls::Parse("Q").kind == 'Q');
  for (const auto& bad : {"K 6", "A 2", "A 6 1", "A -1 1", "A 0 2", "A2", "B 6 1000", "B 0 -1", "Q ignored", "\n"}) {
    bool rejected = false;
    try { (void)CaptureControls::Parse(bad); }
    catch (const std::runtime_error&) { rejected = true; }
    assert(rejected);
  }
  bool rejected = false;
  try { (void)CaptureControls::Parse(std::string(65, 'K')); }
  catch (const std::runtime_error&) { rejected = true; }
  assert(rejected);

  piik::capture::Vp8Encoder encoder(160, 90, 30, 90'000);
  piik::capture::Vp8Decoder decoder;
  std::vector<uint8_t> pixels(160 * 90 * 3 / 2, 128);
  for (uint32_t frame = 0; frame < 12; ++frame) {
    if (frame == 4) encoder.SetBitrate(30'000);
    if (frame == 8) encoder.SetBitrate(90'000);
    pixels[frame] = static_cast<uint8_t>(frame);
    const bool recovery = frame % 4 == 0;
    const auto output = encoder.Encode(pixels.data(), 160,
        (static_cast<uint64_t>(frame) + 1) * 10'000'000 / 30, recovery);
    assert(!output.bytes.empty() && (!recovery || output.key_frame));
    const auto decoded = decoder.Decode(output.bytes);
    assert(decoded.width == 160 && decoded.height == 90 && decoded.nv12.size() == pixels.size());
  }
  CheckWorkers();
  CheckDroppedRecoveryInput();
  CheckIndependentActivation();
  CheckOutputPipe();
  CheckInputEnvelopes();
}
