import { memberName } from "./member-name";
import type { Copy, CopyKey } from "../ui/copy";
import type { GlyphName } from "../ui/icons";
import type { ChannelMessage, ChannelPublication, ChannelRoom, ChannelSnapshot, ChannelUser, ScreenSource, WatchActivity } from "./protocol";
import type { WatchPlayer } from "./watch-playback";

export function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function messageDateFormats(lang: string, timeZone: string) {
  const clock = { hour: "2-digit", minute: "2-digit" } as const;
  const withDate = { ...clock, month: "short", day: "numeric" } as const;
  const today = new Intl.DateTimeFormat(lang, { ...clock, timeZone });
  const thisYear = new Intl.DateTimeFormat(lang, { ...withDate, timeZone });
  const otherYear = new Intl.DateTimeFormat(lang, { ...withDate, year: "numeric", timeZone });
  return {
    divider: new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone }).format,
    tooltip: new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "long", timeZone }).format,
    clock: (date: Date, reference: Date) =>
      (sameCalendarDay(date, reference) ? today : date.getFullYear() === reference.getFullYear() ? thisYear : otherYear).format(date),
  };
}

export function roomHasUnread(room: Pick<ChannelRoom, "authorized" | "lastMessageSeq">, readThrough?: number): boolean {
  return room.authorized && readThrough !== undefined && room.lastMessageSeq > readThrough;
}

/** A visit's unread divider starts at another person's message, never our own send. */
export function firstUnreadMessageId(messages: readonly Pick<ChannelMessage, "id" | "seq" | "userId">[], after: number | undefined, selfUserId?: string | null, hasEarlier = false): string | undefined {
  if (after !== undefined && hasEarlier && (messages[0]?.seq ?? 0) > after + 1) return undefined;
  return after === undefined ? undefined : messages.find(message => message.seq > after && message.userId !== selfUserId)?.id;
}

export function messageAuthorName(message: Pick<ChannelMessage, "userId" | "archivedAuthorName">, users: readonly Pick<ChannelUser, "id" | "name">[]): string {
  return memberName(message.userId, message.archivedAuthorName ?? users.find(user => user.id === message.userId)?.name);
}

/** Snapshot names are current; avatars display only at their matching profile version. */
export function userProfile(state: ChannelSnapshot | null, profiles: ReadonlyMap<string, ChannelUser>, id: string): ChannelUser | undefined {
  const summary = state?.users.find(user => user.id === id), profile = profiles.get(id);
  return summary ? { ...summary, avatar: profileAvatar(summary, profile) } : profile;
}

export function profileAvatar(summary: Pick<ChannelUser, "version">, profile: ChannelUser | undefined) {
  return profile && profile.version === summary.version ? profile.avatar : null;
}

/** Live metadata owns names; generic source labels belong to the viewer's locale. */
export function screenTitle(screen: { source: ScreenSource; title: string | null }, t: Copy["t"]): string {
  return screen.title ?? screen.source.name ?? (screen.source.kind === "camera"
    ? t("host.device.camera")
    : t("channel.screen.shared"));
}

export interface AudiencePerson {
  userId: string;
  name: string;
  avatar?: string;
}
export type ParticipantViewing = "preparing" | "active" | "failed" | "joined";
export interface ScreenAudiencePerson extends AudiencePerson { state: ParticipantViewing }
export interface ParticipantActivity {
  sharing: boolean;
  viewing?: ParticipantViewing;
  sendingFiles: boolean;
  receivingFiles: boolean;
}
interface LocalWatchPresentation {
  sessionId: string | null;
  watchPlayers: ReadonlyMap<string, Pick<WatchPlayer, "blocked" | "waitingForPicture" | "hasUsablePicture" | "error">>;
}
export const viewingAppearance = {
  joined: { icon: "clapperboard", label: "watch.joined", rank: 0 },
  failed: { icon: "alert", label: "screen.pictureFailed", rank: 1 },
  preparing: { icon: "loader", label: "screen.connectingPicture", rank: 2 },
  active: { icon: "eye", label: "screen.pictureReceived", rank: 3 },
} as const satisfies Record<ParticipantViewing, { icon: GlyphName; label: CopyKey; rank: number }>;

export function participantViewingLabel(state: ParticipantViewing, t: Copy["t"]): string {
  return t(viewingAppearance[state].label);
}

function screenAudienceViewing(state: string): ParticipantViewing {
  return Object.hasOwn(viewingAppearance, state) ? state as ParticipantViewing : "joined";
}

