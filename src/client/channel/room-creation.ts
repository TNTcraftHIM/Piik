import { DEFAULT_RELAY_CAPACITY, type ChannelRoom, type ChannelSnapshot, type RoomCreationPolicy, type RoomSettings } from "./protocol";

export function roomCreationPolicyFor(channel: Pick<ChannelSnapshot["channel"], "ownerId" | "roomCreationPolicy">, userId: string): RoomCreationPolicy {
  return channel.ownerId === userId ? "ordinary" : channel.roomCreationPolicy;
}

export type RoomDraft = Pick<RoomSettings, "name" | "icon" | "access" | "hidden" | "voiceBitrate"> & { password: string; removePassword: boolean; relayCapacity: number };

export function roomDraft(room?: ChannelRoom): RoomDraft {
  return { name: room?.name ?? "", icon: room?.icon ?? "couch", access: room?.access ?? "public", hidden: room?.hidden ?? false,
    password: "", removePassword: false, relayCapacity: room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY };
}

export function roomSettings(value: RoomDraft, inviteOnly = false): RoomSettings {
  const { name, icon, access, hidden, password, removePassword, relayCapacity, voiceBitrate } = value;
  const settings = { name: name.trim(), icon, relayCapacity, ...(voiceBitrate === undefined ? {} : { voiceBitrate }) };
  if (inviteOnly) return { ...settings, access: "private", hidden: true, password: null };
  return { ...settings, access, hidden: access === "private" && hidden,
    ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) };
}
