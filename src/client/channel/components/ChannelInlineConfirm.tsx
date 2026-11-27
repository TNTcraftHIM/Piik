import { useId, useLayoutEffect, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";

export function ChannelInlineConfirm({ label, accessibleLabel = label, question, size = "compact",
  danger = true, disabled, busy, onConfirm }: {
  label: string; accessibleLabel?: string; question: string; size?: "compact" | "dense";
  danger?: boolean; disabled?: boolean; busy?: boolean; onConfirm(): void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const cancel = () => {
    returnFocus.current = true;
    setOpen(false);
  };
  useLayoutEffect(() => {
    if (open) {
      container.current?.scrollIntoView({ block: "nearest" });
      container.current?.querySelector("button")?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      returnFocus.current = false;
      container.current?.querySelector("button")?.focus();
    }
  }, [open]);
  return <div ref={container} tabIndex={-1} className="c3-inline-confirm" onKeyDown={event => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }}>
    {open ? <div className="c3-backup-confirm c3-inline-confirm-panel" role="group" aria-labelledby={panelId}>
      <p id={panelId}>{question}</p>
      <div className="c3-form-actions">
        <Btn icon="x" size="compact" quiet title="room.action.cancel" cap="room.action.cancel" onClick={cancel} />
        <Btn icon="x" size={size} quiet tone="danger" title={{ text: accessibleLabel }} cap={{ text: label }}
          disabled={disabled || busy} onClick={() => {
            container.current?.focus({ preventScroll: true });
            setOpen(false);
            onConfirm();
          }} />
      </div>
    </div> : <Btn icon="x" size={size} quiet tone={danger ? "danger" : undefined} title={{ text: accessibleLabel }}
      cap={{ text: label }} busy={busy} disabled={disabled || busy} onClick={() => setOpen(true)} />}
  </div>;
}
