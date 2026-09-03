import type { NativeAdapter, NativeWindowTarget } from "./wire";

export function selectNativeCaptureAdapter(
  adapters: NativeAdapter[],
  requestedIndex: number | null,
): NativeAdapter | null {
  return (
    (requestedIndex === null
      ? adapters.find((candidate) => candidate.hardwareH264.length > 0)
      : adapters.find((candidate) => candidate.index === requestedIndex)) ?? null
  );
}

export function selectNativeWindowTarget(
  windows: NativeWindowTarget[],
  requestedTitle: string | null,
): NativeWindowTarget | null {
  const candidates = requestedTitle
    ? windows.filter((candidate) => candidate.title.includes(requestedTitle))
    : windows.filter(
        (candidate) => !candidate.title.toLowerCase().includes("screener"),
      );
  return candidates.length === 1 ? candidates[0]! : null;
}
