import type { NativeAdapter, NativeCaptureTarget, NativeVideoCodec } from "./wire";

export interface NativeCapturePath {
  adapterIndex: number;
  encoderIndex: number;
}

export function defaultNativeCapturePath(
  adapters: NativeAdapter[],
  codec: NativeVideoCodec | "auto" = "auto",
  softwareVP8 = false,
): NativeCapturePath | null {
  if (codec !== "vp8") {
    for (const adapter of adapters) {
      const encoder = adapter.hardwareH264[0];
      if (encoder) {
        return { adapterIndex: adapter.index, encoderIndex: encoder.index };
      }
    }
  }
  const adapter = adapters[0];
  return codec !== "h264" && softwareVP8 && adapter
    ? { adapterIndex: adapter.index, encoderIndex: 0 }
    : null;
}

export function nativeCaptureTargetKey(target: NativeCaptureTarget): string {
  return target.kind === "window"
    ? `window:${target.sourceId}:${target.pid}:${target.creationTime}`
    : `${target.kind}:${target.sourceId}`;
}

export function audioApplicationKey(target: NativeCaptureTarget): string {
  return target.kind === "window" ? `${target.pid}:${target.creationTime}` : "";
}

export function audioApplications(sources: NativeCaptureTarget[]): NativeCaptureTarget[] {
  return [...new Map(sources.filter(target => target.kind === "window")
    .map(target => [audioApplicationKey(target), target])).values()];
}
