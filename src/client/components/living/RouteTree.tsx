// The connection topology as a real tree: the host roots direct P2P
// viewers and the SFU node; relay children hang off their parent viewer.
// Data comes from deriveParticipantTopology.
import { memo, useState } from "react";

import type { LabeledViewerPresence } from "../../lib/viewer-presence";
import { useElementWidth } from "../../lib/use-element-width";
import {
  deriveParticipantTopology,
  type TopologyBranch,
} from "../../lib/participant-topology";
import { useCopy } from "../../ui/copy";
import { PawnSvg } from "./Pawn";
import { Tooltip } from "./Tooltip";
import { participantColor } from "./participant-color";
import {
  topologyLayoutForWidth,
  type TopologyLayout,
} from "./route-tree-layout";

interface TreeNode {
  key: string;
  label: string;
  via: string | null;
  sfu: boolean;
  you: boolean;
  // Unready media is pending, including the initial connection.
  ready: boolean;
}

const ROW_BASE = 40;
const DEFAULT_TOPOLOGY_WIDTH = 640;
const PAWN_CENTER_X = 20;
const PAWN_SCALE = 0.82;
const PAWN_CENTER_Y = 24;
const LABEL_GAP = 12;

function centeredPawnX(centerX: number, scale: number): number {
  return centerX - PAWN_CENTER_X * scale;
}

function centeredPawnY(centerY: number, scale: number): number {
  return centerY - PAWN_CENTER_Y * scale;
}

function pawnLabelY(centerY: number, scale: number): number {
  return centerY + PAWN_CENTER_Y * scale + LABEL_GAP;
}

function PawnOutline({ className }: { className: string }) {
  return (
    <rect
      className={className}
      x="1"
      y="2"
      width="38"
      height="46"
      rx="8"
    />
  );
}

function compactVisibleLabel(label: string, maximumCodePoints: number): string {
  const codePoints = Array.from(label);
  if (codePoints.length <= maximumCodePoints) return label;

  const suffix = label.match(/ \([^()]+\)$/u)?.[0] ?? null;
  if (suffix) {
    const suffixCodePoints = Array.from(suffix);
    const nameCodePoints = Array.from(label.slice(0, -suffix.length));
    const visibleNameLength = Math.max(
      0,
      maximumCodePoints - suffixCodePoints.length - 1,
    );
    return `${nameCodePoints.slice(0, visibleNameLength).join("")}…${suffix}`;
  }

  return `${codePoints.slice(0, maximumCodePoints - 1).join("")}…`;
}

function xForDepth(depth: number, layout: TopologyLayout): number {
  return layout.hostX + (depth + 1) * layout.columnGap;
}

function edgeClass(kind: "p2p" | "sfu", ready = true): string {
  return `lr-route-edge is-${kind}${ready ? "" : " is-pending"}`;
}

