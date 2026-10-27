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
