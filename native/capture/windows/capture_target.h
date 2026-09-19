#pragma once

#include <windows.h>

#include <cstdint>

namespace piik::capture {

enum class TargetKind { window, display };

int WriteSourceList();
int WriteMicrophoneList();
HRESULT WriteSourcePreview(TargetKind kind, UINT64 source_id, DWORD pid,
                           UINT64 expected_creation_time);
HRESULT ValidateProcessTarget(DWORD pid, UINT64 expected_creation_time);
HRESULT ValidateWindowTarget(UINT64 source_id, DWORD pid,
                             UINT64 expected_creation_time);
HRESULT ValidateDisplayTarget(UINT64 source_id);

class CapturePresentation final {
 public:
  CapturePresentation(TargetKind kind, UINT64 source_id)
      : kind_(kind), source_id_(source_id) {}

  SIZE Resolve(UINT32 width, UINT32 height, bool key_frame);

 private:
  TargetKind kind_;
  UINT64 source_id_;
  HMONITOR monitor_ = nullptr;
  RECT bounds_{};
  SIZE captured_{};
  SIZE presentation_{};
};

}  // namespace piik::capture
