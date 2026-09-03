import type { NativeAdapter, NativeWindowTarget } from "./wire";

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

export function nativeWindowKey(target: NativeWindowTarget): string {
  return `${target.windowHandle}:${target.pid}:${target.creationTime}`;
}
