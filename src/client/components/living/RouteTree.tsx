import { memo } from "react";
import type { LabeledViewerPresence } from "../../lib/viewer-presence";
import type { RoomVoiceState } from "../../../shared/protocol";
import { participantConnection } from "../../lib/participant-connection";
import { deriveParticipantStatus } from "../../ui/media-status";
import { deriveParticipantTopology, type TopologyBranch } from "../../lib/participant-topology";
import { useCopy } from "../../ui/copy";
import { RouteGraph, type RouteGraphNode, type RouteGraphEdge } from "./RouteGraph";

/** The published Host/Viewer/SFU model adapts into the shared display graph. */
export const RouteTree = memo(function RouteTree({ hostPeerId, hostIdentity, hostLabel, viewers,
  pictureActive, voice, selfPeerId, selectedPeerId, selectablePeerIds, onSelectPeer }: {
  hostPeerId: string | null;
  /** Colour identity while the Host peer id is still unknown. */
  hostIdentity?: string | null;
  hostLabel: string;
  viewers: readonly LabeledViewerPresence[];
  pictureActive: boolean;
  voice?: RoomVoiceState | null;
  selfPeerId?: string | null;
  selectedPeerId?: string | null;
  selectablePeerIds?: readonly string[];
  onSelectPeer?: (peerId: string) => void;
}) {
  const { t } = useCopy();
  const rootId = hostPeerId ?? "host";
  const nodes: RouteGraphNode[] = [{ id: rootId, label: hostLabel, host: true,
    identity: hostPeerId ?? hostIdentity ?? "host-pending", you: hostPeerId !== null && selfPeerId === hostPeerId }];
  const edges: RouteGraphEdge[] = [];
  const topology = deriveParticipantTopology(hostPeerId, viewers.map(viewer => {
    const connection = participantConnection(viewer, pictureActive, voice);
    return { ...viewer, upstream: connection.upstream, mediaReady: connection.ready ? true : undefined };
  }));
  const collect = (branch: TopologyBranch, parent: string, route: "p2p" | "sfu") => {
    nodes.push({ id: branch.viewer.peerId, label: branch.viewer.label, you: selfPeerId === branch.viewer.peerId });
    edges.push({ from: parent, to: branch.viewer.peerId, selected: true, ready: branch.viewer.mediaReady === true, route });
    branch.children.forEach(child => collect(child, branch.viewer.peerId, "p2p"));
  };
  topology.peerRoots.forEach(branch => collect(branch, rootId, "p2p"));
  if (topology.sfuRoots.length) {
    const sfuId = "route-sfu";
    nodes.push({ id: sfuId, label: "SFU", kind: "sfu" });
    edges.push({ from: rootId, to: sfuId, selected: true, ready: true, route: "sfu" });
    topology.sfuRoots.forEach(branch => collect(branch, sfuId, "sfu"));
  }
  for (const viewer of topology.pending) {
    const status = deriveParticipantStatus(viewer, pictureActive, undefined, voice);
    nodes.push({ id: viewer.peerId, label: viewer.label, you: selfPeerId === viewer.peerId,
      pending: status.pulse === true, description: t(status.labelKey) });
    if (status.pulse) edges.push({ from: rootId, to: viewer.peerId, selected: false, ready: false });
  }
  return <RouteGraph nodes={nodes} rootId={rootId} edges={edges} selectedId={selectedPeerId}
    selectableIds={selectablePeerIds ?? (onSelectPeer ? viewers.map(viewer => viewer.peerId) : [])} onSelect={onSelectPeer} />;
});
