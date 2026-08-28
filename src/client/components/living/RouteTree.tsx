// The connection topology as a real tree: host (crowned) roots direct P2P
// viewers and the SFU node; relay children hang off their parent viewer.
// Data comes from deriveParticipantTopology.
import { memo } from "react";
import { PawnSvg, pawnColor } from "./Couch";
import { useCopy } from "../../ui/copy";
import type { LabeledViewerPresence } from "../../lib/viewer-presence";
import { deriveParticipantTopology, type TopologyBranch } from "../../lib/participant-topology";

interface TreeNode {
  key: string;
  label: string;
  via: string | null;
  sfu: boolean;
  you: boolean;
}

const HOST_X = 40;
const COLUMN_GAP = 190;
const ROW_BASE = 40;
const PENDING_COLOR = "#d98e04";

function xForDepth(depth: number): number {
  return HOST_X + (depth + 1) * COLUMN_GAP;
}

export const RouteTree = memo(function RouteTree({
  hostPeerId,
  hostLabel,
  viewers,
  selfPeerId,
  flowing = false,
}: {
  hostPeerId: string | null;
  hostLabel: string;
  viewers: readonly LabeledViewerPresence[];
  selfPeerId?: string | null;
  flowing?: boolean;
}) {
  const { t, vis } = useCopy();
  const topology = deriveParticipantTopology(hostPeerId, viewers);

  const nodes: TreeNode[] = [];
  const collect = (branch: TopologyBranch, via: string | null, sfu: boolean) => {
    nodes.push({
      key: branch.viewer.peerId,
      label: branch.viewer.label,
      via,
      sfu,
      you: selfPeerId === branch.viewer.peerId,
    });
    branch.children.forEach((child) => collect(child, branch.viewer.peerId, false));
  };
  topology.peerRoots.forEach((root) => collect(root, null, false));
  topology.sfuRoots.forEach((root) => collect(root, null, true));

  const childrenOf = new Map<string | "sfu" | null, TreeNode[]>();
  const add = (parent: string | "sfu" | null, node: TreeNode) => {
    const list = childrenOf.get(parent) ?? [];
    list.push(node);
    childrenOf.set(parent, list);
  };
  for (const node of nodes) {
    if (node.via) add(node.via, node);
    else if (node.sfu) add("sfu", node);
    else add(null, node);
  }
  const hasSfu = nodes.some((n) => n.sfu);

  const spacing = nodes.length > 10 ? 32 : 42;
  let row = 0;
  const pos = new Map<string, { x: number; y: number }>();
  function layout(node: TreeNode, depth: number): void {
    const kids = childrenOf.get(node.key) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = ROW_BASE + row * spacing;
      row += 1;
    } else {
      kids.forEach((kid) => layout(kid, depth + 1));
      y = kids.reduce((sum, kid) => sum + pos.get(kid.key)!.y, 0) / kids.length;
    }
    pos.set(node.key, { x: xForDepth(depth), y });
  }
  (childrenOf.get(null) ?? []).forEach((node) => layout(node, 0));
  let sfuPos: { x: number; y: number } | null = null;
  if (hasSfu) {
    const sfuKids = (childrenOf.get("sfu") ?? []);
    sfuKids.forEach((node) => layout(node, 1));
    sfuPos = {
      x: xForDepth(0),
      y: sfuKids.reduce((sum, kid) => sum + pos.get(kid.key)!.y, 0) / sfuKids.length,
    };
  }

  // Pending viewers (upstream not yet in the tree) dangle off the host as
  // dashed amber edges — visible in every language mode, not just text.
  const pendingPos = topology.pending.map((viewer) => {
    const p = { x: xForDepth(0), y: ROW_BASE + row * spacing };
    row += 1;
    return { viewer, ...p };
  });

  const height = Math.max(140, row * spacing + 64);

  const rootYs = [
    ...(childrenOf.get(null) ?? []).map((node) => pos.get(node.key)!.y),
    ...(sfuPos ? [sfuPos.y] : []),
    ...pendingPos.map((p) => p.y),
  ];
  const hostPos = {
    x: HOST_X,
    y:
      rootYs.length > 0
        ? rootYs.reduce((a, b) => a + b, 0) / rootYs.length
        : height / 2,
  };
  const width = Math.max(
    640,
    ...[...pos.values(), ...pendingPos, ...(sfuPos ? [sfuPos] : [])].map(
      ({ x }) => x + 70,
    ),
  );

  // Center the whole composition vertically inside the panel.
  const allYs = [
    ...[...pos.values()].map((p) => p.y),
    ...(sfuPos ? [sfuPos.y] : []),
    ...pendingPos.map((p) => p.y),
    hostPos.y,
  ];
  const minY = Math.min(...allYs) - 26;
  const maxY = Math.max(...allYs) + (vis ? 22 : 34);
  const shift = Math.max(0, (height - (maxY - minY)) / 2 - minY + 4);
  if (shift > 0) {
    pos.forEach((p) => {
      p.y += shift;
    });
    pendingPos.forEach((p) => {
      p.y += shift;
    });
    if (sfuPos) sfuPos.y += shift;
    hostPos.y += shift;
  }

  const flowClass = flowing ? "flow" : undefined;

  const labelText = (name: string, x: number, y: number) =>
    vis ? null : (
      <text x={x} y={y} textAnchor="middle">
        {name}
      </text>
    );

  const pendingLabel = `${t("host.topology.pending")}: ${topology.pending
    .map((viewer) => viewer.label)
    .join(", ")}`;

  const srSummary = [
    `${t("common.host")} ${hostLabel}`,
    ...nodes.map(
      (node) =>
        `${node.label} (${t(node.sfu ? "state.route.sfu" : "state.route.p2p")})`,
    ),
    ...topology.pending.map(
      (viewer) => `${viewer.label} (${t("host.topology.pending")})`,
    ),
  ].join(" · ");

  return (
    <div
      className="lr-route"
      role="group"
      aria-label={`${t("host.topology")}: ${srSummary}`}
      id="room-topology"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width, minWidth: "100%", maxWidth: "none" }}
      >
        {/* In vis mode <title> doubles as a native hover tooltip, leaking
            human-language UI text into the zero-text mode; accessible names
            ride on aria-label instead, which never becomes hover text. */}
        {vis ? null : <title>{t("host.topology")}</title>}
        {/* edges first, nodes on top */}
        {nodes.map((node) => {
          const p = pos.get(node.key)!;
          const parentNode = node.via ? pos.get(node.via) : undefined;
          const parent = parentNode ?? (node.sfu && sfuPos ? sfuPos : hostPos);
          const color = node.sfu ? "#8ea3b8" : "#2fa66a";
          return (
            <path
              key={`edge-${node.key}`}
              d={`M ${parent.x + 20} ${parent.y} Q ${(parent.x + p.x) / 2} ${parent.y + (p.y - parent.y) * 0.55}, ${p.x - 18} ${p.y}`}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              className={flowClass}
            />
          );
        })}
        {pendingPos.map((p) => (
          <path
            key={`edge-pending-${p.viewer.peerId}`}
            d={`M ${hostPos.x + 20} ${hostPos.y} Q ${(hostPos.x + p.x) / 2} ${hostPos.y + (p.y - hostPos.y) * 0.55}, ${p.x - 18} ${p.y}`}
            fill="none"
            stroke={PENDING_COLOR}
            strokeWidth={2.5}
            strokeDasharray="6 7"
            className={flowClass}
          />
        ))}
        {sfuPos ? (
          <path
            d={`M ${hostPos.x + 20} ${hostPos.y} L ${sfuPos.x - 20} ${sfuPos.y}`}
            fill="none"
            stroke="#8ea3b8"
            strokeWidth={2.5}
            className={flowClass}
          />
        ) : null}
        <g
          transform={`translate(${hostPos.x - 4}, ${hostPos.y - 20}) scale(0.85)`}
          role={vis ? "img" : undefined}
          aria-label={vis ? `${hostLabel} · ${t("common.host")}` : undefined}
        >
          {vis ? null : <title>{`${hostLabel} · ${t("common.host")}`}</title>}
          <PawnSvg color="var(--couch)" crown />
        </g>
        {labelText(hostLabel, hostPos.x + 14, hostPos.y + 30)}
        {sfuPos ? (
          <g
            transform={`translate(${sfuPos.x - 20}, ${sfuPos.y - 16})`}
            role={vis ? "img" : undefined}
            aria-label={vis ? t("host.sfu") : undefined}
          >
            {vis ? null : <title>{t("host.sfu")}</title>}
            <rect width="40" height="32" rx="7" fill="none" stroke="#8ea3b8" strokeWidth="2.5" />
            <path d="M8 12h24M8 20h24" stroke="#8ea3b8" strokeWidth="2.5" strokeLinecap="round" />
          </g>
        ) : null}
        {sfuPos ? labelText(t("host.sfu"), sfuPos.x, sfuPos.y + 32) : null}
        {nodes.map((node) => {
          const p = pos.get(node.key)!;
          const isChild = node.via !== null && !node.sfu;
          const nodeLabel = node.you ? `${node.label} · ${t("common.you")}` : node.label;
          return (
            <g
              key={node.key}
              transform={`translate(${p.x - 14}, ${p.y - 15}) scale(${isChild ? 0.52 : 0.72})`}
              role={vis ? "img" : undefined}
              aria-label={vis ? nodeLabel : undefined}
            >
              {vis ? null : <title>{nodeLabel}</title>}
              <PawnSvg color={pawnColor(node.key, node.you)} />
              {node.you ? (
                <circle cx="20" cy="26" r="22" fill="none" stroke="var(--you)" strokeWidth="3" />
              ) : null}
            </g>
          );
        })}
        {pendingPos.map((p) => (
          <g
            key={`pending-${p.viewer.peerId}`}
            transform={`translate(${p.x - 14}, ${p.y - 15}) scale(0.72)`}
            opacity={0.55}
            role={vis ? "img" : undefined}
            aria-label={vis ? `${p.viewer.label} · ${t("host.topology.pending")}` : undefined}
          >
            {vis ? null : <title>{`${p.viewer.label} · ${t("host.topology.pending")}`}</title>}
            <PawnSvg color={pawnColor(p.viewer.peerId, selfPeerId === p.viewer.peerId)} />
          </g>
        ))}
        {vis
          ? null
          : nodes.map((node) => {
              const p = pos.get(node.key)!;
              const isChild = node.via !== null && !node.sfu;
              return (
                <text key={`label-${node.key}`} x={p.x + 4} y={p.y + (isChild ? 20 : 26)} textAnchor="middle">
                  {node.label}
                </text>
              );
            })}
        {vis
          ? null
          : pendingPos.map((p) => (
              <text
                key={`label-pending-${p.viewer.peerId}`}
                x={p.x + 4}
                y={p.y + 26}
                textAnchor="middle"
                opacity={0.7}
              >
                {p.viewer.label}
              </text>
            ))}
      </svg>
      <ul className="visually-hidden">
        {nodes.map((node) => (
          <li key={`sr-${node.key}`}>
            {node.label} {node.sfu ? "SFU" : "P2P"}
          </li>
        ))}
        {topology.pending.map((viewer) => (
          <li key={`sr-pending-${viewer.peerId}`}>
            {viewer.label} {t("host.topology.pending")}
          </li>
        ))}
      </ul>
      {topology.pending.length > 0 ? (
        vis ? (
          <span className="visually-hidden">{pendingLabel}</span>
        ) : (
          <div className="lr-status-text" style={{ padding: "4px 6px" }}>
            {pendingLabel}
          </div>
        )
      ) : null}
    </div>
  );
});
