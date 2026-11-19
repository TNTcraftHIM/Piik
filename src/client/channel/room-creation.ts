import { DEFAULT_RELAY_CAPACITY, type ChannelRoom, type ChannelSnapshot, type RoomCreationPolicy, type RoomSettings } from "./protocol";

export class RoomCreationInterrupted extends Error {
  constructor(readonly roomId: string, readonly committed: boolean) {
    super(committed ? "room_created_connection_failed" : "room_creation_unconfirmed");
  }
}

export function roomCreationPolicyFor(channel: Pick<ChannelSnapshot["channel"], "ownerId" | "roomCreationPolicy">, userId: string): RoomCreationPolicy {
  return channel.ownerId === userId ? "ordinary" : channel.roomCreationPolicy;
}

export type RoomDraft = Pick<RoomSettings, "name" | "icon" | "picture" | "access" | "hidden" | "voiceBitrate"> & { password: string; removePassword: boolean; relayCapacity: number };

export function roomDraft(room?: ChannelRoom): RoomDraft {
  return { name: room?.name ?? "", icon: room?.icon ?? "couch", access: room?.access ?? "public", hidden: room?.hidden ?? false,
    password: "", removePassword: false, relayCapacity: room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY };
}

export function roomSettingsPatch(dirty: Partial<RoomDraft>, invitationOnlyRoom?: Pick<ChannelRoom, "access" | "hidden" | "hasPassword">): Partial<RoomSettings> {
  const { name, password, removePassword, access, hidden, ...settings } = dirty;
  const fields = { ...settings, ...(name === undefined ? {} : { name: name.trim() }) };
  if (invitationOnlyRoom) {
    if (Object.keys(fields).length === 0) return fields;
    return { ...fields,
      ...(invitationOnlyRoom.access !== "private" ? { access: "private" } : {}),
      ...(!invitationOnlyRoom.hidden ? { hidden: true } : {}),
      ...(invitationOnlyRoom.hasPassword ? { password: null } : {}) };
  }
  return { ...fields, ...(access === undefined ? {} : { access }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(password ? { password } : removePassword ? { password: null } : {}) };
}

export function roomSettings(value: RoomDraft, inviteOnly = false): RoomSettings {
  const { name, icon, picture, access, hidden, password, removePassword, relayCapacity, voiceBitrate } = value;
  const settings = { name: name.trim(), icon, relayCapacity, ...(picture === undefined ? {} : { picture }), ...(voiceBitrate === undefined ? {} : { voiceBitrate }) };
  if (inviteOnly) return { ...settings, access: "private", hidden: true, password: null };
  return { ...settings, access, hidden: access === "private" && hidden,
    ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) };
}
