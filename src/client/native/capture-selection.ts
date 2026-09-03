import type { NativeAdapter, NativeCaptureTarget } from "./wire";

export interface NativeCapturePath {
  adapterIndex: number;
  encoderIndex: number;
}

export function defaultNativeCapturePath(
  adapters: NativeAdapter[],
): NativeCapturePath | null {
  for (const adapter of adapters) {
    const encoder = adapter.hardwareH264[0];
    if (encoder) {
      return { adapterIndex: adapter.index, encoderIndex: encoder.index };
    }
  }
  return null;
}

export function nativeCaptureTargetKey(target: NativeCaptureTarget): string {
  return target.kind === "window"
    ? `window:${target.sourceId}:${target.pid}:${target.creationTime}`
    : `display:${target.sourceId}`;
}
