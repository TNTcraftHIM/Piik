// The connection topology as a real tree: host (crowned) roots direct P2P
// viewers and the SFU node; relay children hang off their parent viewer.
// Data comes from deriveParticipantTopology.
import { memo, useSyncExternalStore } from "react";

import type { LabeledViewerPresence } from "../../lib/viewer-presence";
import {
  deriveParticipantTopology,
  type TopologyBranch,
} from "../../lib/participant-topology";
import { useCopy } from "../../ui/copy";
import { PawnSvg, pawnColor } from "./Couch";
import {
  topologyLayoutForViewport,
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
const NARROW_TOPOLOGY_QUERY = "(max-width: 640px)";
const PAWN_CENTER_X = 20;
const HOST_SCALE = 0.85;
const ROOT_SCALE = 0.72;
const CHILD_SCALE = 0.52;
const ROOT_LABEL_OFFSET_Y = 36;
const CHILD_LABEL_OFFSET_Y = 20;

function centeredPawnX(centerX: number, scale: number): number {
  return centerX - PAWN_CENTER_X * scale;
}

function subscribeToNarrowViewport(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(NARROW_TOPOLOGY_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function narrowViewportSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.(NARROW_TOPOLOGY_QUERY).matches)
  );
}

function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribeToNarrowViewport,
    narrowViewportSnapshot,
    () => false,
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
  const narrowViewport = useNarrowViewport();
  const layoutConfig = topologyLayoutForViewport(narrowViewport);
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
          narrowViewport || scrollableCanvas
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
          transform={`translate(${centeredPawnX(hostPos.x, HOST_SCALE)}, ${hostPos.y - 20}) scale(${HOST_SCALE})`}
        >
          <PawnSvg color="var(--couch)" crown />
        </g>
        <text
          className="lr-route-label is-host"
          x={hostPos.x}
          y={hostPos.y + 30}
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
          const child = node.via !== null && !node.sfu;
          const selected = selectedPeerId === node.key;
          const scale = child ? CHILD_SCALE : ROOT_SCALE;
          return (
            <g
              key={node.key}
              className={`lr-route-node${node.ready ? "" : " is-recovering"}${selected ? " is-selected" : ""}`}
              transform={`translate(${centeredPawnX(point.x, scale)}, ${point.y - 15}) scale(${scale})`}
            >
              <PawnSvg color={pawnColor(node.key)} />
              {selected ? (
                <circle className="lr-route-selection" cx="20" cy="26" r="25" />
              ) : null}
              {node.you ? (
                <circle className="lr-route-you" cx="20" cy="26" r="21" />
              ) : null}
            </g>
          );
        })}

        {pendingPos.map((point) => (
          <g
            key={`pending-${point.viewer.peerId}`}
            className={`lr-route-node is-recovering${selectedPeerId === point.viewer.peerId ? " is-selected" : ""}`}
            transform={`translate(${centeredPawnX(point.x, ROOT_SCALE)}, ${point.y - 15}) scale(${ROOT_SCALE})`}
          >
            <PawnSvg
              color={pawnColor(point.viewer.peerId)}
            />
            {selectedPeerId === point.viewer.peerId ? (
              <circle className="lr-route-selection" cx="20" cy="26" r="25" />
            ) : null}
            {selfPeerId === point.viewer.peerId ? (
              <circle className="lr-route-you" cx="20" cy="26" r="21" />
            ) : null}
          </g>
        ))}

        {nodes.map((node) => {
          const point = pos.get(node.key)!;
          const child = node.via !== null && !node.sfu;
          return (
            <text
              key={`label-${node.key}`}
              className={`lr-route-label${selectedPeerId === node.key ? " is-selected" : ""}`}
              x={point.x}
              y={
                point.y +
                (child ? CHILD_LABEL_OFFSET_Y : ROOT_LABEL_OFFSET_Y)
              }
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
            className={`lr-route-label is-recovering${selectedPeerId === point.viewer.peerId ? " is-selected" : ""}`}
            x={point.x}
            y={point.y + ROOT_LABEL_OFFSET_Y}
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
                onClick={() => selectPeer(node.key)}
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
