#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <stdexcept>
#include <string>
#include <utility>

namespace piik::capture::windows {

class GateFailure final : public std::runtime_error {
 public:
  GateFailure(std::string stage, std::string detail, HRESULT result = S_OK)
      : std::runtime_error(detail), stage_(std::move(stage)), result_(result) {}

  const std::string& stage() const noexcept { return stage_; }
  HRESULT result() const noexcept { return result_; }

 private:
  std::string stage_;
  HRESULT result_;
};

[[noreturn]] inline void Fail(const std::string& stage, const std::string& detail) {
  throw GateFailure(stage, detail);
}

inline void Check(HRESULT result, const std::string& stage) {
  if (FAILED(result)) {
    throw GateFailure(stage, "Windows API returned a failing HRESULT", result);
  }
}

}  // namespace piik::capture::windows
