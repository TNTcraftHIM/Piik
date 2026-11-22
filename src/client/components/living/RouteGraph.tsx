import { memo, useId, useState, type CSSProperties } from "react";
import { useElementWidth } from "../../lib/use-element-width";
import { useCopy } from "../../ui/copy";
import { PawnSvg } from "./Pawn";
import { Glyph } from "../../ui/icons";
import { HostMark } from "./HostMark";
import { Tooltip } from "./Tooltip";
import { participantColor } from "./participant-color";
import { routeGraphLayout, type RouteGraphNode, type RouteGraphEdge } from "./route-tree-layout";

export type { RouteGraphNode, RouteGraphEdge } from "./route-tree-layout";

const PAWN_SCALE = 0.82;
const SFU_HALF_WIDTH = 20;

function PawnOutline({ className }: { className: string }) {
  return <rect className={className} x="1" y="2" width="38" height="46" rx="8" />;
}

function compactVisibleLabel(label: string, maximumCodePoints: number): string {
  const codePoints = Array.from(label);
  if (codePoints.length <= maximumCodePoints) return label;
  const suffix = label.match(/ \([^()]+\)$/u)?.[0];
  if (suffix) {
    const suffixCodePoints = Array.from(suffix);
    const nameCodePoints = Array.from(label.slice(0, -suffix.length));
    return `${nameCodePoints.slice(0, Math.max(0, maximumCodePoints - suffixCodePoints.length - 1)).join("")}…${suffix}`;
  }
  return `${codePoints.slice(0, maximumCodePoints - 1).join("")}…`;
}

function edgeClass(edge: RouteGraphEdge): string {
  return `lr-route-edge is-${edge.route ?? "p2p"}${edge.selected && edge.ready ? "" : " is-pending"}${edge.presentation ? " is-presentation" : ""}`;
}

function fullLabel(node: RouteGraphNode): string {
  return node.endpointLabel ? `${node.label} (${node.endpointLabel})` : node.label;
}

