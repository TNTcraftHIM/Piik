import type { Copy } from "../ui/copy";
import type { ChannelMessage, ChannelPublication, ChannelSnapshot, ChannelUser, WatchActivity } from "./protocol";
import type { WatchPlayer } from "./watch-playback";

/** A visit's unread divider starts at another person's message, never our own send. */
export function firstUnreadMessageId(messages: readonly Pick<ChannelMessage, "id" | "seq" | "userId">[], after: number | undefined, selfUserId?: string | null): string | undefined {
  return after === undefined ? undefined : messages.find(message => message.seq > after && message.userId !== selfUserId)?.id;
}

export function messageAuthorName(message: ChannelMessage, users: readonly Pick<ChannelUser, "id" | "name">[], fallback: string): string {
  return message.archivedAuthorName ?? users.find(user => user.id === message.userId)?.name ?? fallback;
}

/** Snapshot names are current; avatars display only at their matching profile version. */
export function userProfile(state: ChannelSnapshot | null, profiles: ReadonlyMap<string, ChannelUser>, id: string): ChannelUser | undefined {
  const summary = state?.users.find(user => user.id === id), profile = profiles.get(id);
  return summary ? { ...summary, avatar: profile?.version === summary.version ? profile.avatar : null } : profile;
}

/** Live metadata owns names; generic source labels belong to the viewer's locale. */
export function screenTitle(screen: { source: { kind: "screen" | "camera"; name: string | null }; title: string | null }, t: Copy["t"]): string {
  return screen.title ?? screen.source.name ?? (screen.source.kind === "camera"
    ? t("host.device.camera")
    : t("channel.screen.shared"));
}

export interface AudiencePerson {
  userId: string;
  name: string;
  avatar?: string;
}
export interface ScreenAudiencePerson extends AudiencePerson { state: "preparing" | "active" | "failed" }

export type ParticipantViewing = ScreenAudiencePerson["state"] | "joined";
export interface ParticipantActivity { sharing: boolean; viewing?: ParticipantViewing }
interface LocalWatchPresentation {
  sessionId: string | null;
  watchPlayers: ReadonlyMap<string, Pick<WatchPlayer, "waitingForPicture" | "hasPresentedFrame" | "error">>;
}
const viewingRank = { joined: 0, failed: 1, preparing: 2, active: 3 };

export function participantViewingLabel(state: ParticipantViewing, t: Copy["t"]): string {
  return t(({ joined: "watch.joined", preparing: "screen.connectingPicture", active: "screen.pictureReceived", failed: "screen.pictureFailed" } as const)[state]);
}

/** Screen audience proves remote decoding; watch membership alone proves only joining. */
export function participantActivity(state: ChannelSnapshot, roomId: string, userId: string, local?: LocalWatchPresentation): ParticipantActivity {
  const endpoints = new Set(state.sessions.filter(session => session.userId === userId).map(session => session.id));
  const screens = state.publications.filter(publication => publication.kind === "screen" && publication.roomId === roomId);
  const watches = state.watchActivities.filter(activity => activity.roomId === roomId);
  const viewing: ParticipantViewing[] = screens.flatMap(publication => publication.audience.filter(viewer => endpoints.has(viewer.sessionId)).map(viewer => viewer.state));
  for (const activity of watches) {
    if (!activity.viewerSessionIds.some(id => endpoints.has(id))) continue;
    // This page's player cannot attest to another endpoint, even for the same user.
    const player = local?.sessionId && endpoints.has(local.sessionId) && activity.viewerSessionIds.includes(local.sessionId)
      ? local.watchPlayers.get(activity.id) : undefined;
    if (!player) viewing.push("joined");
    else if (player.error) viewing.push("failed");
    else if (player.hasPresentedFrame) viewing.push("active");
    else if (player.waitingForPicture) viewing.push("preparing");
    else viewing.push("joined");
  }
  return {
    sharing: screens.some(publication => publication.userId === userId) || watches.some(activity => activity.userId === userId),
    viewing: viewing.sort((a, b) => viewingRank[b] - viewingRank[a])[0],
  };
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
    if (!previous || viewingRank[entry.state] > viewingRank[previous.state]) people.set(user.id, { userId: user.id, name: user.name, avatar: user.avatar ?? undefined, state: entry.state });
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
export function roomPeople(state: ChannelSnapshot, roomId: string, profiles: ReadonlyMap<string, ChannelUser> = new Map(), local?: LocalWatchPresentation) {
  const room = state.channel.rooms.find(value => value.id === roomId);
  if (!room) return [];
  const sessions = new Set(room.participantSessionIds);
  const users = new Set(state.sessions.filter(value => value.online && sessions.has(value.id)).map(value => value.userId));
  return state.users.filter(user => users.has(user.id)).map(user => ({
    userId: user.id, name: user.name, avatar: userProfile(state, profiles, user.id)?.avatar ?? undefined, owner: user.id === (room.creatorId ?? state.channel.ownerId),
    voice: voiceAppearance(state, user.id, roomId),
    ...participantActivity(state, roomId, user.id, local),
  }));
}

/** Room authority supplies real-time involvement, independently of chat presence. */
export function roomRealtimePeople(state: ChannelSnapshot, roomId: string, profiles: ReadonlyMap<string, ChannelUser> = new Map(), local?: LocalWatchPresentation) {
  const endpoints = new Set(state.channel.rooms.find(room => room.id === roomId)?.realtimeSessionIds ?? []);
  const users = new Set(state.sessions.filter(session => endpoints.has(session.id)).map(session => session.userId));
  return state.users.filter(user => users.has(user.id)).map(user => ({ ...user, avatar: userProfile(state, profiles, user.id)?.avatar,
    voice: voiceAppearance(state, user.id, roomId),
    ...participantActivity(state, roomId, user.id, local),
  }));
}
