import { useEffect, useRef, useState } from "react";
import { Glyph } from "../../ui/icons";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { ChannelAction } from "../components/ChannelMedia";
import type { DesignCopy, DesignRoom } from "./fixtures";
import { DesignIdentityMark, DesignIdentityPicker, type DesignIdentity } from "./DesignIdentityPicker";

export function DesignRoomDialog({ copy, room, onClose, onSave }: {
  copy: DesignCopy; room?: DesignRoom; onClose(): void; onSave(room: DesignRoom): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(room?.name ?? "");
  const [imageBusy, setImageBusy] = useState(false);
  const [privateRoom, setPrivateRoom] = useState(room?.private ?? false);
  const [hidden, setHidden] = useState(room?.hidden ?? false);
  const [password, setPassword] = useState(room?.password ?? "");
  const [identity, setIdentity] = useState<DesignIdentity>({ icon: room?.icon ?? "couch" });
  useEffect(() => {
    const element = dialog.current!;
    if (!element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className="cd-create-dialog" aria-labelledby="cd-create-title" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!name.trim() || imageBusy) return;
      dialog.current?.close();
      onSave({ id: room?.id ?? "design-room-" + Date.now(), name: name.trim(), ...identity,
        private: privateRoom, hidden: privateRoom && hidden, password: privateRoom ? password || undefined : undefined });
    }}>
      <header className="cd-create-heading">
        <div className="cd-room-emblem"><DesignIdentityMark value={identity} size={30} /></div>
        <Btn icon="x" title="common.close" hint="hint-close" size="compact" quiet onClick={() => dialog.current?.close()} />
      </header>
      <h2 id="cd-create-title">{room ? copy("房间设置", "Room settings") : copy("创建房间", "Create a room")}</h2>
      <p className="cd-create-intro">{room ? copy("调整房间的名称、外观和访问方式。", "Give the room its name, look and access settings.")
        : copy("聊天、语音和屏幕分享，都在同一个房间。", "A place for conversation, voice and shared screens.")}</p>
      <label className="cd-field">
        <span>{copy("房间名称", "Room name")}</span>
        <span className="lr-input"><input name="room-name" value={name} onChange={event => setName(event.currentTarget.value)} autoComplete="off" autoFocus required maxLength={64} placeholder={copy("比如，周末联机…", "Maybe, Weekend party…")} /></span>
      </label>
      <DesignIdentityPicker value={identity} onChange={setIdentity} busy={imageBusy} onBusyChange={setImageBusy} />
      <fieldset className="cd-access-field">
        <legend>{copy("谁可以进入", "Who can join")}</legend>
        <div className="lr-toggle cd-access-track">
          <label><input type="radio" name="room-access" value="open" checked={!privateRoom} onChange={() => setPrivateRoom(false)} />
            <span><Glyph name="couch" size={19} />{copy("公开", "Open")}</span></label>
          <label><input type="radio" name="room-access" value="private" checked={privateRoom} onChange={() => setPrivateRoom(true)} />
            <span><Glyph name="lock" size={18} />{copy("私密", "Private")}</span></label>
        </div>
        <p>{privateRoom ? copy("需要房间邀请或密码，才可以进入。", "Join with a room invitation or password.")
          : copy("域内的用户都能进入。", "Anyone in this domain can enter.")}</p>
      </fieldset>
      {privateRoom && <section className="cd-private-fields" aria-label={copy("私密房间设置", "Private room settings")}>
        <label className="cd-field"><span>{copy("房间密码", "Room password")}<small>{copy("可选", "Optional")}</small></span>
          <span className="lr-input"><input name="room-password" type="password" autoComplete="new-password" maxLength={128}
            value={password} onChange={event => setPassword(event.currentTarget.value)} placeholder={copy("留空，仅凭邀请进入…", "Leave empty for invite-only access…")} /></span></label>
        <div className="cd-hide-setting">
          <SwitchItem checked={hidden} onChange={setHidden} label={copy("隐藏这个房间", "Hide this room")} icon="eyeOff" />
          <p>{copy("只让获准的朋友在列表中看到。", "Only admitted friends see it in the room list.")}</p>
        </div>
      </section>}
      <footer>
        <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" quiet onClick={() => dialog.current?.close()} />
        <ChannelAction type="submit" icon={room ? "check" : "plus"} primary disabled={!name.trim() || imageBusy}
          label={room ? copy("保存", "Save") : copy("创建房间", "Create room")} />
      </footer>
    </form>
  </dialog>;
}
