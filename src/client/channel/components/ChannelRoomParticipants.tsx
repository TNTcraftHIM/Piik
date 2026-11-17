import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { Btn } from "../../components/living/primitives";
import { listeningVoicePublications, participantViewingLabel, roomRealtimePeople, type ParticipantActivity } from "../presentation";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelUser } from "./ChannelUser";

export function ChannelActivityIndicators({ sharing, viewing }: Partial<ParticipantActivity>) {
  const { t } = useCopy();
  const label = viewing && participantViewingLabel(viewing, t);
  return <>
    {sharing && <Tooltip kind="hint-share-start" text={t("channel.roomParticipants.sharing")}><span role="img" aria-label={t("channel.roomParticipants.sharing")}><Glyph name="cast" size={14} /></span></Tooltip>}
    {viewing && label && <Tooltip text={label}><span role="img" aria-label={label} data-viewing={viewing}
      style={viewing === "failed" ? { color: "var(--danger)" } : undefined}><Glyph name={viewing === "active" ? "eye" : viewing === "preparing" ? "loader" : viewing === "failed" ? "alert" : "clapperboard"} size={14} /></span></Tooltip>}
  </>;
}

/** Real-time participants come from the room, not the browsed conversation. */
export function ChannelRoomParticipants({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { state } = channel;
  const { t } = useCopy();
  if (!state || !room.authorized) return null;
  const people = roomRealtimePeople(state, room.id, channel.profiles, channel);
  if (!people.length) return null;
  const audible = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams)
    .filter(source => source.roomId === room.id).map(source => source.userId));
  return <div className="c3-room-participants" role="group" aria-label={t("channel.roomParticipants.activity")}>
    <small className="c3-room-participants-label">{t("channel.roomParticipants.activity")}</small>{people.map(user => {
    const playback = channel.voicePlaybackByUser.get(user.id) ?? { volume: 1, muted: false };
    return <ChannelUser key={user.id} id={user.id} name={user.name} avatar={user.avatar ?? undefined} self={user.id === channel.self?.id}
      owner={false} online={state.sessions.some(session => session.userId === user.id && session.online)} voice={user.voice} actions={<>
        <ChannelActivityIndicators sharing={user.sharing} viewing={user.viewing} />
        {audible.has(user.id) && user.id !== channel.self?.id &&
        <AudioVolumeMenu volume={playback.volume} onVolume={volume => channel.setVoiceVolume(user.id, volume)}
          label="voice.personVolume" heading={user.name}>
          <Btn icon={playback.muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
            pressed={!playback.muted} onClick={() => channel.setVoiceMuted(user.id, !playback.muted)} />
        </AudioVolumeMenu>}</>} />;
  })}</div>;
}
