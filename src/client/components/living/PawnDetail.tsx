// Per-viewer drill-down: name, route glyph, primary metrics, expandable
// detailed metrics. Host sees every Viewer; a Viewer uses this only for relay
// children because its own route already has the canonical details panel.
import { PawnSvg } from "./Pawn";
import { participantColor } from "./participant-color";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { useCopy } from "../../ui/copy";
import { resolveMediaFailure, type MediaFailure } from "../../ui/media-failure";
import type { ConnectionMetrics } from "../../types";
import { MetricCells } from "./Metrics";

export function RouteGlyph({ route }: { route: "p2p" | "sfu" }) {
  const { t, vis } = useCopy();
  const cell = (
    <span
      className="lr-meter-cell"
      // The route hint is available to keyboard users in every language.
      tabIndex={0}
    >
      {route === "sfu" ? (
        <svg width="36" height="16" viewBox="0 0 36 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="4" cy="8" r="3" fill="currentColor" stroke="none" />
          <rect x="14" y="3" width="8" height="10" rx="2" />
          <circle cx="32" cy="8" r="3" fill="currentColor" stroke="none" />
          <path d="M7 8h7M22 8h7" />
        </svg>
      ) : (
        <svg width="36" height="16" viewBox="0 0 36 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="4" cy="8" r="3" fill="currentColor" stroke="none" />
          <circle cx="32" cy="8" r="3" fill="currentColor" stroke="none" />
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
  return (
    <Tooltip
      kind={route === "sfu" ? "hint-route-sfu" : "hint-route-p2p"}
      text={vis ? undefined : t(route === "sfu" ? "state.route.sfu" : "state.route.p2p")}
    >
      {cell}
    </Tooltip>
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
  error?: MediaFailure | null;
  expanded: boolean;
  onToggleMetrics: (expanded: boolean) => void;
  onClose: () => void;
}) {
  const copy = useCopy();
  const { t, vis } = copy;
  const errorText = resolveMediaFailure(error, copy);
  return (
    <div className="lr-row is-sub lr-pawn-detail" role="group" aria-label={name}>
      <span className="lr-pawn-mini">
        <PawnSvg color={participantColor(pawnKey)} identity={pawnKey} />
      </span>
      <span className="lr-pawn-detail-name">{name}</span>
      {tag ? (
        <span className="lr-meter-cell">
          <Glyph name={tag.icon} size={16} />
          {vis ? <span className="visually-hidden">{tag.label}</span> : <b>{tag.label}</b>}
        </span>
      ) : null}
      {errorText ? (
        <Tooltip kind="route-failed" text={vis ? undefined : errorText}>
          <span
            className="lr-pill is-bad"
            role="alert"
            tabIndex={0}
          >
            <Glyph name="alert" size={16} />
            {vis ? <span className="visually-hidden">{errorText}</span> : <span>{errorText}</span>}
          </span>
        </Tooltip>
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
      <Tooltip kind="hint-close" text={vis ? undefined : t("common.close")}>
        <button
          type="button"
          className="lr-pawn-detail-close"
          aria-label={t("common.close")}
          onClick={(event) => {
            // Pointer activation must not pin the hint open; keyboard keeps focus.
            if (event.detail !== 0) event.currentTarget.blur();
            onClose();
          }}
        >
          <Glyph name="x" size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