function watchViewerState(watch: WatchActivity, sessionId: string, local?: LocalWatchPresentation): ParticipantViewing {
  const player = sessionId === local?.sessionId ? local.watchPlayers.get(watch.id) : undefined;
  if (player?.error) return "failed";
  if (player?.blocked) return "joined";
  if (player?.waitingForPicture) return "preparing";
  return player?.hasUsablePicture ? "active" : "joined";
}

function takesViewingPriority(next: ParticipantViewing, current?: ParticipantViewing): boolean {
  return current === undefined || viewingAppearance[next].rank > viewingAppearance[current].rank;
}

/** The room reports delivery to this endpoint in its own audience entry: one person can watch from several endpoints. */
export function screenDeliveryFailed(publication: ChannelPublication, sessionId: string | null): boolean {
  return publication.audience.some(entry => entry.sessionId === sessionId && entry.state === "failed");
}

/** The navigation row describes this endpoint. A person's row can combine several endpoints. */
export function roomSessionViewing(screens: readonly ChannelPublication[], watches: readonly WatchActivity[],
  subscriptions: readonly string[], local: LocalWatchPresentation): ParticipantViewing | undefined {
  const { sessionId } = local;
  if (!sessionId) return;
  let result: ParticipantViewing | undefined;
  for (const screen of screens) {
    if (!subscriptions.includes(screen.id)) continue;
    const viewer = screen.audience.find(entry => entry.sessionId === sessionId);
    if (!viewer) continue;
    const viewing = screenAudienceViewing(viewer.state);
    if (takesViewingPriority(viewing, result)) result = viewing;
  }
  for (const watch of watches) {
    if (watch.sessionId === sessionId || !watch.viewerSessionIds.includes(sessionId)) continue;
    const status = watchViewerState(watch, sessionId, local);
    if (takesViewingPriority(status, result)) result = status;
  }
  return result;
}

type VoiceAppearance = { microphone: boolean; deafened: boolean; level?: number };
type RoomActivity = ParticipantActivity & { voice?: VoiceAppearance };
const idleActivity = (): RoomActivity => ({ sharing: false, sendingFiles: false, receivingFiles: false });

function roomActivities(state: ChannelSnapshot, roomId: string, local?: LocalWatchPresentation) {
  const people = new Map<string, RoomActivity>();
  let endpoints: Map<string, string> | undefined;
  function person(id: string) {
    let row = people.get(id);
    if (!row) {
      row = idleActivity();
      people.set(id, row);
    }
    return row;
  }
  function endpoint(id: string) {
    endpoints ??= new Map(state.sessions.map(session => [session.id, session.userId]));
    const user = endpoints.get(id);
    return user === undefined ? undefined : person(user);
  }
  function view(sessionId: string, status: ParticipantViewing) {
    const row = endpoint(sessionId);
    if (row && takesViewingPriority(status, row.viewing)) row.viewing = status;
  }
  for (const publication of state.publications) {
    if (publication.roomId !== roomId || publication.kind !== "screen") continue;
    person(publication.userId).sharing = true;
    for (const viewer of publication.audience) view(viewer.sessionId, screenAudienceViewing(viewer.state));
  }
  for (const watch of state.watchActivities) {
    if (watch.roomId !== roomId) continue;
    person(watch.userId).sharing = true;
    for (const id of watch.viewerSessionIds) view(id, watchViewerState(watch, id, local));
  }
  for (const file of state.channel.rooms.find(room => room.id === roomId)?.fileActivity ?? []) {
    if (!file.sending && !file.receiving) continue;
    const row = endpoint(file.sessionId);
    if (row) {
      row.sendingFiles ||= file.sending;
      row.receivingFiles ||= file.receiving;
    }
  }
  for (const voice of state.voice) {
    if (voice.roomId !== roomId) continue;
    const row = endpoint(voice.sessionId);
    if (row) row.voice = mergeVoice(row.voice, voice);
  }
  return people;
}

/** Joining a watch is a room fact; it does not assert local video readiness. */
export function watchAudience(state: ChannelSnapshot, activity: WatchActivity, profiles: ReadonlyMap<string, ChannelUser> = new Map()): AudiencePerson[] {
  const people = new Map<string, AudiencePerson>();
  for (const sessionId of activity.viewerSessionIds) {
    const endpoint = state.sessions.find(session => session.id === sessionId);
    const user = userProfile(state, profiles, endpoint?.userId ?? "");
    if (user && user.id !== activity.userId) people.set(user.id, { userId: user.id, name: user.name, avatar: user.avatar ?? undefined });
  }
  return [...people.values()];
}

