import { useState } from "react";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelRoom } from "../protocol";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelAction";
import "./channel-room-controls.css";

function RoomPasswordForm({ channel, roomId, available, hidden = false }: {
  channel: ChannelController; roomId: string; available: boolean; hidden?: boolean;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const [password, setPassword] = useState("");
  const pending = channel.pending.has(`enter:${roomId}`);
  return <form hidden={hidden} onSubmit={event => {
    event.preventDefault();
    if (!available || pending || !password) return;
    void channel.enterRoom(roomId, password).then(() => setPassword("")).catch(() => {});
  }}><input className="c3-input" type="password" maxLength={128} value={password} autoComplete="current-password"
    aria-label={zh ? "房间密码" : "Room password"} disabled={!available || pending} onChange={event => setPassword(event.target.value)} />
    <ChannelAction icon="door" type="submit" primary label={zh ? "进入房间" : "Enter room"}
      busy={pending} disabled={!password || !available} /></form>;
}

export function ChannelRoomEntry({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { lang } = useCopy(), zh = lang === "zh";
  return <section className="c3-locked-room"><Glyph name="lock" size={46} />
    <h3>{zh ? "这是一间私密房间" : "This room is private"}</h3>
    <p>{room.hasPassword ? (zh ? "输入房间密码，或使用房间邀请链接。" : "Enter its password or open a room invitation.")
      : (zh ? "请向房主索取邀请链接。" : "Ask the room owner for an invitation.")}</p>
    {room.hasPassword && <RoomPasswordForm channel={channel} roomId={room.id} available={channel.connection === "connected" && room.available} />}
  </section>;
}

/** An unlisted target discloses no room metadata before Core grants access. */
export function ChannelUnlistedRoomEntry({ channel, roomId, onBack }: {
  channel: ChannelController; roomId: string; onBack(): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const pending = channel.pending.has(`enter:${roomId}`);
  return <section className="c3-locked-room"><Glyph name="lock" size={46} />
    <h3>{zh ? "打开房间" : "Open room"}</h3>
    {pending ? <p role="status">{zh ? "正在打开房间…" : "Opening room…"}</p>
      : <p>{zh ? "输入房间密码，或向房主索取完整的免密邀请链接。" : "Enter the room password, or ask the owner for a complete password-free invitation."}</p>}
    <RoomPasswordForm channel={channel} roomId={roomId} available={channel.connection === "connected"} hidden={pending} />
    <ChannelAction icon="arrowLeft" quiet label={zh ? "返回房间总览" : "Back to rooms"} onClick={onBack} />
  </section>;
}
