export interface TopologyLayout {
  baseWidth: number;
  hostX: number;
  columnGap: number;
  rightLabelReserve: number;
  maxVisibleLabelCodePoints: number;
}

export interface RouteGraphNode {
  id: string;
  label: string;
  identity?: string;
  you?: boolean;
  host?: boolean;
  kind?: "person" | "sfu";
  /** Presence without an upstream can still have an explicit waiting state. */
  pending?: boolean;
  description?: string;
}

export interface RouteGraphEdge {
  from: string;
  to: string;
  selected: boolean;
  ready: boolean;
  route?: "p2p" | "sfu";
  /** The actual local App-to-Browser presentation hop. */
  presentation?: boolean;
}

export function routeGraphLayout(nodes: readonly RouteGraphNode[], rootId: string,
  edges: readonly RouteGraphEdge[], containerWidth: number) {
  const config = topologyLayoutForWidth(containerWidth);
  const ids = new Set(nodes.map(node => node.id));
  const parents = new Map<string, string>();
  // Only the layout chooses a preferred parent. Every actual edge is rendered.
  for (const edge of [...edges.filter(edge => edge.selected), ...edges.filter(edge => !edge.selected)]) {
    if (edge.to !== rootId && ids.has(edge.from) && ids.has(edge.to) && !parents.has(edge.to)) parents.set(edge.to, edge.from);
  }
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    const parent = parents.get(node.id);
    if (parent) children.set(parent, [...children.get(parent) ?? [], node.id]);
  }
  const spacing = nodes.length > 11 ? 58 : 60;
  const points = new Map<string, { x: number; y: number }>();
  const depths = new Map<string, number>();
  const order: string[] = [];
  let row = 0;
  function place(id: string, depth: number): void {
    if (depths.has(id)) return;
    depths.set(id, depth);
    order.push(id);
    const placedChildren: string[] = [];
    for (const child of children.get(id) ?? []) {
      if (depths.has(child)) continue;
      place(child, depth + 1);
      placedChildren.push(child);
    }
    const y = placedChildren.length
      ? placedChildren.reduce((sum, child) => sum + points.get(child)!.y, 0) / placedChildren.length
      : 40 + (id === rootId ? 0 : row++) * spacing;
    points.set(id, { x: config.hostX + depth * config.columnGap, y });
  }
  if (ids.has(rootId)) place(rootId, 0);
  const detached: string[] = [];
  for (const node of nodes) if (!depths.has(node.id)) {
    place(node.id, 1);
    detached.push(node.id);
  }
  const root = points.get(rootId);
  if (root && detached.length) {
    const roots = [...children.get(rootId) ?? [], ...detached];
    root.y = roots.reduce((sum, id) => sum + points.get(id)!.y, 0) / roots.length;
  }
  let height = Math.max(140, row * spacing + 64);
  if (root && nodes.length === 1) { root.x = config.baseWidth / 2; root.y = height / 2; }
  let width = Math.max(config.baseWidth, ...[...points.values()].map(point => point.x + config.rightLabelReserve));
  const allY = [...points.values()].map(point => point.y);
  const minY = Math.min(...allY) - 26, maxY = Math.max(...allY) + 34;
  const shift = Math.max(0, (height - (maxY - minY)) / 2 - minY + 4);
  for (const point of points.values()) point.y += shift;
  const maxDepth = Math.max(1, ...depths.values());
  let fittedGap = config.columnGap;
  if (width > config.baseWidth && (config.baseWidth - 120) / maxDepth >= 104) {
    fittedGap = (config.baseWidth - 120) / maxDepth;
    for (const [id, point] of points) point.x = 60 + depths.get(id)! * fittedGap;
    width = config.baseWidth;
  }
  const outline = width > config.baseWidth;
  if (outline) {
    const indent = Math.min(36, (config.baseWidth - 196) / maxDepth);
    order.forEach((id, index) => points.set(id, { x: 40 + depths.get(id)! * indent, y: 36 + index * spacing }));
    width = config.baseWidth;
    height = order.length * spacing + 20;
  }
  return { config, points, order, width, height, spacing, fittedGap, outline };
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
