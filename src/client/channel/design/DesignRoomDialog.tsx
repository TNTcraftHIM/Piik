import { useEffect, useRef, useState } from "react";
import { Glyph } from "../../ui/icons";
import { SwitchItem } from "../../components/living/primitives";
import { ChannelAction } from "../components/ChannelMedia";
import type { DesignCopy, DesignRoom } from "./fixtures";

export function DesignRoomDialog({ copy, onClose, onCreate }: {
  copy: DesignCopy; onClose(): void; onCreate(room: DesignRoom): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [privateRoom, setPrivateRoom] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    if (!element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className="cd-create-dialog" aria-labelledby="cd-create-title" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      const name = String(new FormData(event.currentTarget).get("room-name") ?? "").trim();
      if (!name) return;
      onCreate({ id: "design-room-" + Date.now(), name, icon: privateRoom ? "lock" : "couch", private: privateRoom, hidden: privateRoom && hidden });
    }}>
      <header className="cd-create-heading">
        <div className="cd-room-emblem"><Glyph name="couch" size={30} /></div>
        <ChannelAction icon="x" label={copy("关闭", "Close")} hint="hint-close" quiet iconOnly onClick={() => dialog.current?.close()} />
      </header>
      <h2 id="cd-create-title">{copy("创建房间", "Create a room")}</h2>
      <p className="cd-create-intro">{copy("聊天、语音和屏幕分享，都在同一个房间。", "A place for conversation, voice and shared screens.")}</p>
      <label className="cd-field">
        <span>{copy("房间名称", "Room name")}</span>
        <input name="room-name" autoComplete="off" autoFocus required maxLength={60} placeholder={copy("比如，周末联机…", "Maybe, Weekend party…")} />
      </label>
      <fieldset className="cd-access-field">
        <legend>{copy("谁可以进入", "Who can join")}</legend>
        <div className="lr-toggle cd-access-track">
          <label><input type="radio" name="room-access" value="open" checked={!privateRoom} onChange={() => setPrivateRoom(false)} />
            <span><Glyph name="couch" size={19} />{copy("公开", "Open")}</span></label>
          <label><input type="radio" name="room-access" value="private" checked={privateRoom} onChange={() => setPrivateRoom(true)} />
            <span><Glyph name="lock" size={18} />{copy("私密", "Private")}</span></label>
        </div>
        <p>{privateRoom ? copy("需要房间邀请或密码，才可以进入。", "Join with a room invitation or password.")
          : copy("频道里的朋友都可以进来。", "Anyone in the channel can come in.")}</p>
      </fieldset>
      {privateRoom && <section className="cd-private-fields" aria-label={copy("私密房间设置", "Private room settings")}>
        <label className="cd-field"><span>{copy("房间密码", "Room password")}<small>{copy("可选", "Optional")}</small></span>
          <input name="room-password" type="password" autoComplete="new-password" placeholder={copy("留空，仅凭邀请进入…", "Leave empty for invite-only access…")} /></label>
        <div className="cd-hide-setting">
          <SwitchItem checked={hidden} onChange={setHidden} label={copy("隐藏这个房间", "Hide this room")} icon="eyeOff" />
          <p>{copy("只让获准的朋友在列表中看到。", "Only admitted friends see it in the room list.")}</p>
        </div>
      </section>}
      <footer>
        <button type="button" className="lr-btn is-compact is-quiet" onClick={() => dialog.current?.close()}>{copy("取消", "Cancel")}</button>
        <ChannelAction type="submit" icon="plus" primary label={copy("创建房间", "Create room")} />
      </footer>
    </form>
  </dialog>;
}
