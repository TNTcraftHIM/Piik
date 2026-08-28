export interface TopologyLayout {
  baseWidth: number;
  hostX: number;
  columnGap: number;
  rightLabelReserve: number;
  maxVisibleLabelCodePoints: number;
}

const DESKTOP_LAYOUT: TopologyLayout = {
  baseWidth: 640,
  hostX: 170,
  columnGap: 220,
  rightLabelReserve: 170,
  maxVisibleLabelCodePoints: 16,
};

const NARROW_LAYOUT: TopologyLayout = {
  baseWidth: 260,
  hostX: 54,
  columnGap: 130,
  rightLabelReserve: 65,
  maxVisibleLabelCodePoints: 10,
};

export function topologyLayoutForViewport(narrow: boolean): TopologyLayout {
  return narrow ? NARROW_LAYOUT : DESKTOP_LAYOUT;
}
