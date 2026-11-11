import type { ChannelMessage, ChannelPublication, ChannelSnapshot, ChannelUser } from "./protocol";

export function messageAuthorName(message: ChannelMessage, users: readonly Pick<ChannelUser, "id" | "name">[], fallback: string): string {
  return message.archivedAuthorName ?? users.find(user => user.id === message.userId)?.name ?? fallback;
}

/** Snapshot names are current; avatars display only at their matching profile version. */
export function userProfile(state: ChannelSnapshot | null, profiles: ReadonlyMap<string, ChannelUser>, id: string): ChannelUser | undefined {
  const summary = state?.users.find(user => user.id === id), profile = profiles.get(id);
  return summary ? { ...summary, avatar: profile?.version === summary.version ? profile.avatar : null } : profile;
}

/** Live metadata owns names; generic source labels belong to the viewer's locale. */
export function screenTitle(screen: { source: { kind: "screen" | "camera"; name: string | null }; title: string | null }, lang: "zh" | "en"): string {
  return screen.title ?? screen.source.name ?? (screen.source.kind === "camera"
    ? lang === "zh" ? "摄像头" : "Camera"
    : lang === "zh" ? "分享画面" : "Shared screen");
}

export interface ScreenAudiencePerson {
  userId: string;
  name: string;
  avatar?: string;
  state: "preparing" | "active" | "failed";
}

/** The room owns watch/delivery facts; Browser and App endpoints draw one person. */
export function screenAudience(state: ChannelSnapshot, publication: ChannelPublication, profiles: ReadonlyMap<string, ChannelUser> = new Map()): ScreenAudiencePerson[] {
  const ranks = { failed: 0, preparing: 1, active: 2 };
  const people = new Map<string, ScreenAudiencePerson>();
  for (const entry of publication.audience) {
    const endpoint = state.sessions.find(session => session.id === entry.sessionId);
    const user = userProfile(state, profiles, endpoint?.userId ?? "");
    if (!user || user.id === publication.userId) continue;
    // Signaling can disconnect while an established media watch continues.
    const previous = people.get(user.id);
    if (!previous || ranks[entry.state] > ranks[previous.state]) people.set(user.id, { userId: user.id, name: user.name, avatar: user.avatar ?? undefined, state: entry.state });
  }
  return [...people.values()];
}

/** Remote voice streams played by this endpoint, independently of the browsed room. */
export function listeningVoicePublications(state: ChannelSnapshot | null, sessionId: string | null, streams: ReadonlyMap<string, MediaStream>) {
  return state?.publications.filter(value => value.kind === "voice" && value.sessionId !== sessionId &&
    state.voice.some(member => member.sessionId === sessionId && member.roomId === value.roomId && !member.deafened) &&
    state.subscriptions.includes(value.id) && streams.has(value.id)) ?? [];
}

/** One user's appearance combines their endpoints in the selected voice room. */
export function voiceAppearance(state: ChannelSnapshot, userId: string, roomId: string) {
  const endpoints = new Set(state.sessions.filter(session => session.userId === userId).map(session => session.id));
  const voices = state.voice.filter(voice => voice.roomId === roomId && endpoints.has(voice.sessionId));
  return voices.length ? {
    microphone: voices.some(voice => !voice.muted),
    deafened: voices.every(voice => voice.deafened),
  } : undefined;
}

/** The room supplies presence; multiple live endpoints still draw one person. */
export function roomPeople(state: ChannelSnapshot, roomId: string, profiles: ReadonlyMap<string, ChannelUser> = new Map()) {
  const room = state.channel.rooms.find(value => value.id === roomId);
  if (!room) return [];
  const sessions = new Set(room.participantSessionIds);
  const users = new Set(state.sessions.filter(value => value.online && sessions.has(value.id)).map(value => value.userId));
  return state.users.filter(user => users.has(user.id)).map(user => ({
    userId: user.id, name: user.name, avatar: userProfile(state, profiles, user.id)?.avatar ?? undefined, owner: user.id === (room.creatorId ?? state.channel.ownerId),
    voice: voiceAppearance(state, user.id, roomId),
  }));
}

/** Room authority supplies real-time involvement, independently of chat presence. */
export function roomRealtimePeople(state: ChannelSnapshot, roomId: string, profiles: ReadonlyMap<string, ChannelUser> = new Map()) {
  const endpoints = new Set(state.channel.rooms.find(room => room.id === roomId)?.realtimeSessionIds ?? []);
  const users = new Set(state.sessions.filter(session => endpoints.has(session.id)).map(session => session.userId));
  const screens = state.publications.filter(publication => publication.kind === "screen" && publication.roomId === roomId);
  return state.users.filter(user => users.has(user.id)).map(user => ({ ...user, avatar: userProfile(state, profiles, user.id)?.avatar,
    voice: voiceAppearance(state, user.id, roomId),
    sharing: screens.some(publication => publication.userId === user.id),
    watching: screens.some(publication => publication.audience.some(viewer => state.sessions.some(session => session.id === viewer.sessionId && session.userId === user.id))),
  }));
}
