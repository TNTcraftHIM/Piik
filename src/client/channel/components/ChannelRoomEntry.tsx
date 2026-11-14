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
  const { t } = useCopy();
  const [password, setPassword] = useState("");
  const pending = channel.pending.has(`enter:${roomId}`);
  return <form hidden={hidden} onSubmit={event => {
    event.preventDefault();
    if (!available || pending || !password) return;
    void channel.enterRoom(roomId, password).then(() => setPassword("")).catch(() => {});
  }}><input className="c3-input" type="password" maxLength={128} value={password} autoComplete="current-password"
    aria-label={t("room.entry.password")} disabled={!available || pending} onChange={event => setPassword(event.target.value)} />
    <ChannelAction icon="door" type="submit" primary label={t("room.entry.enter")}
      busy={pending} disabled={!password || !available} /></form>;
}

export function ChannelRoomEntry({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { t } = useCopy();
  return <section className="c3-locked-room"><Glyph name="lock" size={46} />
    <h3>{t("room.entry.privateTitle")}</h3>
    <p>{room.hasPassword ? t("room.entry.passwordNote")
      : t("room.entry.invitationNote")}</p>
    {room.hasPassword && <RoomPasswordForm channel={channel} roomId={room.id} available={channel.connection === "connected" && room.available} />}
  </section>;
}

/** An unlisted target discloses no room metadata before Core grants access. */
export function ChannelUnlistedRoomEntry({ channel, roomId, onBack }: {
  channel: ChannelController; roomId: string; onBack(): void;
}) {
  const { t } = useCopy();
  const pending = channel.pending.has(`enter:${roomId}`);
  return <section className="c3-locked-room"><Glyph name="lock" size={46} />
    <h3>{t("room.entry.open")}</h3>
    {pending ? <p role="status">{t("room.entry.opening")}</p>
      : <p>{t("room.entry.unlistedNote")}</p>}
    <RoomPasswordForm channel={channel} roomId={roomId} available={channel.connection === "connected"} hidden={pending} />
    <ChannelAction icon="arrowLeft" quiet label={t("room.entry.back")} onClick={onBack} />
  </section>;
}