/** The room owns watch/delivery facts; Browser and App endpoints draw one person. */
export function screenAudience(state: ChannelSnapshot, publication: ChannelPublication, profiles: ReadonlyMap<string, ChannelUser> = new Map()): ScreenAudiencePerson[] {
  const people = new Map<string, ScreenAudiencePerson>();
  for (const entry of publication.audience) {
    const endpoint = state.sessions.find(session => session.id === entry.sessionId);
    const user = userProfile(state, profiles, endpoint?.userId ?? "");
    if (!user || user.id === publication.userId) continue;
    // Signaling can disconnect while an established media watch continues.
    const previous = people.get(user.id);
    const viewing = screenAudienceViewing(entry.state);
    if (takesViewingPriority(viewing, previous?.state)) people.set(user.id, { userId: user.id, name: user.name, avatar: user.avatar ?? undefined, state: viewing });
  }
  return [...people.values()];
}

/** Remote voice streams played by this endpoint, independently of the browsed room. */
export function listeningVoicePublications(state: ChannelSnapshot | null, sessionId: string | null, streams: ReadonlyMap<string, MediaStream>) {
  return state?.publications.filter(value => value.kind === "voice" && value.sessionId !== sessionId &&
    state.voice.some(member => member.sessionId === sessionId && member.roomId === value.roomId && !member.deafened) &&
    state.subscriptions.includes(value.id) && streams.has(value.id)) ?? [];
}

function mergeVoice(previous: VoiceAppearance | undefined, voice: ChannelSnapshot["voice"][number], level?: number): VoiceAppearance {
  const appearance = previous ?? { microphone: false, deafened: true };
  appearance.microphone ||= !voice.muted;
  appearance.deafened &&= voice.deafened;
  if (!voice.muted && level !== undefined) appearance.level = Math.max(appearance.level ?? level, level);
  return appearance;
}

export function roomVoicePeople(state: ChannelSnapshot, roomId: string, levels: ReadonlyMap<string, number>) {
  const endpoints = new Map(state.sessions.map(session => [session.id, session.userId]));
  const people = new Map<string, VoiceAppearance>();
  for (const voice of state.voice) {
    if (voice.roomId !== roomId) continue;
    const user = endpoints.get(voice.sessionId);
    if (user !== undefined) people.set(user, mergeVoice(people.get(user), voice, levels.get(voice.sessionId)));
  }
  return people;
}

/** A person is online while any of their sessions is online. */
export function onlineUserIds(state: ChannelSnapshot | null) {
  return new Set(state?.sessions.filter(session => session.online).map(session => session.userId));
}

/** Room membership persists through signaling recovery when media participation does. */
export function roomPresentUserIds(state: ChannelSnapshot, roomId: string, activity = roomActivities(state, roomId)) {
  const sessions = new Set(state.channel.rooms.find(room => room.id === roomId)?.participantSessionIds);
  return new Set(state.sessions.filter(session => {
    if (!sessions.has(session.id)) return false;
    const person = activity.get(session.userId);
    return session.online || !!(person?.voice || person?.sharing || person?.viewing);
  }).map(session => session.userId));
}

export function roomPeople(state: ChannelSnapshot, roomId: string, profiles: ReadonlyMap<string, ChannelUser> = new Map(), local?: LocalWatchPresentation) {
  const room = state.channel.rooms.find(value => value.id === roomId);
  if (!room) return [];
  const activity = roomActivities(state, roomId, local);
  const users = roomPresentUserIds(state, roomId, activity);
  const online = onlineUserIds(state);
  return state.users.filter(user => users.has(user.id)).map(user => ({
    userId: user.id, name: user.name, avatar: profileAvatar(user, profiles.get(user.id)) ?? undefined, owner: user.id === (room.creatorId ?? state.channel.ownerId),
    online: online.has(user.id),
    ...(activity.get(user.id) ?? idleActivity()),
  }));
}

/** Each row is explained by the room activity the person is participating in. */
export function roomActivityPeople(state: ChannelSnapshot, roomId: string, profiles: ReadonlyMap<string, ChannelUser> = new Map(), local?: LocalWatchPresentation) {
  const room = state.channel.rooms.find(value => value.id === roomId);
  if (!room?.authorized || !room.available) return [];
  const activity = roomActivities(state, roomId, local);
  if (!activity.size) return [];
  return state.users.flatMap(user => {
    const row = activity.get(user.id);
    if (!row) return [];
    return [{ ...user, avatar: profileAvatar(user, profiles.get(user.id)), ...row }];
  });
}
