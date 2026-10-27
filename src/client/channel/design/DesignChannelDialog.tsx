import { useEffect, useRef, useState } from "react";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignIdentityMark, DesignIdentityPicker, type DesignIdentity } from "./DesignIdentityPicker";
import type { DesignCopy } from "./fixtures";

export function DesignChannelDialog({ copy, name, identity, onClose, onSave }: {
  copy: DesignCopy; name: string; identity: DesignIdentity; onClose(): void; onSave(name: string, identity: DesignIdentity): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(identity);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="cd-create-dialog" aria-labelledby="cd-channel-edit-title" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get("channel-name")).trim();
      if (value) onSave(value, draft);
    }}>
      <header className="cd-create-heading"><span className="cd-room-emblem"><DesignIdentityMark value={draft} size={38} /></span>
        <ChannelAction icon="x" label={copy("关闭", "Close")} hint="hint-close" quiet iconOnly onClick={() => dialog.current?.close()} />
      </header>
      <h2 id="cd-channel-edit-title">{copy("频道外观", "Channel appearance")}</h2>
      <p className="cd-create-intro">{copy("给朋友们一个一眼就能认出的地方。", "A familiar face for your favourite place.")}</p>
      <label className="cd-field"><span>{copy("频道名称", "Channel name")}</span><input name="channel-name" defaultValue={name} autoFocus required maxLength={60} /></label>
      <DesignIdentityPicker copy={copy} value={draft} onChange={setDraft} />
      <footer><button type="button" className="lr-btn is-compact is-quiet" onClick={() => dialog.current?.close()}>{copy("取消", "Cancel")}</button>
        <ChannelAction type="submit" primary icon="check" label={copy("保存", "Save")} /></footer>
    </form>
  </dialog>;
}
