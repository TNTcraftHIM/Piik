import { captureFramerateCeiling } from "../src/client/media/quality";

export function parseVideoGateSize(value: string) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  const size = { width: Number(match?.[1]), height: Number(match?.[2]) };
  if (captureFramerateCeiling(size) < 30) {
    throw new Error("Video size must be WIDTHxHEIGHT within current 30 fps capture limits");
  }
  return size;
}

// Gate expectations derive from the decoded source instead of assuming a 16:9
// canvas. Two pixels allow independent NV12 rounding at successive ceilings.
export function fittedCaptureSize(source: { width: number; height: number }, width: number, height: number) {
  const scale = Math.min(1, width / source.width, height / source.height);
  return { width: Math.max(2, Math.floor(source.width * scale / 2) * 2),
    height: Math.max(2, Math.floor(source.height * scale / 2) * 2) };
}

export function matchesCaptureSize(width: number, height: number, expected: { width: number; height: number }) {
  return width > 0 && height > 0 && Math.abs(width - expected.width) <= 2 && Math.abs(height - expected.height) <= 2;
}
