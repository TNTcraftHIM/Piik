import { useEffect, useId, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import "./channel-name-editor.css";

export function ChannelNameEditor({ name, disabled, onSave }: {
  name: string; disabled: boolean; onSave: (name: string) => void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useAnchoredPopover(trigger, panel, { side: "above" });
  useEffect(() => { panel.current?.hidePopover(); setDraft(name); }, [name]);
  return <>
    <span ref={trigger} className="c3-name-editor">
      <Btn icon="pencil" title="common.edit" hint="hint-rename" size="compact" quiet
        disabled={disabled} popoverTarget={id} controls={id} expanded={editing} onClick={() => setDraft(name)} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={zh ? "你的名字" : "Your name"}
      className="lr-anchored-card c3-name-popover" onToggle={event => {
        const open = event.newState === "open";
        setEditing(open);
        if (open) { input.current?.focus({ preventScroll: true }); input.current?.select(); }
      }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!draft.trim() || disabled) return;
        onSave(draft.trim());
        if (draft.trim() === name) panel.current?.hidePopover();
      }}>
        <label><span>{zh ? "你的名字" : "Your name"}</span>
          <span className="lr-input"><input ref={input} maxLength={40} autoComplete="off"
            value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled}
            onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
          </span>
        </label>
        <footer>
          <Btn icon="x" size="compact" quiet title="common.cancel" cap="common.cancel" onClick={() => panel.current?.hidePopover()} />
          <Btn icon="check" type="submit" size="compact" tone="primary" title={{ text: zh ? "保存" : "Save" }} cap={{ text: zh ? "保存" : "Save" }}
            disabled={disabled || !draft.trim()} />
        </footer>
      </form>
    </div>
  </>;
}
