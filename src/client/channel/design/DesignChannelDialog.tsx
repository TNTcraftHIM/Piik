import { useEffect, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignIdentityMark, DesignIdentityPicker, type DesignIdentity } from "./DesignIdentityPicker";
import type { DesignCopy } from "./fixtures";

export function DesignChannelDialog({ copy, name, identity, onClose, onSave }: {
  copy: DesignCopy; name: string; identity: DesignIdentity; onClose(): void; onSave(name: string, identity: DesignIdentity): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(identity);
  const [draftName, setDraftName] = useState(name);
  const [imageBusy, setImageBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    if (!element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className="cd-create-dialog" aria-labelledby="cd-channel-edit-title" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!draftName.trim() || imageBusy) return;
      dialog.current?.close();
      onSave(draftName.trim(), draft);
    }}>
      <header className="cd-create-heading"><span className="cd-room-emblem"><DesignIdentityMark value={draft} size={38} /></span>
        <Btn icon="x" title="common.close" hint="hint-close" size="compact" quiet onClick={() => dialog.current?.close()} />
      </header>
      <h2 id="cd-channel-edit-title">{copy("域外观", "Domain appearance")}</h2>
      <p className="cd-create-intro">{copy("给朋友们一个一眼就能认出的地方。", "A familiar face for your favourite place.")}</p>
      <label className="cd-field"><span>{copy("域名称", "Domain name")}</span><span className="lr-input"><input name="channel-name" value={draftName} onChange={event => setDraftName(event.currentTarget.value)} autoComplete="off" autoFocus required /></span></label>
      <DesignIdentityPicker value={draft} onChange={setDraft} busy={imageBusy} onBusyChange={setImageBusy} />
      <footer><Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" quiet onClick={() => dialog.current?.close()} />
        <ChannelAction type="submit" primary icon="check" disabled={!draftName.trim() || imageBusy} label={copy("保存", "Save")} /></footer>
    </form>
  </dialog>;
}
