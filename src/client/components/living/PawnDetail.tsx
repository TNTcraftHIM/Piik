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
import { Pill } from "./primitives";
import { ConnectionDetails, type ConnectionDetail } from "./ConnectionDetails";

export function PawnDetail({
  pawnKey,
  name,
  route,
  metrics,
  direction,
  tag,
  error,
  onClose,
  voiceDetails = [],
}: {
  pawnKey: string;
  name: string;
  route: "p2p" | "sfu" | null;
  metrics?: ConnectionMetrics | null;
  direction: "send" | "receive";
  tag?: { icon: "arrowUp" | "loader" | "headphones"; label: string };
  error?: MediaFailure | null;
  onClose: () => void;
  voiceDetails?: readonly ConnectionDetail[];
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
      <Tooltip kind="hint-close" text={vis ? undefined : t("common.close")}>
        <button
          type="button"
          className="lr-btn is-dense is-quiet"
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
      <ConnectionDetails rows={[
        ...(route || metrics || tag || error ? [{
          key: "picture", media: "video" as const, label: t("stats.sharedMedia"), route, metrics, direction,
          note: <>{tag ? (
            <span className="lr-meter-cell">
              <Glyph name={tag.icon} size={16} />
              {vis ? <span className="visually-hidden">{tag.label}</span> : <b>{tag.label}</b>}
            </span>
          ) : null}
          {errorText ? (
            <Pill icon="alert" tone="bad" label={errorText} comic="route-failed" alert />
          ) : null}</>,
        }] : []),
        ...voiceDetails,
      ]} />
    </div>
  );
}
