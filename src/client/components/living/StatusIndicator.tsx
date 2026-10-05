import type { StatusDescriptor } from "../../ui/media-status";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import "./status-indicator.css";

/** One icon for one status; text and visual hints explain the same fact. */
export function StatusIndicator({ status, label, onActivate }: {
  status: StatusDescriptor;
  label?: string;
  onActivate?: () => void;
}) {
  const { vis, t } = useCopy();
  const hint = (status.tooltip ?? status.comic)!;
  const text = label ?? t(status.labelKey);
  const description = onActivate ? `${text} · ${t("shareHelp.open")}` : text;
  const indicator = (
    <button
      type="button"
      className="lr-status-indicator"
      data-tone={status.tone}
      data-pulse={status.pulse || undefined}
      aria-label={description}
      aria-haspopup={onActivate ? "dialog" : undefined}
      onClick={onActivate}
    >
      <Glyph name={status.icon} size={17} />
    </button>
  );
  return <Tooltip toggleOnClick={!onActivate} kind={hint} tone={status.tone} motion={status.pulse ? "progress" : "still"}
    text={vis ? undefined : description}>{indicator}</Tooltip>;
}
