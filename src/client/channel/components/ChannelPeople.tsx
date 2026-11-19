import { BackButton, Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { ChannelUser as User } from "../protocol";
import { listeningVoicePublications, roomPresentUserIds, roomActivityPeople, userProfile } from "../presentation";
import { ChannelUser } from "./ChannelUser";
import { useEffect, useRef, useState } from "react";

export function ChannelPeople({ channel, roomId, active, onBack }: { channel: ChannelController; roomId: string; active: boolean; onBack(): void }) {
  const { t } = useCopy();
  const { state, self } = channel;
  const [directory, setDirectory] = useState<{ ids: string[]; next?: string | null }>({ ids: [] });
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const loadedIds = useRef<string[] | null>(null);
  const load = async (after?: string) => {
    if (request.current || channel.connection !== "connected") return;
    const current = request.current = new AbortController();
    setLoading(true); setFailed(false);
    try {
      const page = await channel.queryProfiles(after ? { after } : {}, current.signal);
      if (!current.signal.aborted) {
        const pageIds = page.profiles.map(user => user.id);
        loadedIds.current = [...new Set([...(loadedIds.current ?? []), ...pageIds])];
        setDirectory(previous => ({ ids: [...new Set([...previous.ids, ...pageIds])], next: page.nextCursor }));
      }
    } catch { if (!current.signal.aborted) setFailed(true); }
    finally {
      if (request.current === current) {
        request.current = null;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    loadedIds.current = null;
    setDirectory({ ids: [] }); setLoading(false); setFailed(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [state?.channel.id, self?.id]);
  useEffect(() => {
    if (!active || channel.connection !== "connected") return;
    if (loadedIds.current === null) void load();
    else void channel.loadProfiles(loadedIds.current).catch(() => {});
  }, [active, state?.channel.id, self?.id, channel.connection]);
  useEffect(() => {
    if (active) setDirectory(previous => state?.users.every(user => previous.ids.includes(user.id)) ? previous
      : { ...previous, ids: [...new Set([...previous.ids, ...(state?.users.map(user => user.id) ?? [])])] });
  }, [active, state?.users]);
  const online = new Set(state?.sessions.filter(session => session.online).map(session => session.userId));
  const inRoom = state ? roomPresentUserIds(state, roomId) : new Set<string>();
  const groups: { label: string; users: User[] }[] = [
    { label: t("channel.people.thisRoom"), users: [] },
    { label: t("channel.people.online"), users: [] },
    { label: t("channel.people.offline"), users: [] },
  ];
  const ids = new Set([...(state?.users.map(user => user.id) ?? []), ...directory.ids]);
  // A new identity can sort before the last cursor while the panel is closed.
  const missingAfterLastPage = directory.next === null && ids.size < (state?.channel.userCount ?? 0);
  for (const id of ids) {
    const user = state && userProfile(state, channel.profiles, id);
    if (user) groups[inRoom.has(id) ? 0 : online.has(id) ? 1 : 2].users.push(user);
  }
  const listeningUsers = new Set(listeningVoicePublications(state, channel.sessionId, channel.streams).map(publication => publication.userId));
  const activities = new Map(state ? roomActivityPeople(state, roomId, channel.profiles, channel).map(user => [user.id, user]) : []);
  const roomOwner = state?.channel.rooms.find(room => room.id === roomId)?.creatorId;
  const row = (user: User) => <ChannelUser key={user.id} id={user.id} name={user.name} avatar={user.avatar ?? undefined}
    self={user.id === self?.id} owner={user.id === roomOwner} online={online.has(user.id)}
    roomActivity={activities.get(user.id)} voicePlayback={listeningUsers.has(user.id) ? channel : undefined} />;
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
      {(failed || directory.next || missingAfterLastPage) && <Btn icon={failed ? "refresh" : "arrowDown"} quiet size="compact" busy={loading}
        disabled={channel.connection !== "connected"}
        title={{ text: failed ? t("channel.people.retry") : t("channel.people.morePeople") }}
        cap={{ text: failed ? t("channel.people.retry") : t("channel.people.morePeople") }}
        onClick={() => { void load(directory.next ?? undefined); }} />}
    </div>
  </aside>;
}
