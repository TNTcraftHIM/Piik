export function packetLossPercentFromDeltas(
  packetsReceivedDelta: number | null,
  packetsLostDelta: number | null,
): number | null {
  if (
    packetsReceivedDelta === null ||
    packetsLostDelta === null ||
    !Number.isFinite(packetsReceivedDelta) ||
    !Number.isFinite(packetsLostDelta) ||
    packetsReceivedDelta < 0 ||
    packetsLostDelta < 0
  ) {
    return null;
  }
  const packetDelta = packetsReceivedDelta + packetsLostDelta;
  return packetDelta > 0 ? (packetsLostDelta / packetDelta) * 100 : null;
}
