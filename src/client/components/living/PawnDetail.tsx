// Per-viewer drill-down: name, route glyph, primary metrics, expandable
// detailed metrics. Host sees every Viewer; a Viewer uses this only for relay
// children because its own route already has the canonical details panel.
import { PawnSvg } from "./Couch";
import { participantColor } from "./participant-color";
import { Glyph } from "../../ui/icons";
import { ComicTooltip } from "./ComicTooltip";
import { useCopy } from "../../ui/copy";
import type { ConnectionMetrics } from "../../types";
import { MetricCells } from "./Metrics";

export function RouteGlyph({ route }: { route: "p2p" | "sfu" }) {
  const { t, vis } = useCopy();
  const cell = (
    <span
      className="lr-meter-cell"
      title={vis ? undefined : t(route === "sfu" ? "state.route.sfu" : "state.route.p2p")}
      // Hint-wrapped in vis: focusable so keyboard users reach the comic.
      tabIndex={vis ? 0 : undefined}
    >
      {route === "sfu" ? (
        <svg width="36" height="16" viewBox="0 0 36 16" fill="none" stroke="#53676a" strokeWidth="2" aria-hidden="true">
          <circle cx="4" cy="8" r="3" fill="#53676a" stroke="none" />
          <rect x="14" y="3" width="8" height="10" rx="2" />
          <circle cx="32" cy="8" r="3" fill="#53676a" stroke="none" />
          <path d="M7 8h7M22 8h7" />
        </svg>
      ) : (
        <svg width="36" height="16" viewBox="0 0 36 16" fill="none" stroke="#53676a" strokeWidth="2" aria-hidden="true">
          <circle cx="4" cy="8" r="3" fill="#53676a" stroke="none" />
          <circle cx="32" cy="8" r="3" fill="#53676a" stroke="none" />
          <path d="M7 8h22" />
        </svg>
      )}
      {vis ? (
        <span className="visually-hidden">
          {t(route === "sfu" ? "state.route.sfu" : "state.route.p2p")}
        </span>
      ) : (
        <b>{route === "sfu" ? "SFU" : "P2P"}</b>
      )}
    </span>
  );
  return vis ? (
    <ComicTooltip kind={route === "sfu" ? "hint-route-sfu" : "hint-route-p2p"}>
      {cell}
    </ComicTooltip>
  ) : (
    cell
  );
}

export function PawnDetail({
  pawnKey,
  name,
  route,
  metrics,
  direction,
  tag,
  error,
  expanded,
  onToggleMetrics,
  onClose,
}: {
  pawnKey: string;
  name: string;
  route: "p2p" | "sfu" | null;
  metrics?: ConnectionMetrics | null;
  direction: "send" | "receive";
  tag?: { icon: "arrowUp" | "loader"; label: string };
  error?: string | null;
  expanded: boolean;
  onToggleMetrics: (expanded: boolean) => void;
  onClose: () => void;
}) {
  const { t, vis } = useCopy();
  return (
    <div className="lr-row is-sub lr-pawn-detail" role="group" aria-label={name}>
      <span className="lr-pawn-mini">
        <PawnSvg color={participantColor(pawnKey)} />
      </span>
      {vis ? (
        <span className="visually-hidden">{name}</span>
      ) : (
        <span className="lr-pawn-detail-name">{name}</span>
      )}
      {tag ? (
        <span className="lr-meter-cell" title={vis ? undefined : tag.label}>
          <Glyph name={tag.icon} size={16} />
          {vis ? <span className="visually-hidden">{tag.label}</span> : <b>{tag.label}</b>}
        </span>
      ) : null}
      {error ? (
        <ComicTooltip kind="route-failed">
          <span
            className="lr-pill is-bad"
            role="alert"
            title={vis ? undefined : error}
            // Comic-wrapped: focusable so keyboard users reach the comic.
            tabIndex={vis ? 0 : undefined}
          >
            <Glyph name="alert" size={16} />
            {vis ? <span className="visually-hidden">{error}</span> : <span>{error}</span>}
          </span>
        </ComicTooltip>
      ) : null}
      {route ? <RouteGlyph route={route} /> : null}
      {metrics ? (
        <MetricCells
          metrics={metrics}
          direction={direction}
          expanded={expanded}
          onToggle={onToggleMetrics}
        />
      ) : null}
      {vis ? (
        <ComicTooltip kind="hint-close">
          <button
            type="button"
            className="lr-pawn-detail-close"
            aria-label={t("common.close")}
            onClick={(event) => {
              // Pointer activation must not leave the comic pinned by focus.
              if (event.detail !== 0) event.currentTarget.blur();
              onClose();
            }}
          >
            <Glyph name="x" size={16} />
          </button>
        </ComicTooltip>
      ) : (
        <button
          type="button"
          className="lr-pawn-detail-close"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <Glyph name="x" size={16} />
        </button>
      )}
    </div>
  );
}
