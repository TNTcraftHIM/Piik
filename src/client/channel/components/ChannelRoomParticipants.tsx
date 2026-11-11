import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { Btn } from "../../components/living/primitives";
import { listeningVoicePublications, roomRealtimePeople } from "../presentation";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelUser } from "./ChannelUser";

/** Real-time participants come from the room, not the browsed conversation. */
export function ChannelRoomParticipants({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { lang } = useCopy(), zh = lang === "zh";
  const { state } = channel;
  if (!state || !room.authorized) return null;
  const audible = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams)
    .filter(source => source.roomId === room.id).map(source => source.userId));
  return <div className="c3-room-participants">{roomRealtimePeople(state, room.id).map(user => {
    const playback = channel.voicePlaybackByUser.get(user.id) ?? { volume: 1, muted: false };
    return <ChannelUser key={user.id} id={user.id} name={user.name} avatar={user.avatar ?? undefined} self={user.id === channel.self?.id}
      owner={false} online voice={user.voice} actions={<>
        {user.sharing && <Tooltip kind="hint-share-start" text={zh ? "正在分享" : "Sharing"}><span role="img" aria-label={zh ? "正在分享" : "Sharing"}><Glyph name="cast" size={14} /></span></Tooltip>}
        {user.watching && <Tooltip kind="hint-watch" text={zh ? "正在观看" : "Watching"}><span role="img" aria-label={zh ? "正在观看" : "Watching"}><Glyph name="eye" size={14} /></span></Tooltip>}
        {audible.has(user.id) && user.id !== channel.self?.id &&
        <AudioVolumeMenu volume={playback.volume} onVolume={volume => channel.setVoiceVolume(user.id, volume)}
          label="voice.personVolume" icon="speaker" heading={user.name}>
          <Btn icon={playback.muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
            pressed={!playback.muted} onClick={() => channel.setVoiceMuted(user.id, !playback.muted)} />
        </AudioVolumeMenu>}</>} />;
  })}</div>;
}
