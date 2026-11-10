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
  const inRoom = new Set(state ? roomPeople(state, roomId).map(person => person.userId) : []);
  const groups: { label: string; users: User[] }[] = [
    { label: zh ? "此房间内" : "In this room", users: [] },
    { label: zh ? "其他在线用户" : "Other online", users: [] },
    { label: zh ? "离线" : "Offline", users: [] },
  ];
  for (const user of state?.users ?? []) groups[inRoom.has(user.id) ? 0 : online.has(user.id) ? 1 : 2].users.push(user);
  const listeningUsers = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams).map(publication => publication.userId));
  const row = (user: User) => {
    const connected = online.has(user.id);
    const sharing = connected && inRoom.has(user.id) && state?.publications.some(publication => publication.userId === user.id && publication.kind === "screen" && publication.roomId === roomId);
    const voice = state && inRoom.has(user.id) ? voiceAppearance(state, user.id, roomId) : undefined;
    const playback = channel.voicePlaybackByUser.get(user.id) ?? { volume: 1, muted: false };
    return <ChannelUser key={user.id} id={user.id} name={user.name} avatar={user.avatar ?? undefined} self={user.id === self?.id}
      owner={user.id === state?.channel.rooms.find(room => room.id === roomId)?.creatorId} online={connected}
      voice={voice}
      actions={connected && listeningUsers.has(user.id) && user.id !== self?.id && <AudioVolumeMenu volume={playback.volume}
        onVolume={volume => channel.setVoiceVolume(user.id, volume)} label="voice.personVolume" icon="speaker" heading={user.name}>
        <Btn icon={playback.muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
          pressed={!playback.muted} onClick={() => channel.setVoiceMuted(user.id, !playback.muted)} />
      </AudioVolumeMenu>}
      activity={sharing ? (zh ? "正在分享画面" : "Sharing a screen") : undefined} />;
  };
  return <aside id="c3-people" className="c3-people-panel" aria-labelledby="c3-people-heading">
    <header><h2 id="c3-people-heading" tabIndex={-1}>{zh ? "站点用户" : "People on this site"}<span>{state?.users.length ?? 0}</span></h2>
      <span className="c3-pane-back"><BackButton onClick={onBack} /></span>
    </header>
    <div className="c3-people-body">
      {groups.filter(group => group.users.length).map(group => <section className="c3-people-group" key={group.label} aria-label={group.label}>
        <h3 className="c3-section-label">{group.label}<span>{group.users.length}</span></h3>
        <div className="c3-users">{group.users.map(row)}</div>
      </section>)}
    </div>
  </aside>;
}
