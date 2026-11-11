import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Cap } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import type { HintKind } from "../../components/living/hints";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useSurfaceDocument } from "../../ui/panel-window";
import { navigateTabs } from "../../ui/tab-navigation";
import { ChannelAction } from "./ChannelAction";
import { channelErrorPresentation } from "../error-presentation";
import "./channel-settings-dialog.css";

/** Task contents keep their own state; the native modal owns focus and dismissal. */
export function ChannelSettingsDialog({ title, caption, compact = false, error = null, className = "", dismissOnBackdrop = false, onClose, children }: {
  title: string; caption?: string; compact?: boolean; error?: string | null; className?: string; dismissOnBackdrop?: boolean; onClose(): void; children: ReactNode;
}) {
  const ownerDocument = useSurfaceDocument();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef<number | null>(null);
  const titleId = useId();
  const { lang } = useCopy();
  const outside = (event: PointerEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, [ownerDocument]);
  return ownerDocument && createPortal(<dialog ref={dialog} className={`c3-settings-dialog ${className}`} data-compact={compact || undefined}
    closedby={dismissOnBackdrop ? "any" : "closerequest"}
    aria-labelledby={titleId} onClose={event => { if (!event.currentTarget.open) onClose(); }}
    onPointerDown={event => { backdropPointer.current = dismissOnBackdrop && !("closedBy" in event.currentTarget) && outside(event) ? event.pointerId : null; }}
    onPointerUp={event => {
      if (backdropPointer.current === event.pointerId && outside(event)) event.currentTarget.close();
      backdropPointer.current = null;
    }} onPointerCancel={() => { backdropPointer.current = null; }}>
    <header className="c3-settings-dialog-heading">
      {/* Start at the heading so automatic focus does not open an action's tooltip. */}
      <div>{caption && <p>{caption}</p>}<h2 id={titleId} tabIndex={-1}
        ref={element => { element?.setAttribute("autofocus", ""); }}>{title}</h2></div>
      <ChannelAction icon="x" iconOnly quiet textTooltip label={lang === "zh" ? "关闭" : "Close"}
        onClick={() => dialog.current?.close()} />
    </header>
    <div className="c3-settings-content">{children}</div>
    <ChannelSettingsError error={error} />
  </dialog>, ownerDocument.body);
}

export function ChannelSettingsTabs<T extends string>({ id, label, tasks, selected, onSelect }: {
  id: string; label: string; tasks: readonly { value: T; label: string; icon: GlyphName; hint: HintKind }[];
  selected: T; onSelect(value: T): void;
}) {
  const { vis } = useCopy();
  return <div className="c3-settings-navigation"><nav className="lr-toggle c3-settings-nav" role="tablist"
    style={{ "--lr-segments": tasks.length } as CSSProperties} aria-label={label} onKeyDown={navigateTabs}>
    {tasks.map(task => <Tooltip key={task.value} kind={task.hint} text={vis ? undefined : task.label}>
      <button type="button" role="tab" className={selected === task.value ? "is-selected" : undefined}
        id={`${id}-${task.value}-tab`} aria-label={task.label} aria-selected={selected === task.value}
        aria-controls={`${id}-${task.value}`} tabIndex={selected === task.value ? 0 : -1} onClick={() => onSelect(task.value)}>
        <Glyph name={task.icon} size={18} /><Cap k={{ text: task.label }} />
      </button>
    </Tooltip>)}
  </nav></div>;
}

/** The action owner supplies its failure; error copy stays shared with the page. */
function ChannelSettingsError({ error }: { error: string | null }) {
  const { lang } = useCopy();
  const { message } = channelErrorPresentation(error, (zh, en) => lang === "zh" ? zh : en);
  return message && <p className="c3-settings-error" role="alert">{message}</p>;
}

export type SettingsAction = <T>(work: () => Promise<T>, onSuccess?: (value: T) => void) => Promise<void>;

/** Pending stays in Session; only this open surface receives its action result. */
export function useSettingsAction(open = true): { error: string | null; run: SettingsAction } {
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<object | null>(null);
  useLayoutEffect(() => {
    lifetime.current = open ? {} : null;
    setError(null);
    return () => { lifetime.current = null; };
  }, [open]);
  const run: SettingsAction = useCallback(async (work, onSuccess) => {
    const current = lifetime.current;
    if (!current) return;
    setError(null);
    try {
      const result = await work();
      if (lifetime.current === current) onSuccess?.(result);
    } catch (error) {
      if (lifetime.current === current && !(error instanceof DOMException && error.name === "AbortError"))
        setError(error instanceof Error ? error.message : "operation_failed");
    }
  }, []);
  return { error, run };
}
