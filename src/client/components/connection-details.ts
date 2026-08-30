import type { PeerSnapshot, QualityWarningKind } from "../types";

export interface QualityLimitationSummary {
  message: string;
  kind: QualityWarningKind;
}

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
): QualityLimitationSummary | null {
  for (const snapshot of snapshots) {
    if (snapshot.qualityWarning) {
      return {
        message: snapshot.qualityWarning,
        kind: snapshot.qualityWarningKind ?? "other",
      };
    }
  }
  return null;
}
