import { BackButton, Btn } from "../../components/living/primitives";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelUser as User } from "../protocol";
import { listeningVoicePublications, roomPeople, voiceAppearance, userProfile } from "../presentation";
import { ChannelUser } from "./ChannelUser";
import { useEffect, useRef, useState } from "react";

export function ChannelPeople({ channel, roomId, active, onBack }: { channel: ChannelController; roomId: string; active: boolean; onBack(): void }) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const { state, self } = channel;
  const [directory, setDirectory] = useState<{ ids: string[]; next: string | null }>({ ids: [], next: null });
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const load = async (after?: string) => {
    request.current?.abort();
    const current = request.current = new AbortController();
    setLoading(true); setFailed(false);
    try {
      const page = await channel.queryProfiles(after ? { after } : {}, current.signal);
      if (!current.signal.aborted) setDirectory(previous => ({ ids: [...new Set([...previous.ids, ...page.profiles.map(user => user.id)])], next: page.nextCursor }));
    } catch { if (!current.signal.aborted) setFailed(true); }
    finally { if (!current.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    setDirectory({ ids: active ? state?.users.map(user => user.id) ?? [] : [], next: null }); setLoading(false); setFailed(false);
    if (active && channel.connection === "connected") void load();
    return () => { request.current?.abort(); };
  }, [active, state?.channel.id, self?.id, channel.connection, retry]);
  useEffect(() => {
    if (active) setDirectory(previous => state?.users.every(user => previous.ids.includes(user.id)) ? previous
      : { ...previous, ids: [...new Set([...previous.ids, ...(state?.users.map(user => user.id) ?? [])])] });
  }, [active, state?.users]);
  const online = new Set(state?.sessions.filter(session => session.online).map(session => session.userId));
  const inRoom = new Set(state ? roomPeople(state, roomId).map(person => person.userId) : []);
  const groups: { label: string; users: User[] }[] = [
    { label: zh ? "当前房间" : "This room", users: [] },
    { label: zh ? "在线" : "Online", users: [] },
    { label: zh ? "离线" : "Offline", users: [] },
  ];
  const ids = new Set([...(state?.users.map(user => user.id) ?? []), ...directory.ids]);
  for (const id of ids) {
    const user = state && userProfile(state, channel.profiles, id);
    if (user) groups[inRoom.has(id) ? 0 : online.has(id) ? 1 : 2].users.push(user);
  }
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
    <header><h2 id="c3-people-heading" tabIndex={-1}>{zh ? "用户列表" : "Users"}<span>{state?.channel.userCount ?? 0}</span></h2>
      <span className="c3-pane-back"><BackButton onClick={onBack} /></span>
    </header>
    <div className="c3-people-body">
      {groups.filter(group => group.users.length).map(group => <section className="c3-people-group" key={group.label} aria-label={group.label}>
        <h3 className="c3-section-label">{group.label}<span>{group === groups[2] ? Math.max(0, (state?.channel.userCount ?? 0) - new Set([...inRoom, ...online]).size) : group.users.length}</span></h3>
        <div className="c3-users">{group.users.map(row)}</div>
      </section>)}
      {loading && <p role="status">{zh ? "正在加载用户…" : "Loading people…"}</p>}
      {failed && <p role="status">{zh ? "未能加载用户，请重试。" : "Couldn't load people. Try again."}</p>}
      {(failed || directory.next) && <Btn icon={failed ? "refresh" : "arrowDown"} quiet size="compact" busy={loading}
        title={{ text: failed ? (zh ? "重试" : "Retry") : (zh ? "更多用户" : "More people") }}
        cap={{ text: failed ? (zh ? "重试" : "Retry") : (zh ? "更多用户" : "More people") }}
        onClick={() => { if (directory.ids.length) void load(directory.next ?? undefined); else setRetry(value => value + 1); }} />}
    </div>
  </aside>;
}
