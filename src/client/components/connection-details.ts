import type { PeerSnapshot } from "../types";

export function formatPacketLossPercent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "未知"
    : `${value.toFixed(1)}%`;
}

export function qualityLimitationSummary(
  snapshots: readonly PeerSnapshot[],
): string | null {
  for (const snapshot of snapshots) {
    if (snapshot.qualityWarning) {
      return snapshot.qualityWarning;
    }
  }
  return null;
}
