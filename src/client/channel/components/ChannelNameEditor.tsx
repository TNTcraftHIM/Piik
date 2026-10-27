import { useEffect, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelMedia";

export function ChannelNameEditor({ name, disabled, onSave }: {
  name: string; disabled: boolean; onSave: (name: string) => void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { setEditing(false); setDraft(name); }, [name]);
  return editing ? <form className="c3-name-form" onSubmit={event => {
    event.preventDefault();
    if (draft.trim() && !disabled) onSave(draft.trim());
    if (draft.trim() === name) setEditing(false);
  }}>
    <input className="c3-input" autoFocus maxLength={40} aria-label={zh ? "你的名字" : "Your name"}
      value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled}
      onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) setEditing(false); }} />
    <ChannelAction icon="check" type="submit" label={zh ? "保存名字" : "Save name"}
      disabled={disabled || !draft.trim()} />
    <Btn icon="x" size="compact" title="common.cancel" onClick={() => setEditing(false)} />
  </form> : <Btn icon="pencil" title="common.edit" hint="hint-rename" size="compact" quiet
    disabled={disabled} onClick={() => { setDraft(name); setEditing(true); }} />;
}
