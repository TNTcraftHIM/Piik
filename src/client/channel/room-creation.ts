import { DEFAULT_RELAY_CAPACITY, type ChannelRoom, type ChannelSnapshot, type RoomCreationPolicy, type RoomSettings } from "./protocol";

export class RoomCreationInterrupted extends Error {
  constructor(readonly roomId: string | undefined, readonly committed: boolean) {
    super(committed ? "room_created_connection_failed" : "room_creation_unconfirmed");
  }
}

export function roomCreationPolicyFor(channel: Pick<ChannelSnapshot["channel"], "ownerId" | "roomCreationPolicy">, userId: string): RoomCreationPolicy {
  return channel.ownerId === userId ? "ordinary" : channel.roomCreationPolicy;
}

/** Simple sharing remembers the room it made in the same site/person scope as the personal room order. */
export function simpleShareRoomKey(siteId?: string, userId?: string): string | null {
  return siteId && userId ? `piik.channel.simple-share-room.${siteId}.${userId}` : null;
}

export function readSimpleShareRoom(key: string | null): string | null {
  if (!key) return null;
  try { return localStorage.getItem(key); }
  catch { return null; }
}

export function rememberSimpleShareRoom(key: string | null, roomId: string): void {
  if (!key) return;
  try { localStorage.setItem(key, roomId); }
  catch { /* Without storage the next start makes a new room rather than guessing one. */ }
}

/** A temporarily offline host or an ongoing share still belongs to the same room. */
export function simpleShareRoom<T extends Pick<ChannelRoom, "id" | "creatorId" | "authorized">>(rooms: readonly T[], userId: string,
  rememberedId: string | null): T | undefined {
  return rooms.find(room => room.id === rememberedId && room.creatorId === userId && room.authorized);
}

export type RoomDraft = Pick<RoomSettings, "name" | "icon" | "picture" | "access" | "hidden" | "voiceBitrate" | "allowServiceRelay"> & { password: string; removePassword: boolean; relayCapacity: number };

export function roomDraft(room?: ChannelRoom): RoomDraft {
  return { name: room?.name ?? "", icon: room?.icon ?? "couch", access: room?.access ?? "public", hidden: room?.hidden ?? false,
    password: "", removePassword: false, relayCapacity: room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY };
}

export function roomSettingsPatch(dirty: Partial<RoomDraft>, room: Pick<ChannelRoom, "access" | "hidden" | "hasPassword">, inviteOnly = false): Partial<RoomSettings> {
  const { name, password, removePassword, access, hidden, ...settings } = dirty;
  const fields = { ...settings, ...(name === undefined ? {} : { name: name.trim() }) };
  if (inviteOnly) {
    if (Object.keys(fields).length === 0) return fields;
    return { ...fields,
      ...(room.access !== "private" ? { access: "private" } : {}),
      ...(!room.hidden ? { hidden: true } : {}),
      ...(room.hasPassword ? { password: null } : {}) };
  }
  const changes = { ...fields, ...(access === undefined ? {} : { access }) };
  if ((access ?? room.access) === "public") return changes;
  return { ...changes, ...(hidden === undefined ? {} : { hidden }),
    ...(password ? { password } : removePassword ? { password: null } : {}) };
}

export function roomSettings(value: RoomDraft, inviteOnly = false): RoomSettings {
  const { name, icon, picture, access, hidden, password, removePassword, relayCapacity, voiceBitrate } = value;
  const settings = { name: name.trim(), icon, relayCapacity, ...(picture === undefined ? {} : { picture }), ...(voiceBitrate === undefined ? {} : { voiceBitrate }) };
  if (inviteOnly) return { ...settings, access: "private", hidden: true, password: null };
  return { ...settings, access, hidden: access === "private" && hidden,
    ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) };
}