export const RouteTree = memo(function RouteTree({
  hostPeerId,
  hostIdentity,
  hostLabel,
  viewers,
  selfPeerId,
  selectedPeerId,
  selectablePeerIds,
  onSelectPeer,
}: {
  hostPeerId: string | null;
  /** Colour identity for the Host pawn while its peer id is still unknown. */
  hostIdentity?: string | null;
  hostLabel: string;
  viewers: readonly LabeledViewerPresence[];
  selfPeerId?: string | null;
  selectedPeerId?: string | null;
  selectablePeerIds?: readonly string[];
  onSelectPeer?: (peerId: string) => void;
}) {
  const { t } = useCopy();
  const [routeRef, containerWidth] = useElementWidth(DEFAULT_TOPOLOGY_WIDTH);
  const [hoveredPeerId, setHoveredPeerId] = useState<string | null>(null);
  const layoutConfig = topologyLayoutForWidth(containerWidth);
  const topology = deriveParticipantTopology(hostPeerId, viewers);
  const selectable = new Set(
    selectablePeerIds ?? (onSelectPeer ? viewers.map((viewer) => viewer.peerId) : []),
  );
  const selectPeer = (peerId: string): void => {
    if (selectable.has(peerId)) onSelectPeer?.(peerId);
  };

  const nodes: TreeNode[] = [];
  const collect = (branch: TopologyBranch, via: string | null, sfu: boolean) => {
    nodes.push({
      key: branch.viewer.peerId,
      label: branch.viewer.label,
      via,
      sfu,
      you: selfPeerId === branch.viewer.peerId,
      ready: branch.viewer.mediaReady === true,
    });
    branch.children.forEach((child) =>
      collect(child, branch.viewer.peerId, false),
    );
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

  const spacing = nodes.length > 10 ? 58 : 60;
  let row = 0;
  const pos = new Map<string, { x: number; y: number }>();
  function layout(node: TreeNode, depth: number): void {
    const children = childrenOf.get(node.key) ?? [];
    let y: number;
    if (children.length === 0) {
      y = ROW_BASE + row * spacing;
      row += 1;
    } else {
      children.forEach((child) => layout(child, depth + 1));
      y =
        children.reduce((sum, child) => sum + pos.get(child.key)!.y, 0) /
        children.length;
    }
    pos.set(node.key, { x: xForDepth(depth, layoutConfig), y });
  }

  (childrenOf.get(null) ?? []).forEach((node) => layout(node, 0));
  const sfuChildren = childrenOf.get("sfu") ?? [];
  sfuChildren.forEach((node) => layout(node, 1));
  let sfuPos: { x: number; y: number } | null =
    sfuChildren.length > 0
      ? {
          x: xForDepth(0, layoutConfig),
          y:
            sfuChildren.reduce(
              (sum, child) => sum + pos.get(child.key)!.y,
              0,
            ) / sfuChildren.length,
        }
      : null;

  const pendingPos = topology.pending.map((viewer) => {
    const point = {
      x: xForDepth(0, layoutConfig),
      y: ROW_BASE + row * spacing,
    };
    row += 1;
    return { viewer, ...point };
  });

  let height = Math.max(140, row * spacing + 64);
  const rootYs = [
    ...(childrenOf.get(null) ?? []).map((node) => pos.get(node.key)!.y),
    ...(sfuPos ? [sfuPos.y] : []),
    ...pendingPos.map((point) => point.y),
  ];
  const hostPos = {
    x: rootYs.length > 0 ? layoutConfig.hostX : layoutConfig.baseWidth / 2,
    y:
      rootYs.length > 0
        ? rootYs.reduce((sum, y) => sum + y, 0) / rootYs.length
        : height / 2,
  };
  let width = Math.max(
    layoutConfig.baseWidth,
    ...[
      ...pos.values(),
      ...pendingPos,
      ...(sfuPos ? [sfuPos] : []),
    ].map(({ x }) => x + layoutConfig.rightLabelReserve),
  );

  const allYs = [
    ...[...pos.values()].map((point) => point.y),
    ...(sfuPos ? [sfuPos.y] : []),
    ...pendingPos.map((point) => point.y),
    hostPos.y,
  ];
  const minY = Math.min(...allYs) - 26;
  const maxY = Math.max(...allYs) + 34;
  const shift = Math.max(0, (height - (maxY - minY)) / 2 - minY + 4);
  if (shift > 0) {
    pos.forEach((point) => {
      point.y += shift;
    });
    pendingPos.forEach((point) => {
      point.y += shift;
    });
    if (sfuPos) sfuPos.y += shift;
    hostPos.y += shift;
  }

  const labelByPeer = new Map(nodes.map((node) => [node.key, node.label]));
  const topologyTitleId = "room-topology-title";
  const depths = new Map([...pos].map(([key, point]) => [key,
    Math.round((point.x - layoutConfig.hostX) / layoutConfig.columnGap)]));
  const maxDepth = Math.max(1, ...depths.values());
  let fittedGap = layoutConfig.columnGap;
  // Spend spare spacing before changing orientation; keep 96px hit targets apart.
  if (width > layoutConfig.baseWidth && (layoutConfig.baseWidth - 120) / maxDepth >= 104) {
    fittedGap = (layoutConfig.baseWidth - 120) / maxDepth;
    hostPos.x = 60;
    for (const [key, point] of pos) point.x = 60 + depths.get(key)! * fittedGap;
    if (sfuPos) sfuPos.x = 60 + fittedGap;
    for (const point of pendingPos) point.x = 60 + fittedGap;
    width = layoutConfig.baseWidth;
  }
  // Deep routes become a vertical outline at real pawn size. Every participant
  // and actual parent edge remains present; only horizontal indentation compresses.
  const outline = width > layoutConfig.baseWidth;
  if (outline) {
    const indent = Math.min(36, (layoutConfig.baseWidth - 196) / maxDepth);
    hostPos.x = 40;
    hostPos.y = 36;
    let nextRow = 1;
    for (const node of nodes) {
      if (sfuPos && node.key === sfuChildren[0]?.key) {
        sfuPos.x = 40 + indent;
        sfuPos.y = 36 + nextRow++ * spacing;
      }
      pos.set(node.key, { x: 40 + depths.get(node.key)! * indent, y: 36 + nextRow++ * spacing });
    }
    for (const point of pendingPos) {
      point.x = 40 + indent;
      point.y = 36 + nextRow++ * spacing;
    }
    width = layoutConfig.baseWidth;
    height = nextRow * spacing + 20;
  }
  const labelX = (point: { x: number }) => outline ? point.x + 28 : point.x;
  const labelY = (point: { y: number }) => outline ? point.y + 4 : pawnLabelY(point.y, PAWN_SCALE);
  const labelAnchor = outline ? "start" : "middle";
  const labelLimit = (point: { x: number }) => outline
    ? Math.min(layoutConfig.maxVisibleLabelCodePoints, Math.floor((width - point.x - 40) / 11))
    : Math.min(layoutConfig.maxVisibleLabelCodePoints,
      Math.floor((Math.min(fittedGap, point.x * 2, (width - point.x) * 2) - 12) / 11));
  const renderName = (key: string, label: string, point: { x: number; y: number }, state = "") => {
    const canSelect = selectable.has(key);
    const Control = canSelect ? "button" : "span";
    // Keep the original hit box and row pitch; native buttons own Enter/Space.
    // HTML lets the shared Tooltip measure the label and use the top layer.
    return <foreignObject key={`name-${key}`} className="lr-route-name-target"
      x={outline ? point.x - 24 : point.x - 48} y={point.y - 26}
      width={outline ? width - point.x + 16 : 96} height={spacing}>
      <Tooltip overflow={{ text: label, selector: ".lr-route-name" }} className="lr-route-name-hint">
        <Control className={canSelect ? "lr-route-hit" : "lr-route-name-static"}
          type={canSelect ? "button" : undefined}
          aria-label={canSelect ? `${label} · ${t("host.details")}` : undefined}
          onPointerEnter={canSelect ? () => setHoveredPeerId(key) : undefined}
          onPointerLeave={canSelect ? () => setHoveredPeerId(current => current === key ? null : current) : undefined}
          onFocus={canSelect ? () => setHoveredPeerId(key) : undefined}
          onBlur={canSelect ? () => setHoveredPeerId(current => current === key ? null : current) : undefined}
          onClick={canSelect ? event => {
            selectPeer(key);
            if (event.detail !== 0) event.currentTarget.blur();
          } : undefined}>
          <span className={`lr-route-label lr-route-name${state}${hoveredPeerId === key ? " is-hovered" : ""}${selectedPeerId === key ? " is-selected" : ""}`}
            style={{ left: outline ? 52 : "50%", top: Math.min(spacing - 14, labelY(point) - point.y + 14),
              width: outline ? width - point.x - 36 : labelLimit(point) * 11 }}>
            {compactVisibleLabel(label, labelLimit(point))}
          </span>
        </Control>
      </Tooltip>
    </foreignObject>;
  };
  const linkPath = (parent: { x: number; y: number }, child: { x: number; y: number }) => outline
    ? `M ${parent.x - 17} ${parent.y} H ${parent.x - 28} V ${child.y} H ${child.x - 18}`
    : `M ${parent.x + 20} ${parent.y} Q ${(parent.x + child.x) / 2} ${parent.y + (child.y - parent.y) * 0.55}, ${child.x - 18} ${child.y}`;
  const sfuChildPoints = sfuChildren.map((child) => ({
    child,
    point: pos.get(child.key)!,
  }));
  const sfuRail =
    !outline && sfuPos && sfuChildPoints.length > 1
      ? {
          x: sfuPos.x + fittedGap * 0.45,
          minY: Math.min(...sfuChildPoints.map(({ point }) => point.y)),
          maxY: Math.max(...sfuChildPoints.map(({ point }) => point.y)),
        }
      : null;

  return (
    <div
      ref={routeRef}
      className={`lr-route${outline ? " is-outline" : ""}`}
      role="group"
      aria-labelledby={topologyTitleId}
      id="room-topology"
      tabIndex={0}
    >
      <span id={topologyTitleId} className="visually-hidden">
        {t("host.topology")}
      </span>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        aria-label={t("host.topology")}
        style={{ width: "100%", maxWidth: outline || nodes.length > 10 ? layoutConfig.baseWidth : 880 }}
      >
        {nodes
          .filter((node) => !node.sfu)
          .map((node) => {
            const point = pos.get(node.key)!;
            const parent = node.via ? pos.get(node.via)! : hostPos;
            return (
              <path
                key={`edge-${node.key}`}
                d={linkPath(parent, point)}
                className={edgeClass("p2p", node.ready)}
              />
            );
          })}

        {sfuPos ? (
          <>
            <path
              d={linkPath(hostPos, sfuPos)}
              className={edgeClass("sfu")}
            />
            {outline ? sfuChildPoints.map(({ child, point }) => <path key={`edge-${child.key}`}
              d={linkPath(sfuPos!, point)} className={edgeClass("sfu", child.ready)} />) : sfuChildren.length === 1 ? (
              <path
                d={`M ${sfuPos.x + 20} ${sfuPos.y} L ${pos.get(sfuChildren[0]!.key)!.x - 18} ${pos.get(sfuChildren[0]!.key)!.y}`}
                className={edgeClass("sfu", sfuChildren[0]!.ready)}
              />
            ) : sfuRail ? (
              <>
                <path
                  d={`M ${sfuPos.x + 20} ${sfuPos.y} H ${sfuRail.x}`}
                  className={edgeClass("sfu")}
                />
                <path
                  d={`M ${sfuRail.x} ${sfuRail.minY} V ${sfuRail.maxY}`}
                  className={edgeClass("sfu")}
                />
                {sfuChildPoints.map(({ child, point }) => (
                  <path
                    key={`edge-${child.key}`}
                    d={`M ${sfuRail.x} ${point.y} H ${point.x - 18}`}
                    className={edgeClass("sfu", child.ready)}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : null}

        {pendingPos.map((point) => (
          <path
            key={`edge-pending-${point.viewer.peerId}`}
            d={linkPath(hostPos, point)}
            className="lr-route-edge is-pending"
          />
        ))}

        <g
          className="lr-route-node is-host"
          transform={`translate(${centeredPawnX(hostPos.x, PAWN_SCALE)}, ${centeredPawnY(hostPos.y, PAWN_SCALE)}) scale(${PAWN_SCALE})`}
        >
          <PawnSvg
            color={participantColor(hostPeerId ?? hostIdentity ?? "host-pending")}
            identity={hostPeerId ?? hostIdentity ?? undefined}
            host
          />
        </g>

        {sfuPos ? (
          <>
            <g
              className="lr-route-sfu"
              transform={`translate(${sfuPos.x - 20}, ${sfuPos.y - 16})`}
            >
              <rect width="40" height="32" rx="7" />
              <path d="M8 12h24M8 20h24" />
            </g>
            <text
              className="lr-route-label is-sfu"
              x={labelX(sfuPos)}
              y={outline ? sfuPos.y + 4 : sfuPos.y + 32}
              textAnchor={labelAnchor}
            >
              SFU
            </text>
          </>
        ) : null}

        {nodes.map((node) => {
          const point = pos.get(node.key)!;
          const selected = selectedPeerId === node.key;
          const hovered = hoveredPeerId === node.key;
          return (
            <g
              key={node.key}
              className={`lr-route-node${node.ready ? "" : " is-pending"}${hovered ? " is-hovered" : ""}${selected ? " is-selected" : ""}`}
              transform={`translate(${centeredPawnX(point.x, PAWN_SCALE)}, ${centeredPawnY(point.y, PAWN_SCALE)}) scale(${PAWN_SCALE})`}
            >
              <PawnSvg color={participantColor(node.key)} identity={node.key} />
              {hovered && !selected ? (
                <PawnOutline className="lr-route-hover" />
              ) : null}
              {selected ? (
                <PawnOutline className="lr-route-selection" />
              ) : null}
              {node.you ? (
                <PawnOutline className="lr-route-you" />
              ) : null}
            </g>
          );
        })}

        {pendingPos.map((point) => {
          const selected = selectedPeerId === point.viewer.peerId;
          const hovered = hoveredPeerId === point.viewer.peerId;
          return (
            <g
              key={`pending-${point.viewer.peerId}`}
              className={`lr-route-node is-pending${hovered ? " is-hovered" : ""}${selected ? " is-selected" : ""}`}
              transform={`translate(${centeredPawnX(point.x, PAWN_SCALE)}, ${centeredPawnY(point.y, PAWN_SCALE)}) scale(${PAWN_SCALE})`}
            >
              <PawnSvg color={participantColor(point.viewer.peerId)} identity={point.viewer.peerId} />
              {hovered && !selected ? (
                <PawnOutline className="lr-route-hover" />
              ) : null}
              {selected ? (
                <PawnOutline className="lr-route-selection" />
              ) : null}
              {selfPeerId === point.viewer.peerId ? (
                <PawnOutline className="lr-route-you" />
              ) : null}
            </g>
          );
        })}

        {renderName(hostPeerId ?? "host", hostLabel, hostPos, " is-host")}
        {nodes.map(node => renderName(node.key, node.label, pos.get(node.key)!))}
        {pendingPos.map(point => renderName(point.viewer.peerId, point.viewer.label, point, " is-pending"))}
      </svg>

      <ul className="visually-hidden">
        <li>
          {hostLabel} · {t("common.host")}
        </li>
        {nodes.map((node) => {
          const parentLabel = node.via
            ? (labelByPeer.get(node.via) ?? hostLabel)
            : node.sfu
              ? "SFU"
              : hostLabel;
          return (
            <li key={`sr-${node.key}`}>
              {node.label} ← {parentLabel} ·{" "}
              {t(node.sfu ? "state.route.sfu" : "state.route.p2p")}
              {node.ready ? "" : ` · ${t("host.topology.pending")}`}
            </li>
          );
        })}
        {topology.pending.map((viewer) => (
          <li key={`sr-pending-${viewer.peerId}`}>
            {viewer.label} · {t("host.topology.pending")}
          </li>
        ))}
      </ul>
    </div>
  );
});
