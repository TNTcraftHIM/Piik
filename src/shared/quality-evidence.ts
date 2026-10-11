// Observations do not allocate media resources. Preserve representable values;
// unavailable or invalid measurements stay null, never clamped into false facts.
export function boundedNumber(value: number | null, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

export function boundedInteger(value: number | null, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

export function boundedSignedNumber(value: number | null, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value !== null && Number.isFinite(value) && Math.abs(value) <= maximum ? value : null;
}
