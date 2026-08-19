import type { PeerSnapshot } from "../types";

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
