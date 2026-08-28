import type { PeerSnapshot } from "../types";

export function formatPacketLossPercent(
  value: number | null,
  unknownLabel: string,
): string {
  return value === null || !Number.isFinite(value)
    ? unknownLabel
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
