import type { PeerSnapshot } from "../types";

const QUALITY_LIMITATION_LABELS: Record<string, string> = {
  bandwidth: "带宽受限",
  cpu: "编码性能受限",
  other: "其他编码限制",
};

export function qualityLimitationSummary(
  snapshots: readonly PeerSnapshot[],
): string | null {
  const reasons = new Set<string>();
  for (const snapshot of snapshots) {
    const reason = snapshot.metrics.qualityLimitationReason;
    if (reason && reason !== "none") {
      reasons.add(QUALITY_LIMITATION_LABELS[reason] ?? reason);
    }
  }
  return reasons.size > 0
    ? `发送画质受限：${Array.from(reasons).join("、")}`
    : null;
}
