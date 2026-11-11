import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Btn } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import "./channel-source-options.css";

/** Native nested popovers keep their invoking controls and drafts in this tree. */
export function ChannelSourceOptions({ label, disabled = false, children }: {
  label: string; disabled?: boolean; children: ReactNode;
}) {
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel, { maxHeight: 480, minVisibleHeight: 160 });
  useLayoutEffect(() => {
    if (disabled) panel.current?.hidePopover();
  }, [disabled]);
  return <>
    <span ref={trigger} className="c3-source-options-trigger">
      <Btn icon="more" size="dense" quiet title={{ text: label }} hint="hint-advanced"
        popoverTarget={id} controls={id} expanded={open} disabled={disabled} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`}
      className="lr-anchored-card c3-source-options" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <h3 id={`${id}-title`}>{label}</h3>
      <div className="c3-source-options-controls">{children}</div>
    </div>
  </>;
}
