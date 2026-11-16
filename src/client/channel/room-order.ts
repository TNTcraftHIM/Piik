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
  const move = (source: string, target: string) => {
    if (!key) return;
    const ids = moveRoom(ordered.map(room => room.id), source, target);
    setSaved({ key, ids });
    try { localStorage.setItem(key, JSON.stringify(ids)); }
    catch { /* The order remains usable for this page when storage is unavailable. */ }
  };
  return { rooms: ordered, move };
}
