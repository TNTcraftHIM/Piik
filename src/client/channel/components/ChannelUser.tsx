import type { ReactNode } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";

export function ChannelUser({ id, name, avatar, self, owner, online, voice, activity, actions }: {
  id: string; name: string; self: boolean; owner: boolean; online: boolean;
  voice?: { microphone: boolean; deafened?: boolean }; activity?: string;
  avatar?: string; actions?: ReactNode;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  return <div className={`c3-user${online ? "" : " is-offline"}`} data-user-id={id}>
    <div className="c3-person">
      <PawnSvg color={participantColor(id)} identity={id} avatar={avatar} host={owner} voice={voice} />
      <div className="c3-person-copy">
        <strong>{name}{self && <span className="c3-you">{zh ? "你" : "you"}</span>}</strong>
        {(activity || owner) && <small>{activity || (zh ? "房主" : "Room owner")}</small>}
      </div>
      {actions && <div className="c3-person-actions">{actions}</div>}
    </div>
  </div>;
}
