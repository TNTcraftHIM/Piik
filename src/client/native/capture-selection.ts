import type { NativeCaptureTarget } from "./wire";

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