/** Pure route presentation: callers own identities, topology, selection and proof. */
export const RouteGraph = memo(function RouteGraph({ nodes, rootId, edges, selectedId, selectableIds, onSelect, emptyLabel, label }: {
  nodes: readonly RouteGraphNode[];
  rootId: string | null;
  edges: readonly RouteGraphEdge[];
  selectedId?: string | null;
  selectableIds?: readonly string[];
  onSelect?: (id: string) => void;
  emptyLabel?: string;
  label?: string;
}) {
  const { t } = useCopy();
  const titleId = useId();
  const undirected = rootId === null;
  const graphLabel = label ?? t("host.topology");
  const [routeRef, containerWidth] = useElementWidth(640);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { config, points, order, width, height, spacing, fittedGap, outline } = routeGraphLayout(nodes, rootId, edges, containerWidth);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const selectable = new Set(selectableIds ?? (onSelect ? nodes.map(node => node.id) : []));
  const pending = (node: RouteGraphNode) => node.pending ??
    (!undirected && edges.some(edge => edge.to === node.id) && !edges.some(edge => edge.to === node.id && edge.selected && edge.ready));
  const labelAbove = (y: number) => undirected && nodes.length > 2 && y < height / 2;
  const labelTop = (y: number, twoLines: boolean) => labelAbove(y) ? (twoLines ? -23 : -9)
    : Math.min(spacing - 14, outline ? (twoLines ? 11 : 18) : 24 * PAWN_SCALE + 26);
  const nameSpace = (x: number) => Math.min(fittedGap, x * 2, (width - x) * 2) - 12;
  const labelLimit = (point: { x: number }) => undirected ? Math.floor(nameSpace(point.x) / 5)
    : Math.min(config.maxVisibleLabelCodePoints, Math.floor((outline ? width - point.x - 40 : nameSpace(point.x)) / 11));
  const renderName = (node: RouteGraphNode) => {
    const point = points.get(node.id)!;
    const canSelect = selectable.has(node.id);
    const Control = canSelect ? "button" : "span";
    const side = point.labelSide;
    const stacked = side === "top" || side === "bottom";
    const detail = node.endpointLabel;
    const labelStyle: CSSProperties = stacked ? {
      left: "50%", top: side === "top" ? (detail ? -28 : -14) : 49,
      width: 92, textAlign: "center", transform: "translateX(-50%)",
    } : side ? {
      left: side === "right" ? 48 : undefined,
      right: side === "left" ? 48 : undefined,
      top: detail ? 12 : 19,
      width: (side === "right" ? width - point.x : point.x) - 24,
      textAlign: side === "right" ? "left" : "right",
    } : {
      left: outline ? 52 : "50%", top: labelTop(point.y, !!detail),
      width: outline ? width - point.x - 36 : undirected ? nameSpace(point.x) : labelLimit(point) * 11,
    };
    const state = `${node.host ? " is-host" : ""}${pending(node) ? " is-pending" : ""}`;
    return <foreignObject key={`name-${node.id}`} className="lr-route-name-target"
      x={outline ? point.x - 24 : point.x - 48} y={point.y - 26}
      width={side ? 48 : outline ? width - point.x + 16 : 96} height={spacing}>
      <Tooltip overflow={{ text: fullLabel(node), selector: detail ? ".lr-route-name-text" : ".lr-route-name" }} className="lr-route-name-hint">
        <Control className={canSelect ? "lr-route-hit" : "lr-route-name-static"}
          type={canSelect ? "button" : undefined}
          aria-label={canSelect ? `${fullLabel(node)} · ${t("host.details")}` : undefined}
          onPointerEnter={canSelect ? () => setHoveredId(node.id) : undefined}
          onPointerLeave={canSelect ? () => setHoveredId(current => current === node.id ? null : current) : undefined}
          onFocus={canSelect ? () => setHoveredId(node.id) : undefined}
          onBlur={canSelect ? () => setHoveredId(current => current === node.id ? null : current) : undefined}
          onClick={canSelect ? event => {
            onSelect?.(node.id);
            if (event.detail !== 0) event.currentTarget.blur();
          } : undefined}>
          <span className={`lr-route-label lr-route-name${state}${hoveredId === node.id ? " is-hovered" : ""}${selectedId === node.id ? " is-selected" : ""}`}
            style={labelStyle}>
            {detail ? <><span className="lr-route-name-text">{node.label}</span><span className="lr-route-endpoint-label">{detail}</span></>
              : side ? node.label : compactVisibleLabel(node.label, labelLimit(point))}
          </span>
        </Control>
      </Tooltip>
    </foreignObject>;
  };
  const linkPath = (parent: { x: number; y: number }, child: { x: number; y: number },
    from = outline ? 17 : 20, to = 18) => outline
    ? `M ${parent.x - from} ${parent.y} H ${parent.x - 28} V ${child.y} H ${child.x - to}`
    : `M ${parent.x + from} ${parent.y} Q ${(parent.x + child.x) / 2} ${parent.y + (child.y - parent.y) * 0.55}, ${child.x - to} ${child.y}`;
  const pairPath = (first: { x: number; y: number }, second: { x: number; y: number }, from: number, to: number) => {
    const dx = second.x - first.x, dy = second.y - first.y;
    const length = Math.hypot(dx, dy);
    const x = dx / length, y = dy / length;
    return `M ${first.x + from * x} ${first.y + from * y} L ${second.x - to * x} ${second.y - to * y}`;
  };
  // Only an explicit SFU node and its selected SFU edges use the existing rail.
  const rails = new Map(nodes.filter(node => node.kind === "sfu").flatMap(node => {
    const children = edges.filter(edge => edge.from === node.id && edge.selected && edge.route === "sfu" && points.has(edge.to));
    if (undirected || outline || children.length < 2) return [];
    const point = points.get(node.id)!;
    return [[node.id, { x: point.x + fittedGap * .45, edges: children,
      minY: Math.min(...children.map(edge => points.get(edge.to)!.y)),
      maxY: Math.max(...children.map(edge => points.get(edge.to)!.y)) }] as const];
  }));
  const drawableEdges = edges.filter(edge => points.has(edge.from) && points.has(edge.to));
  return <div ref={routeRef} className={`lr-route${outline ? " is-outline" : ""}`} role="group" aria-labelledby={titleId} tabIndex={0}>
    <span id={titleId} className="visually-hidden">{graphLabel}</span>
    {drawableEdges.length === 0 && !nodes.some(pending) ? <p className="lr-route-idle">{emptyLabel ?? t("host.topology.idle")}</p> : null}
    <svg viewBox={`0 0 ${width} ${height}`} aria-label={graphLabel}
      style={{ width: "100%", maxWidth: undirected && outline ? width : outline || nodes.length > 11 ? config.baseWidth : 880 }}>
      {drawableEdges.map((edge, index) => {
        const parent = points.get(edge.from)!, point = points.get(edge.to)!;
        const rail = rails.get(edge.from);
        const d = rail?.edges.includes(edge)
          ? `M ${rail.x} ${point.y} H ${point.x - 18}`
          : undirected ? pairPath(parent, point, byId.get(edge.from)?.kind === "sfu" ? SFU_HALF_WIDTH : 20,
            byId.get(edge.to)?.kind === "sfu" ? SFU_HALF_WIDTH : 20)
          : linkPath(parent, point, byId.get(edge.from)?.kind === "sfu" ? SFU_HALF_WIDTH : undefined,
            byId.get(edge.to)?.kind === "sfu" ? SFU_HALF_WIDTH : undefined);
        return <path key={`edge-${index}`} d={d} className={edgeClass(edge)} />;
      })}
      {[...rails].map(([id, rail]) => {
        const point = points.get(id)!;
        return <g key={`rail-${id}`}>
          <path d={`M ${point.x + SFU_HALF_WIDTH} ${point.y} H ${rail.x}`} className="lr-route-edge is-sfu" />
          <path d={`M ${rail.x} ${rail.minY} V ${rail.maxY}`} className="lr-route-edge is-sfu" />
        </g>;
      })}
      {order.map(id => {
        const node = byId.get(id)!, point = points.get(id)!;
        const side = point.labelSide ?? (outline ? "right" : labelAbove(point.y) ? "top" : "bottom");
        if (node.kind === "sfu") return <g key={id}>
          <g className="lr-route-sfu" transform={`translate(${point.x - SFU_HALF_WIDTH}, ${point.y - 16})`}>
            <rect width={SFU_HALF_WIDTH * 2} height="32" rx="7" /><path d="M8 12h24M8 20h24" />
          </g>
          <text className="lr-route-label is-sfu" x={point.x + (side === "left" ? -26 : side === "right" ? 28 : 0)}
            y={point.y + (side === "top" ? -24 : side === "bottom" ? 32 : 4)}
            textAnchor={side === "left" ? "end" : side === "right" ? "start" : "middle"}>{node.label}</text>
        </g>;
        const selected = selectedId === id, hovered = hoveredId === id;
        return <g key={id} className={`lr-route-node${node.host ? " is-host" : ""}${pending(node) ? " is-pending" : ""}${hovered ? " is-hovered" : ""}${selected ? " is-selected" : ""}`}
          transform={`translate(${point.x - 20 * PAWN_SCALE}, ${point.y - 24 * PAWN_SCALE}) scale(${PAWN_SCALE})`}>
          {node.kind === "endpoint" ? <g color={participantColor(node.identity ?? id)}>
            {node.endpointKind ? <g transform="translate(4 8)">
              <Glyph name={node.endpointKind === "app" ? "display" : "window"} size={32} />
            </g> : <circle cx="20" cy="24" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" />}
            {node.host && <HostMark x={14} y={0} width={12} />}
          </g> : <PawnSvg color={participantColor(node.identity ?? id)} identity={node.identity ?? id} host={node.host} />}
          {hovered && !selected ? <PawnOutline className="lr-route-hover" /> : null}
          {selected ? <PawnOutline className="lr-route-selection" /> : null}
          {node.you ? <PawnOutline className="lr-route-you" /> : null}
        </g>;
      })}
      {nodes.filter(node => node.kind !== "sfu").map(renderName)}
    </svg>
    <ul className="visually-hidden">
      {nodes.map(node => {
        const incoming = drawableEdges.filter(edge => edge.to === node.id);
        return <li key={node.id}>{fullLabel(node)}{node.host ? ` · ${t("common.host")}` : ""}
          {node.description ? ` · ${node.description}` : incoming.map((edge, index) => <span key={index}>
            {index ? "; " : " "}{undirected ? "↔" : "←"} {fullLabel(byId.get(edge.from)!)}
            {undirected ? (edge.ready ? ` · ${t("state.peer.connected")}` : "")
              : ` · ${t(edge.presentation ? "connection.localDisplay" : edge.route === "sfu" ? "state.route.sfu" : "state.route.p2p")}`}
            {edge.selected && edge.ready ? "" : ` · ${t("host.topology.pending")}`}
          </span>)}
        </li>;
      })}
    </ul>
  </div>;
});
