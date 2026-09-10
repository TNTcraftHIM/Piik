export function formatPacketLossPercent(
  value: number | null,
  unknownLabel: string,
): string {
  return value === null || !Number.isFinite(value)
    ? unknownLabel
    : `${value.toFixed(1)}%`;
}
