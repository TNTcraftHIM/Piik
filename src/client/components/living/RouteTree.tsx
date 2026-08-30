// The connection topology as a real tree: host (crowned) roots direct P2P
// viewers and the SFU node; relay children hang off their parent viewer.
// Data comes from deriveParticipantTopology.
import { memo, useLayoutEffect, useRef, useState } from "react";

import type { LabeledViewerPresence } from "../../lib/viewer-presence";
import {
  deriveParticipantTopology,
  type TopologyBranch,
} from "../../lib/participant-topology";
import { useCopy } from "../../ui/copy";
import { PawnSvg } from "./Couch";
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
  ready: boolean;
}

const ROW_BASE = 40;
const DEFAULT_TOPOLOGY_WIDTH = 640;
const PAWN_CENTER_X = 20;
const PAWN_SCALE = 0.72;
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
  return `lr-route-edge is-${kind}${ready ? "" : " is-recovering"}`;
}

export const RouteTree = memo(function RouteTree({
  hostPeerId,
  hostLabel,
  viewers,
  selfPeerId,
  selectedPeerId,
  selectablePeerIds,
  onSelectPeer,
}: {
  hostPeerId: string | null;
  hostLabel: string;
  viewers: readonly LabeledViewerPresence[];
  selfPeerId?: string | null;
  selectedPeerId?: string | null;
  selectablePeerIds?: readonly string[];
  onSelectPeer?: (peerId: string) => void;
}) {
  const { t } = useCopy();
  const routeRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(
    DEFAULT_TOPOLOGY_WIDTH,
  );
  const [hoveredPeerId, setHoveredPeerId] = useState<string | null>(null);
  useLayoutEffect(() => {
    const route = routeRef.current;
    if (!route) return;
    const updateWidth = () => {
      const width = Math.round(route.getBoundingClientRect().width);
      if (width > 0) {
        setContainerWidth((current) => (current === width ? current : width));
      }
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(route);
    return () => observer.disconnect();
  }, []);
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

  const height = Math.max(140, row * spacing + 64);
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
  const width = Math.max(
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
  const scrollableCanvas = width > layoutConfig.baseWidth;
  const sfuChildPoints = sfuChildren.map((child) => ({
    child,
    point: pos.get(child.key)!,
  }));
  const sfuRail =
    sfuPos && sfuChildPoints.length > 1
      ? {
          x: sfuPos.x + layoutConfig.columnGap * 0.45,
          minY: Math.min(...sfuChildPoints.map(({ point }) => point.y)),
          maxY: Math.max(...sfuChildPoints.map(({ point }) => point.y)),
        }
      : null;

  return (
    <div
      ref={routeRef}
      className="lr-route"
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
        aria-hidden={onSelectPeer ? undefined : true}
        aria-label={onSelectPeer ? t("host.topology") : undefined}
        focusable={onSelectPeer ? undefined : "false"}
        style={
          scrollableCanvas
            ? { width, maxWidth: "none" }
            : {
                width: "100%",
                maxWidth: nodes.length > 10 ? layoutConfig.baseWidth : 880,
              }
        }
      >
        {nodes
          .filter((node) => !node.sfu)
          .map((node) => {
            const point = pos.get(node.key)!;
            const parent = node.via ? pos.get(node.via)! : hostPos;
            return (
              <path
                key={`edge-${node.key}`}
                d={`M ${parent.x + 20} ${parent.y} Q ${(parent.x + point.x) / 2} ${parent.y + (point.y - parent.y) * 0.55}, ${point.x - 18} ${point.y}`}
                className={edgeClass("p2p", node.ready)}
              />
            );
          })}

        {sfuPos ? (
          <>
            <path
              d={`M ${hostPos.x + 20} ${hostPos.y} L ${sfuPos.x - 20} ${sfuPos.y}`}
              className={edgeClass("sfu")}
            />
            {sfuChildren.length === 1 ? (
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
            d={`M ${hostPos.x + 20} ${hostPos.y} Q ${(hostPos.x + point.x) / 2} ${hostPos.y + (point.y - hostPos.y) * 0.55}, ${point.x - 18} ${point.y}`}
            className="lr-route-edge is-pending"
          />
        ))}

        <g
          className="lr-route-node is-host"
          transform={`translate(${centeredPawnX(hostPos.x, PAWN_SCALE)}, ${centeredPawnY(hostPos.y, PAWN_SCALE)}) scale(${PAWN_SCALE})`}
        >
          <PawnSvg color={participantColor(hostPeerId ?? "host-pending")} crown />
        </g>
        <text
          className="lr-route-label is-host"
          x={hostPos.x}
          y={pawnLabelY(hostPos.y, PAWN_SCALE)}
          textAnchor="middle"
        >
          {compactVisibleLabel(
            hostLabel,
            layoutConfig.maxVisibleLabelCodePoints,
          )}
        </text>

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
              x={sfuPos.x}
              y={sfuPos.y + 32}
              textAnchor="middle"
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
              className={`lr-route-node${node.ready ? "" : " is-recovering"}${hovered ? " is-hovered" : ""}${selected ? " is-selected" : ""}`}
              transform={`translate(${centeredPawnX(point.x, PAWN_SCALE)}, ${centeredPawnY(point.y, PAWN_SCALE)}) scale(${PAWN_SCALE})`}
            >
              <PawnSvg color={participantColor(node.key)} />
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
              className={`lr-route-node is-recovering${hovered ? " is-hovered" : ""}${selected ? " is-selected" : ""}`}
              transform={`translate(${centeredPawnX(point.x, PAWN_SCALE)}, ${centeredPawnY(point.y, PAWN_SCALE)}) scale(${PAWN_SCALE})`}
            >
              <PawnSvg color={participantColor(point.viewer.peerId)} />
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

        {nodes.map((node) => {
          const point = pos.get(node.key)!;
          return (
            <text
              key={`label-${node.key}`}
              className={`lr-route-label${hoveredPeerId === node.key ? " is-hovered" : ""}${selectedPeerId === node.key ? " is-selected" : ""}`}
              x={point.x}
              y={pawnLabelY(point.y, PAWN_SCALE)}
              textAnchor="middle"
            >
              {compactVisibleLabel(
                node.label,
                layoutConfig.maxVisibleLabelCodePoints,
              )}
            </text>
          );
        })}
        {pendingPos.map((point) => (
          <text
            key={`label-pending-${point.viewer.peerId}`}
            className={`lr-route-label is-recovering${hoveredPeerId === point.viewer.peerId ? " is-hovered" : ""}${selectedPeerId === point.viewer.peerId ? " is-selected" : ""}`}
            x={point.x}
            y={pawnLabelY(point.y, PAWN_SCALE)}
            textAnchor="middle"
          >
            {compactVisibleLabel(
              point.viewer.label,
              layoutConfig.maxVisibleLabelCodePoints,
            )}
          </text>
        ))}
        {[...nodes, ...pendingPos.map(({ viewer }) => ({
          key: viewer.peerId,
          label: viewer.label,
        }))]
          .filter((node) => selectable.has(node.key))
          .map((node) => {
            const point = pos.get(node.key) ?? pendingPos.find(
              (pending) => pending.viewer.peerId === node.key,
            );
            if (!point) return null;
            return (
              <rect
                key={`hit-${node.key}`}
                className="lr-route-hit"
                x={point.x - 48}
                y={point.y - 28}
                width={96}
                height={72}
                rx={12}
                role="button"
                tabIndex={0}
                aria-label={`${node.label} · ${t("host.details")}`}
                onPointerEnter={() => setHoveredPeerId(node.key)}
                onPointerLeave={() =>
                  setHoveredPeerId((current) =>
                    current === node.key ? null : current,
                  )
                }
                onFocus={() => setHoveredPeerId(node.key)}
                onBlur={() =>
                  setHoveredPeerId((current) =>
                    current === node.key ? null : current,
                  )
                }
                onClick={(event) => {
                  selectPeer(node.key);
                  if (event.detail !== 0) event.currentTarget.blur();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectPeer(node.key);
                  }
                }}
              />
            );
          })}
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
