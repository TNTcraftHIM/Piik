import type { LabeledViewerPresence } from "./viewer-presence";
export type TopologyBranch = { viewer: LabeledViewerPresence; children: TopologyBranch[] };
export function deriveParticipantTopology(hostPeerId: string | null, viewers: readonly LabeledViewerPresence[]) {
  const peerChildren = new Map<string, LabeledViewerPresence[]>();
  const sfuViewers: LabeledViewerPresence[] = [];
  for (const viewer of viewers) {
    if (viewer.upstream.kind === "peer") {
      const children = peerChildren.get(viewer.upstream.peerId) ?? [];
      children.push(viewer);
      peerChildren.set(viewer.upstream.peerId, children);
    } else if (viewer.upstream.kind === "sfu") {
      sfuViewers.push(viewer);
    }
  }
  const included = new Set<string>();
  const branch = (viewer: LabeledViewerPresence, path: Set<string>): TopologyBranch => {
    included.add(viewer.peerId);
    const nextPath = new Set(path).add(viewer.peerId);
    return {
      viewer,
      children: (peerChildren.get(viewer.peerId) ?? [])
        .filter((child) => !nextPath.has(child.peerId))
        .map((child) => branch(child, nextPath)),
    };
  };
  const peerRoots = hostPeerId
    ? (peerChildren.get(hostPeerId) ?? []).map((viewer) =>
        branch(viewer, new Set([hostPeerId])),
      )
    : [];
  return {
    peerRoots,
    sfuRoots: sfuViewers.map((viewer) => branch(viewer, new Set())),
    pending: viewers.filter((viewer) => !included.has(viewer.peerId)),
  };
}
