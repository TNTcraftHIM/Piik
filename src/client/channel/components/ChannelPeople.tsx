import { BackButton, Btn } from "../../components/living/primitives";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelUser as User } from "../protocol";
import { listeningVoicePublications, roomPeople, voiceAppearance } from "../presentation";
import { ChannelUser } from "./ChannelUser";

export function ChannelPeople({ channel, roomId, onBack }: { channel: ChannelController; roomId: string; onBack(): void }) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const { state, self } = channel;
  const online = new Set(state?.sessions.filter(session => session.online).map(session => session.userId));
  const listeningUsers = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams).map(publication => publication.userId));
  const row = (user: User) => {
    const sharing = state?.publications.some(publication => publication.userId === user.id && publication.kind === "screen" && publication.roomId === roomId);
    const voice = state ? voiceAppearance(state, user.id, roomId) : undefined;
    const playback = channel.voicePlaybackByUser.get(user.id) ?? { volume: 1, muted: false };
    return <ChannelUser key={user.id} id={user.id} name={user.name} self={user.id === self?.id}
      owner={user.id === state?.channel.rooms.find(room => room.id === roomId)?.creatorId} online={online.has(user.id)}
      voice={voice}
      actions={listeningUsers.has(user.id) && user.id !== self?.id && <AudioVolumeMenu volume={playback.volume}
        onVolume={volume => channel.setVoiceVolume(user.id, volume)} label="voice.personVolume" icon="speaker" heading={user.name}>
        <Btn icon={playback.muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
          pressed={!playback.muted} onClick={() => channel.setVoiceMuted(user.id, !playback.muted)} />
      </AudioVolumeMenu>}
      activity={sharing ? (zh ? "正在分享画面" : "Sharing a screen") : undefined} />;
  };
  const inRoom = new Set(state ? roomPeople(state, roomId).map(person => person.userId) : []);
  const users = state?.users.filter(user => inRoom.has(user.id)) ?? [];
  const offline = users.filter(user => !online.has(user.id));
  return <aside id="c3-people" className="c3-people-panel" aria-labelledby="c3-people-heading">
    <header><h2 id="c3-people-heading" tabIndex={-1}>{zh ? "房间里的朋友" : "Friends in this room"}<span>{users.length}</span></h2>
      <span className="c3-pane-back"><BackButton onClick={onBack} /></span>
    </header>
    <div className="c3-people-body">
      <div className="c3-users">{users.filter(user => online.has(user.id)).map(row)}</div>
      {offline.length > 0 && <details className="c3-offline-users"><summary>{zh ? `离线 ${offline.length}` : `Offline ${offline.length}`}</summary>
        <div className="c3-users">{offline.map(row)}</div>
      </details>}
    </div>
  </aside>;
}
