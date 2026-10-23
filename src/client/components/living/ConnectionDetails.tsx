import { useId, useState, type ReactNode } from "react";
import type { ConnectionMetrics } from "../../types";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { ConnectionSummaryCells, MetricCells, MetricDetailsToggle, hasDetailedMetrics } from "./Metrics";
import { Tooltip } from "./Tooltip";

export interface ConnectionDetail {
  key: string;
  connectionId?: string;
  media: "video" | "audio";
  label: string;
  icon?: GlyphName;
  route?: "p2p" | "sfu" | null;
  direction?: "send" | "receive";
  metrics?: ConnectionMetrics | null;
  cells?: ReactNode;
  note?: ReactNode;
  /** Remote receive reports remain available without counting the same local traffic twice. */
  detailOnly?: boolean;
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

function ConnectionDetailHeading({ media, label, icon, direction, note, routes = [] }: Pick<ConnectionDetail,
  "media" | "label" | "icon" | "direction" | "note"> & { routes?: readonly ("p2p" | "sfu")[] }) {
  const { vis } = useCopy();
  return <div className="lr-media-detail-head">
    <span className="lr-meter-tag">
      <Glyph name={icon ?? (media === "audio" ? "headphones" : "tv")} size={17} />
      {direction && <span className="lr-media-direction"><Glyph name={direction === "send" ? "arrowUp" : "arrowDown"} size={12} /></span>}
      <span className={vis ? "visually-hidden" : "lr-cap"}>{label}</span>
    </span>
    {routes.map(route => <RouteGlyph key={route} route={route} />)}
    {note}
  </div>;
}

// Four presentation categories; physical connections and their observations
// remain independent and retain their full detail beneath the summaries.
export function ConnectionDetails({ rows, id }: { rows: readonly ConnectionDetail[]; id?: string }) {
  const { t } = useCopy();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const groups = (["video", "audio"] as const).flatMap(media => (["receive", "send"] as const).flatMap(direction => {
    const members = rows.filter(row => !row.detailOnly && (row.metrics || row.cells) && row.media === media && (row.direction ?? "receive") === direction);
    return members.length ? [{ key: `${media}/${direction}`, media, direction, members }] : [];
  }));
  const extraDetails = rows.filter(row => row.detailOnly);
  const notices = rows.filter(row => !row.detailOnly && !row.metrics && !row.cells);
  const expandable = extraDetails.length > 0 || groups.some(group => group.media === "audio" || group.members.length > 1 ||
    group.members.some(row => row.metrics && hasDetailedMetrics(row.metrics, group.direction, group.media)));
  const rawDetail = (row: ConnectionDetail, primary = true) => <section className="lr-media-detail" key={row.key} role="group" aria-label={row.label}>
    <ConnectionDetailHeading {...row} routes={row.route ? [row.route] : []} />
    {row.cells ?? (row.metrics && <MetricCells metrics={row.metrics} direction={row.direction ?? "receive"} media={row.media} primary={primary} expanded />)}
  </section>;
  if (!rows.length) return null;
  return <div className="lr-connection-details" id={id} role="group" aria-label={t("host.details")}>
    <div className="lr-connection-details-body" id={bodyId}>
      {notices.map(row => <div className="lr-connection-notice" key={row.key}>
        <ConnectionDetailHeading {...row} routes={row.route ? [row.route] : []} />
      </div>)}
      {groups.map(group => {
        const single = group.members.length === 1 ? group.members[0]! : null;
        const label = single?.cells ? single.label
          : t(group.media === "video" ? group.direction === "send" ? "stats.pictureSend" : "stats.pictureReceive"
            : group.direction === "send" ? "stats.voiceSend" : "stats.voiceReceive");
        const routes = [...new Set(group.members.flatMap(row => row.route ? [row.route] : []))];
        const samples = group.members.flatMap(row => row.metrics ? [{ connectionId: row.connectionId ?? row.key, metrics: row.metrics }] : []);
        return <section className="lr-media-detail lr-connection-summary" key={group.key} role="group" aria-label={label}
          data-media={group.media} data-direction={group.direction}>
          <ConnectionDetailHeading media={group.media} direction={group.direction} label={label}
            icon={single?.cells ? single.icon : undefined} routes={routes} note={single?.note} />
          {samples.length ? <ConnectionSummaryCells samples={samples} media={group.media} direction={group.direction} /> : group.members[0]!.cells}
          {expanded && (group.members.length > 1 || group.media === "audio"
            ? <div className="lr-connection-paths">{group.members.map(row => rawDetail(row, group.members.length > 1))}</div>
            : group.members[0]!.metrics && <MetricCells metrics={group.members[0]!.metrics} media={group.media} direction={group.direction} primary={false} expanded />)}
        </section>;
      })}
      {expanded && extraDetails.map(row => rawDetail(row))}
    </div>
    {expandable && <MetricDetailsToggle expanded={expanded} onToggle={setExpanded} controls={bodyId} />}
  </div>;
}
