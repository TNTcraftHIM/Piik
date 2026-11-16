import { useEffect, useState, type ReactNode } from "react";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";
import { ChannelImageDialog } from "./ChannelImageDialog";
import { Tooltip } from "../../components/living/Tooltip";

export function ChannelUser({ id, name, avatar, self, owner, online, voice, collaboration, activity, actions, onPreviewAvatar }: {
  id: string; name: string; self: boolean; owner: boolean; online: boolean;
  voice?: { microphone: boolean; deafened?: boolean }; activity?: string;
  collaboration?: boolean;
  avatar?: string; actions?: ReactNode; onPreviewAvatar?: () => void;
}) {
  const { t } = useCopy();
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (!avatar) setPreview(false); }, [avatar]);
  const previewLabel = t("channel.user.viewAvatar", { name });
  const pawn = <PawnSvg color={participantColor(id)} identity={id} avatar={avatar} host={owner} voice={voice} collaboration={collaboration} />;
  return <div className={`c3-user${online ? "" : " is-offline"}`} data-user-id={id}>
    <div className="c3-person">
      {avatar ? <Tooltip text={previewLabel}><button type="button" className="c3-avatar-preview" aria-haspopup="dialog"
        aria-label={previewLabel} onClick={() => onPreviewAvatar ? onPreviewAvatar() : setPreview(true)}>{pawn}</button></Tooltip> : pawn}
      <div className="c3-person-copy">
        <strong>{name}{self && <span className="c3-you">{t("channel.user.you")}</span>}</strong>
        {(activity || owner) && <small>{activity || t("channel.user.roomOwner")}</small>}
      </div>
      {actions && <div className="c3-person-actions">{actions}</div>}
    </div>
    {preview && avatar && <ChannelImageDialog src={avatar} name={t("channel.user.avatar", { name })} onClose={() => setPreview(false)} />}
  </div>;
}
