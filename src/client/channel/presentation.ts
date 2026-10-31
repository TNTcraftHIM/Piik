import type { ChannelSnapshot } from "./protocol";

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
    userId: user.id, name: user.name, owner: user.id === (room.creatorId ?? state.channel.ownerId),
    voice: voiceAppearance(state, user.id, roomId),
  }));
}
