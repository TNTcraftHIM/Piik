#pragma once

#include <windows.h>

#include <cstdint>

namespace screener::capture {

enum class TargetKind { window, display };

int WriteSourceList();
HRESULT WriteSourcePreview(TargetKind kind, UINT64 source_id, DWORD pid,
                           UINT64 expected_creation_time);
HRESULT ValidateProcessTarget(DWORD pid, UINT64 expected_creation_time);
HRESULT ValidateWindowTarget(UINT64 source_id, DWORD pid,
                             UINT64 expected_creation_time);
HRESULT ValidateDisplayTarget(UINT64 source_id);

}  // namespace screener::capture
