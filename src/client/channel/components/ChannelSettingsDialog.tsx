import { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Cap } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import type { HintKind } from "../../components/living/hints";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useSurfaceDocument } from "../../ui/panel-window";
import { navigateTabs } from "../../ui/tab-navigation";
import { ChannelAction } from "./ChannelAction";
import "./channel-settings-dialog.css";

/** Task contents keep their own state; the native modal owns focus and dismissal. */
export function ChannelSettingsDialog({ title, caption, compact = false, onClose, children }: {
  title: string; caption?: string; compact?: boolean; onClose(): void; children: ReactNode;
}) {
  const ownerDocument = useSurfaceDocument();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { lang } = useCopy();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, [ownerDocument]);
  return ownerDocument && createPortal(<dialog ref={dialog} className="c3-settings-dialog" data-compact={compact || undefined}
    aria-labelledby={titleId} onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <header className="c3-settings-dialog-heading">
      <div>{caption && <p>{caption}</p>}<h2 id={titleId}>{title}</h2></div>
      <ChannelAction icon="x" iconOnly quiet hint="hint-close" label={lang === "zh" ? "关闭" : "Close"}
        onClick={() => dialog.current?.close()} />
    </header>
    <div className="c3-settings-content">{children}</div>
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
