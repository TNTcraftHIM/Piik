export interface TopologyLayout {
  baseWidth: number;
  hostX: number;
  columnGap: number;
  rightLabelReserve: number;
  maxVisibleLabelCodePoints: number;
}

const MIN_LAYOUT_WIDTH = 260;
const MAX_LAYOUT_WIDTH = 640;

function interpolate(start: number, end: number, progress: number): number {
  return Math.round(start + (end - start) * progress);
}

export function topologyLayoutForWidth(containerWidth: number): TopologyLayout {
  const finiteWidth = Number.isFinite(containerWidth)
    ? containerWidth
    : MAX_LAYOUT_WIDTH;
  const baseWidth = Math.round(
    Math.min(MAX_LAYOUT_WIDTH, Math.max(MIN_LAYOUT_WIDTH, finiteWidth)),
  );
  const progress =
    (baseWidth - MIN_LAYOUT_WIDTH) /
    (MAX_LAYOUT_WIDTH - MIN_LAYOUT_WIDTH);
  const columnGap = interpolate(130, 220, progress);
  const hostX = (baseWidth - columnGap) / 2;
  return {
    baseWidth,
    hostX,
    columnGap,
    rightLabelReserve: hostX,
    maxVisibleLabelCodePoints:
      baseWidth < 420 ? 10 : baseWidth < 560 ? 13 : 16,
  };
}
