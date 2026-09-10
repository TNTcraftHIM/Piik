import type { StatusDescriptor } from "../../ui/media-status";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import "./status-indicator.css";

/** One icon for one status; text and visual hints explain the same fact. */
export function StatusIndicator({ status, label }: {
  status: StatusDescriptor;
  label?: string;
}) {
  const { vis, t } = useCopy();
  const hint = status.tooltip ?? status.comic;
  const text = label ?? t(status.labelKey);
  const indicator = (
    <span
      className="lr-status-indicator"
      data-tone={status.tone}
      data-pulse={status.pulse || undefined}
      role="img"
      aria-label={text}
      tabIndex={!vis || hint ? 0 : undefined}
    >
      <Glyph name={status.icon} size={17} />
    </span>
  );
  return !vis || hint
    ? <Tooltip kind={hint} tone={status.tone} motion={status.pulse ? "progress" : undefined}
        text={vis ? undefined : text}>{indicator}</Tooltip>
    : indicator;
}
