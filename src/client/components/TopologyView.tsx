import type { LabeledViewerPresence } from "../lib/viewer-presence";
import { deriveParticipantTopology, type TopologyBranch } from "../lib/participant-topology";
function ViewerBranch({ branch, edge }: { branch: TopologyBranch; edge: "P2P" | "SFU" }) {
  return (
    <li>
      <div className="topology-node">
        <span className="topology-edge">{edge}</span><strong>{branch.viewer.label}</strong>
      </div>
      {branch.children.length > 0 && (
        <ul>
          {branch.children.map((child) => (
            <ViewerBranch key={child.viewer.peerId} branch={child} edge="P2P" />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TopologyView({ hostPeerId, hostLabel, viewers }: { hostPeerId: string | null; hostLabel: string; viewers: readonly LabeledViewerPresence[] }) {
  const topology = deriveParticipantTopology(hostPeerId, viewers);
  return (
    <div className="topology-view" id="room-topology">
      <ul className="topology-tree" aria-label="当前连接拓扑">
        <li>
          <div className="topology-node">
            <span className="topology-role">Host</span><strong>{hostLabel}</strong>
          </div>
          <ul>
            {topology.peerRoots.map((root) => (
              <ViewerBranch key={root.viewer.peerId} branch={root} edge="P2P" />
            ))}
            {topology.sfuRoots.length > 0 && (
              <li>
                <div className="topology-node">
                  <span className="topology-role">SFU</span><strong>媒体服务器</strong>
                </div>
                <ul>
                  {topology.sfuRoots.map((root) => (
                    <ViewerBranch key={root.viewer.peerId} branch={root} edge="SFU" />
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </li>
      </ul>
      {topology.pending.length > 0 && (
        <div className="topology-pending">
          <span>连接中</span>
          {topology.pending.map((viewer) => (
            <strong key={viewer.peerId}>{viewer.label}</strong>
          ))}
        </div>
      )}
    </div>
  );
}
