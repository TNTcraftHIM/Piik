import { memo, useId, useState } from "react";
import { useElementWidth } from "../../lib/use-element-width";
import { useCopy } from "../../ui/copy";
import { PawnSvg } from "./Pawn";
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

/** Pure route presentation: callers own identities, topology, selection and proof. */
export const RouteGraph = memo(function RouteGraph({ nodes, rootId, edges, selectedId, selectableIds, onSelect }: {
  nodes: readonly RouteGraphNode[];
  rootId: string;
  edges: readonly RouteGraphEdge[];
  selectedId?: string | null;
  selectableIds?: readonly string[];
  onSelect?: (id: string) => void;
}) {
  const { t, vis } = useCopy();
  const titleId = useId();
  const [routeRef, containerWidth] = useElementWidth(640);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { config, points, order, width, height, spacing, fittedGap, outline } = routeGraphLayout(nodes, rootId, edges, containerWidth);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const selectable = new Set(selectableIds ?? (onSelect ? nodes.map(node => node.id) : []));
  const pending = (node: RouteGraphNode) => node.pending ??
    (edges.some(edge => edge.to === node.id) && !edges.some(edge => edge.to === node.id && edge.selected && edge.ready));
  const labelY = (point: { y: number }) => outline ? point.y + 4 : point.y + 24 * PAWN_SCALE + 12;
  const labelLimit = (point: { x: number }) => outline
    ? Math.min(config.maxVisibleLabelCodePoints, Math.floor((width - point.x - 40) / 11))
    : Math.min(config.maxVisibleLabelCodePoints,
      Math.floor((Math.min(fittedGap, point.x * 2, (width - point.x) * 2) - 12) / 11));
  const renderName = (node: RouteGraphNode) => {
    const point = points.get(node.id)!;
    const canSelect = selectable.has(node.id);
    const Control = canSelect ? "button" : "span";
    const state = `${node.host ? " is-host" : ""}${pending(node) ? " is-pending" : ""}`;
    return <foreignObject key={`name-${node.id}`} className="lr-route-name-target"
      x={outline ? point.x - 24 : point.x - 48} y={point.y - 26}
      width={outline ? width - point.x + 16 : 96} height={spacing}>
      <Tooltip overflow={{ text: node.label, selector: ".lr-route-name" }} className="lr-route-name-hint">
        <Control className={canSelect ? "lr-route-hit" : "lr-route-name-static"}
          type={canSelect ? "button" : undefined}
          aria-label={canSelect ? `${node.label} · ${t("host.details")}` : undefined}
          onPointerEnter={canSelect ? () => setHoveredId(node.id) : undefined}
          onPointerLeave={canSelect ? () => setHoveredId(current => current === node.id ? null : current) : undefined}
          onFocus={canSelect ? () => setHoveredId(node.id) : undefined}
          onBlur={canSelect ? () => setHoveredId(current => current === node.id ? null : current) : undefined}
          onClick={canSelect ? event => {
            onSelect?.(node.id);
            if (event.detail !== 0) event.currentTarget.blur();
          } : undefined}>
          <span className={`lr-route-label lr-route-name${state}${hoveredId === node.id ? " is-hovered" : ""}${selectedId === node.id ? " is-selected" : ""}`}
            style={{ left: outline ? 52 : "50%", top: Math.min(spacing - 14, labelY(point) - point.y + 14),
              width: outline ? width - point.x - 36 : labelLimit(point) * 11 }}>
            {compactVisibleLabel(node.label, labelLimit(point))}
          </span>
        </Control>
      </Tooltip>
    </foreignObject>;
  };
  const linkPath = (parent: { x: number; y: number }, child: { x: number; y: number },
    from = outline ? 17 : 20, to = 18) => outline
    ? `M ${parent.x - from} ${parent.y} H ${parent.x - 28} V ${child.y} H ${child.x - to}`
    : `M ${parent.x + from} ${parent.y} Q ${(parent.x + child.x) / 2} ${parent.y + (child.y - parent.y) * 0.55}, ${child.x - to} ${child.y}`;
  // Only an explicit SFU node and its selected SFU edges use the existing rail.
  const rails = new Map(nodes.filter(node => node.kind === "sfu").flatMap(node => {
    const children = edges.filter(edge => edge.from === node.id && edge.selected && edge.route === "sfu" && points.has(edge.to));
    if (outline || children.length < 2) return [];
    const point = points.get(node.id)!;
    return [[node.id, { x: point.x + fittedGap * .45, edges: children,
      minY: Math.min(...children.map(edge => points.get(edge.to)!.y)),
      maxY: Math.max(...children.map(edge => points.get(edge.to)!.y)) }] as const];
  }));
  const drawableEdges = edges.filter(edge => points.has(edge.from) && points.has(edge.to));
  return <div ref={routeRef} className={`lr-route${outline ? " is-outline" : ""}`} role="group" aria-labelledby={titleId} tabIndex={0}>
    <span id={titleId} className="visually-hidden">{t("host.topology")}</span>
    {drawableEdges.length === 0 && !nodes.some(pending) ? <p className={vis ? "visually-hidden" : "lr-route-idle"}>{t("host.topology.idle")}</p> : null}
    <svg viewBox={`0 0 ${width} ${height}`} aria-label={t("host.topology")}
      style={{ width: "100%", maxWidth: outline || nodes.length > 11 ? config.baseWidth : 880 }}>
      {drawableEdges.map((edge, index) => {
        const parent = points.get(edge.from)!, point = points.get(edge.to)!;
        const rail = rails.get(edge.from);
        const d = rail?.edges.includes(edge)
          ? `M ${rail.x} ${point.y} H ${point.x - 18}`
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
        if (node.kind === "sfu") return <g key={id}>
          <g className="lr-route-sfu" transform={`translate(${point.x - SFU_HALF_WIDTH}, ${point.y - 16})`}>
            <rect width={SFU_HALF_WIDTH * 2} height="32" rx="7" /><path d="M8 12h24M8 20h24" />
          </g>
          <text className="lr-route-label is-sfu" x={outline ? point.x + 28 : point.x}
            y={outline ? point.y + 4 : point.y + 32} textAnchor={outline ? "start" : "middle"}>{node.label}</text>
        </g>;
        const selected = selectedId === id, hovered = hoveredId === id;
        return <g key={id} className={`lr-route-node${node.host ? " is-host" : ""}${pending(node) ? " is-pending" : ""}${hovered ? " is-hovered" : ""}${selected ? " is-selected" : ""}`}
          transform={`translate(${point.x - 20 * PAWN_SCALE}, ${point.y - 24 * PAWN_SCALE}) scale(${PAWN_SCALE})`}>
          <PawnSvg color={participantColor(node.identity ?? id)} identity={node.identity ?? id} host={node.host} />
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
        return <li key={node.id}>{node.description ? <>{node.label} · {node.description}</> : incoming.length ? incoming.map((edge, index) => <span key={index}>
          {index ? "; " : ""}{node.label} ← {byId.get(edge.from)!.label} · {t(edge.route === "sfu" ? "state.route.sfu" : "state.route.p2p")}
          {edge.selected && edge.ready ? "" : ` · ${t("host.topology.pending")}`}
        </span>) : <>{node.label}{node.host ? ` · ${t("common.host")}` : ""}</>}</li>;
      })}
    </ul>
  </div>;
});
