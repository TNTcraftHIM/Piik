import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { Btn } from "../../components/living/primitives";
import { listeningVoicePublications, voiceAppearance } from "../presentation";
import type { ChannelController } from "../types";
import type { ChannelRoom } from "../protocol";
import { ChannelUser } from "./ChannelUser";

/** The room's voice membership is separate from browsing and picture subscriptions. */
export function ChannelRoomVoiceMembers({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { state } = channel;
  if (!state || !room.authorized) return null;
  const audible = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams)
    .filter(source => source.roomId === room.id).map(source => source.userId));
  return <div className="c3-room-voice-members">{state.users.map(user => {
    const voice = voiceAppearance(state, user.id, room.id);
    if (!voice) return null;
    const playback = channel.voicePlaybackByUser.get(user.id) ?? { volume: 1, muted: false };
    return <ChannelUser key={user.id} id={user.id} name={user.name} self={user.id === channel.self?.id}
      owner={false} online voice={voice} actions={audible.has(user.id) && user.id !== channel.self?.id &&
        <AudioVolumeMenu volume={playback.volume} onVolume={volume => channel.setVoiceVolume(user.id, volume)}
          label="voice.personVolume" icon="speaker" heading={user.name}>
          <Btn icon={playback.muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
            pressed={!playback.muted} onClick={() => channel.setVoiceMuted(user.id, !playback.muted)} />
        </AudioVolumeMenu>} />;
  })}</div>;
}
