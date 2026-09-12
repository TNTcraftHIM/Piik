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
  const wrapped = !vis || Boolean(hint);
  const Trigger = wrapped ? "button" : "span";
  const indicator = (
    <Trigger
      type={wrapped ? "button" : undefined}
      className="lr-status-indicator"
      data-tone={status.tone}
      data-pulse={status.pulse || undefined}
      role={wrapped ? undefined : "img"}
      aria-label={text}
    >
      <Glyph name={status.icon} size={17} />
    </Trigger>
  );
  return wrapped
    ? <Tooltip toggleOnClick kind={hint} tone={status.tone} motion={status.pulse ? "progress" : undefined}
        text={vis ? undefined : text}>{indicator}</Tooltip>
    : indicator;
}
