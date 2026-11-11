import { useState, type ReactNode } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";
import { ChannelImageDialog } from "./ChannelImageDialog";

export function ChannelUser({ id, name, avatar, self, owner, online, voice, activity, actions }: {
  id: string; name: string; self: boolean; owner: boolean; online: boolean;
  voice?: { microphone: boolean; deafened?: boolean }; activity?: string;
  avatar?: string; actions?: ReactNode;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [preview, setPreview] = useState(false);
  const pawn = <PawnSvg color={participantColor(id)} identity={id} avatar={avatar} host={owner} voice={voice} />;
  return <div className={`c3-user${online ? "" : " is-offline"}`} data-user-id={id}>
    <div className="c3-person">
      {avatar ? <button type="button" className="c3-avatar-preview" aria-haspopup="dialog"
        aria-label={zh ? `查看 ${name} 的头像` : `View ${name}'s avatar`} onClick={() => setPreview(true)}>{pawn}</button> : pawn}
      <div className="c3-person-copy">
        <strong>{name}{self && <span className="c3-you">{zh ? "你" : "you"}</span>}</strong>
        {(activity || owner) && <small>{activity || (zh ? "房主" : "Room owner")}</small>}
      </div>
      {actions && <div className="c3-person-actions">{actions}</div>}
    </div>
    {preview && avatar && <ChannelImageDialog src={avatar} name={zh ? `${name} 的头像` : `${name}'s avatar`} onClose={() => setPreview(false)} />}
  </div>;
}
