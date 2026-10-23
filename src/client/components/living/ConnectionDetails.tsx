import { useId, useState, type ReactNode } from "react";
import type { ConnectionMetrics } from "../../types";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { MetricCells, MetricDetailsToggle, hasDetailedMetrics } from "./Metrics";
import { Tooltip } from "./Tooltip";

export interface ConnectionDetail {
  key: string;
  media: "video" | "audio";
  label: string;
  icon?: GlyphName;
  route?: "p2p" | "sfu" | null;
  direction?: "send" | "receive";
  metrics?: ConnectionMetrics | null;
  cells?: ReactNode;
  note?: ReactNode;
}

export function RouteGlyph({ route }: { route: "p2p" | "sfu" }) {
  const { t, vis } = useCopy();
  const label = t(route === "sfu" ? "state.route.sfu" : "state.route.p2p");
  return <Tooltip toggleOnClick kind={route === "sfu" ? "hint-route-sfu" : "hint-route-p2p"} text={vis ? undefined : label}>
    <button type="button" className="lr-meter-cell" aria-label={label}
      style={{ border: 0, color: "inherit", font: "inherit", textAlign: "start" }}>
      <svg width="36" height="16" viewBox="0 0 36 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="4" cy="8" r="3" fill="currentColor" stroke="none" />
        <circle cx="32" cy="8" r="3" fill="currentColor" stroke="none" />
        {route === "sfu" ? <><rect x="14" y="3" width="8" height="10" rx="2" /><path d="M7 8h7M22 8h7" /></> : <path d="M7 8h22" />}
      </svg>
      {vis ? <span className="visually-hidden">{label}</span> : <b>{route === "sfu" ? "SFU" : "P2P"}</b>}
    </button>
  </Tooltip>;
}

// A participant has one detail surface and one expansion, independent of how
// many picture/voice directions are observed. Samples keep their own routes.
export function ConnectionDetails({ rows, id }: { rows: readonly ConnectionDetail[]; id?: string }) {
  const { t, vis } = useCopy();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const expandable = rows.some(row => row.metrics && hasDetailedMetrics(row.metrics, row.direction ?? "receive", row.media));
  if (!rows.length) return null;
  return <div className="lr-connection-details" id={id} role="group" aria-label={t("host.details")}>
    <div className="lr-connection-details-body" id={bodyId}>
      {rows.map(row => <section className="lr-media-detail" key={row.key} role="group" aria-label={row.label}>
        <div className="lr-media-detail-head">
          <span className="lr-meter-tag">
            <Glyph name={row.icon ?? (row.media === "audio" ? "headphones" : "tv")} size={17} />
            {row.media === "audio" && row.direction && <span className="lr-media-direction">
              <Glyph name={row.direction === "send" ? "arrowUp" : "arrowDown"} size={12} />
            </span>}
            <span className={vis ? "visually-hidden" : "lr-cap"}>{row.label}</span>
          </span>
          {row.route && <RouteGlyph route={row.route} />}
          {row.note}
        </div>
        {row.cells ?? (row.metrics && <MetricCells metrics={row.metrics} direction={row.direction ?? "receive"}
          media={row.media} expanded={expanded} />)}
      </section>)}
    </div>
    {expandable && <MetricDetailsToggle expanded={expanded} onToggle={setExpanded} controls={bodyId} />}
  </div>;
}
