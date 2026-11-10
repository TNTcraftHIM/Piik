import type { ChannelPublication, ChannelSnapshot } from "./protocol";

export interface ScreenAudiencePerson {
  userId: string;
  name: string;
  avatar?: string;
  state: "preparing" | "active" | "failed";
}

/** The room owns watch/delivery facts; Browser and App endpoints draw one person. */
export function screenAudience(state: ChannelSnapshot, publication: ChannelPublication): ScreenAudiencePerson[] {
  const ranks = { failed: 0, preparing: 1, active: 2 };
  const people = new Map<string, ScreenAudiencePerson>();
  for (const entry of publication.audience) {
    const endpoint = state.sessions.find(session => session.id === entry.sessionId);
    const user = state.users.find(user => user.id === endpoint?.userId);
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
export function roomPeople(state: ChannelSnapshot, roomId: string) {
  const room = state.channel.rooms.find(value => value.id === roomId);
  if (!room) return [];
  const sessions = new Set(room.participantSessionIds);
  const users = new Set(state.sessions.filter(value => value.online && sessions.has(value.id)).map(value => value.userId));
  return state.users.filter(user => users.has(user.id)).map(user => ({
    userId: user.id, name: user.name, avatar: user.avatar ?? undefined, owner: user.id === (room.creatorId ?? state.channel.ownerId),
    voice: voiceAppearance(state, user.id, roomId),
  }));
}
