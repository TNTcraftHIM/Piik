import { BackButton, Btn } from "../../components/living/primitives";
import { AudioVolumeMenu } from "../../components/living/AudioVolumeMenu";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelUser as User } from "../protocol";
import { listeningVoicePublications, roomPeople, roomRealtimePeople, voiceAppearance, userProfile } from "../presentation";
import { ChannelActivityIndicators } from "./ChannelRoomParticipants";
import { ChannelUser } from "./ChannelUser";
import { useEffect, useRef, useState } from "react";

export function ChannelPeople({ channel, roomId, active, onBack }: { channel: ChannelController; roomId: string; active: boolean; onBack(): void }) {
  const { t } = useCopy();
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
    { label: t("channel.people.thisRoom"), users: [] },
    { label: t("channel.people.online"), users: [] },
    { label: t("channel.people.offline"), users: [] },
  ];
  const ids = new Set([...(state?.users.map(user => user.id) ?? []), ...directory.ids]);
  for (const id of ids) {
    const user = state && userProfile(state, channel.profiles, id);
    if (user) groups[inRoom.has(id) ? 0 : online.has(id) ? 1 : 2].users.push(user);
  }
  const listeningUsers = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams).map(publication => publication.userId));
  const activities = new Map(state ? roomRealtimePeople(state, roomId, channel.profiles).map(user => [user.id, user]) : []);
  const row = (user: User) => {
    const connected = online.has(user.id);
    const activity = connected ? activities.get(user.id) : undefined;
    const voice = state && inRoom.has(user.id) ? voiceAppearance(state, user.id, roomId) : undefined;
    const playback = channel.voicePlaybackByUser.get(user.id) ?? { volume: 1, muted: false };
    return <ChannelUser key={user.id} id={user.id} name={user.name} avatar={user.avatar ?? undefined} self={user.id === self?.id}
      owner={user.id === state?.channel.rooms.find(room => room.id === roomId)?.creatorId} online={connected}
      voice={voice}
      actions={<><ChannelActivityIndicators sharing={activity?.sharing} watching={activity?.watching} joinedWatch={activity?.joinedWatch} />
        {connected && listeningUsers.has(user.id) && user.id !== self?.id && <AudioVolumeMenu volume={playback.volume}
        onVolume={volume => channel.setVoiceVolume(user.id, volume)} label="voice.personVolume" heading={user.name}>
        <Btn icon={playback.muted ? "speakerOff" : "speaker"} size="dense" quiet title="voice.listenPerson"
          pressed={!playback.muted} onClick={() => channel.setVoiceMuted(user.id, !playback.muted)} />
      </AudioVolumeMenu>}</>} />;
  };
  return <aside id="c3-people" className="c3-people-panel" aria-labelledby="c3-people-heading">
    <header><h2 id="c3-people-heading" tabIndex={-1}>{t("channel.people.users")}<span>{state?.channel.userCount ?? 0}</span></h2>
      <span className="c3-pane-back"><BackButton onClick={onBack} /></span>
    </header>
    <div className="c3-people-body">
      {groups.filter(group => group.users.length).map(group => <section className="c3-people-group" key={group.label} aria-label={group.label}>
        <h3 className="c3-section-label">{group.label}<span>{group === groups[2] ? Math.max(0, (state?.channel.userCount ?? 0) - new Set([...inRoom, ...online]).size) : group.users.length}</span></h3>
        <div className="c3-users">{group.users.map(row)}</div>
      </section>)}
      {loading && <p role="status">{t("channel.people.loadingPeople")}</p>}
      {failed && <p role="status">{t("channel.people.loadFailed")}</p>}
      {(failed || directory.next) && <Btn icon={failed ? "refresh" : "arrowDown"} quiet size="compact" busy={loading}
        title={{ text: failed ? t("channel.people.retry") : t("channel.people.morePeople") }}
        cap={{ text: failed ? t("channel.people.retry") : t("channel.people.morePeople") }}
        onClick={() => { if (directory.ids.length) void load(directory.next ?? undefined); else setRetry(value => value + 1); }} />}
    </div>
  </aside>;
}
