import { useEffect, useState } from "react";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { PawnSvg, type PawnVoice } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { Btn } from "../../components/living/primitives";
import { joinSentences, useCopy, type Copy } from "../../ui/copy";
import { ChannelImageDialog } from "./ChannelImageDialog";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph, type GlyphName } from "../../ui/icons";
import { participantViewingLabel, viewingAppearance, type ParticipantActivity, type ParticipantViewing } from "../presentation";
import type { ChannelController } from "../types";
import "./channel-activity-indicators.css";

type PersonActivity = Partial<ParticipantActivity> & { voice?: PawnVoice };
type VoicePlaybackControls = Pick<ChannelController, "voicePlaybackByUser" | "setVoiceVolume" | "setVoiceMuted">;

const fileBadges = {
  sending: { icon: "fileUp", label: "channel.roomParticipants.sendingFiles" },
  receiving: { icon: "fileDown", label: "channel.roomParticipants.receivingFiles" },
  both: { icon: "fileTransfer", label: "channel.roomParticipants.sendingAndReceivingFiles" },
} as const;

export function personVoiceLabel(voice: PawnVoice, { t, lang }: Copy) {
  const parts = [t("voice.details.joined"), t(voice.microphone ? "voice.microphoneActive" : "voice.microphoneInactive")];
  if (voice.deafened) parts.push(t("voice.listeningPaused"));
  return joinSentences(lang, parts);
}

function ActivityBadge({ icon, label, viewing }: { icon: GlyphName; label: string; viewing?: ParticipantViewing }) {
  return <Tooltip text={label}><span role="img" aria-label={label} data-viewing={viewing}>
    <Glyph name={icon} size={14} />
  </span></Tooltip>;
}

export function ChannelActivityIndicators({ voice, sharing, viewing, sendingFiles, receivingFiles }: PersonActivity) {
  const copy = useCopy();
  const { t } = copy;
  const file = sendingFiles && receivingFiles ? fileBadges.both : sendingFiles ? fileBadges.sending : receivingFiles ? fileBadges.receiving : undefined;
  if (!voice && !sharing && !viewing && !file) return null;
  return <span className="c3-participant-activity">
    {voice && <ActivityBadge icon={voice.deafened ? "headphonesOff" : voice.microphone ? "microphone" : "microphoneOff"}
      label={personVoiceLabel(voice, copy)} />}
    {sharing && <ActivityBadge icon="cast" label={t("channel.roomParticipants.sharing")} />}
    {viewing && <ActivityBadge icon={viewingAppearance[viewing].icon} label={participantViewingLabel(viewing, t)} viewing={viewing} />}
    {file && <ActivityBadge icon={file.icon} label={t(file.label)} />}
  </span>;
}

export function ChannelUser({ id, name, avatar, self, owner, online, roomActivity, collaboration, activity, voicePlayback, onPreviewAvatar }: {
  id: string; name: string; self: boolean; owner: boolean; online: boolean;
  roomActivity?: PersonActivity; activity?: string; collaboration?: boolean;
  avatar?: string; voicePlayback?: VoicePlaybackControls; onPreviewAvatar?: () => void;
}) {
  const { t } = useCopy();
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (!avatar) setPreview(false); }, [avatar]);
  const previewLabel = t("channel.user.viewAvatar", { name });
  const listen = self ? undefined : voicePlayback;
  const { volume, muted } = listen?.voicePlaybackByUser.get(id) ?? { volume: 1, muted: false };
  const pawn = <PawnSvg color={participantColor(id)} identity={id} avatar={avatar} host={owner} voice={roomActivity?.voice} collaboration={collaboration} />;
  return <div className={`c3-user${online ? "" : " is-offline"}`} data-user-id={id}>
    <div className="c3-person">
      {avatar ? <Tooltip text={previewLabel}><button type="button" className="c3-avatar-preview" aria-haspopup="dialog"
        aria-label={previewLabel} onClick={() => onPreviewAvatar ? onPreviewAvatar() : setPreview(true)}>{pawn}</button></Tooltip> : pawn}
      <div className="c3-person-copy">
        <strong>{name}{self && <span className="c3-you">{t("channel.user.you")}</span>}</strong>
        {(activity || owner) && <small>{activity || t("channel.user.roomOwner")}</small>}
      </div>
      {(roomActivity || listen) && <div className="c3-person-actions">
        {roomActivity && <ChannelActivityIndicators {...roomActivity} />}
        {listen && <AudioVolumeMenu volume={volume} onVolume={value => listen.setVoiceVolume(id, value)} label="voice.personVolume" heading={name}>
          <Btn icon={muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
            pressed={!muted} onClick={() => listen.setVoiceMuted(id, !muted)} />
        </AudioVolumeMenu>}
      </div>}
    </div>
    {preview && avatar && <ChannelImageDialog src={avatar} name={t("channel.user.avatar", { name })} onClose={() => setPreview(false)} />}
  </div>;
}
