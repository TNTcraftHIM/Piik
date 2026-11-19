import { useEffect, useState } from "react";
import type { ChannelRoom } from "./protocol";

export function roomOrderKey(siteId?: string, userId?: string): string | null {
  return siteId && userId ? `piik.channel.room-order.${siteId}.${userId}` : null;
}

export function readRoomOrder(key: string | null): string[] {
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) && value.every(id => typeof id === "string") ? [...new Set(value)] : [];
  } catch { return []; }
}

export function orderedRooms(rooms: readonly ChannelRoom[], order: readonly string[]): ChannelRoom[] {
  const byId = new Map(rooms.map(room => [room.id, room]));
  const result: ChannelRoom[] = [];
  for (const id of order) {
    const room = byId.get(id);
    if (room) { result.push(room); byId.delete(id); }
  }
  return [...result, ...byId.values()];
}

export function moveRoom(ids: readonly string[], source: string, target: string): string[] {
  const from = ids.indexOf(source), to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1); next.splice(to, 0, source);
  return next;
}

export function roomAvailabilityGroups(rooms: readonly ChannelRoom[]) {
  return [
    { available: true, rooms: rooms.filter(room => room.available) },
    { available: false, rooms: rooms.filter(room => !room.available) },
  ].filter(group => group.rooms.length);
}

export function moveRoomWithinAvailability(rooms: readonly ChannelRoom[], available: boolean, source: string, target: string) {
  const ids = rooms.filter(room => room.available === available).map(room => room.id);
  const position = ids.indexOf(target);
  if (position < 0 || source === target || !ids.includes(source)) return;
  const reordered = moveRoom(ids, source, target);
  let index = 0;
  return { ids: rooms.map(room => room.available === available ? reordered[index++] : room.id), position: position + 1, total: ids.length };
}

/** Personal order uses the same site/user scope as local reading preferences. */
export function useRoomOrder(rooms: readonly ChannelRoom[], siteId?: string, userId?: string) {
  const key = roomOrderKey(siteId, userId);
  const [saved, setSaved] = useState(() => ({ key, ids: readRoomOrder(key) }));
  useEffect(() => {
    setSaved({ key, ids: readRoomOrder(key) });
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) setSaved({ key, ids: readRoomOrder(key) }); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  const ordered = orderedRooms(rooms, saved.key === key ? saved.ids : readRoomOrder(key));
  const move = (available: boolean, source: string, target: string) => {
    if (!key) return;
    const moved = moveRoomWithinAvailability(ordered, available, source, target);
    if (!moved) return;
    const { ids } = moved;
    setSaved({ key, ids });
    try { localStorage.setItem(key, JSON.stringify(ids)); }
    catch { /* The order remains usable for this page when storage is unavailable. */ }
    return moved;
  };
  return { rooms: ordered, move };
}
