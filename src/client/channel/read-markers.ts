import { z } from "zod";
import type { ChannelRoom } from "./protocol";

type Room = Pick<ChannelRoom, "id" | "authorized" | "available" | "lastMessageSeq">;
type Positions = Record<string, number>;
const savedPositions = z.record(z.string(), z.number().int().nonnegative());

function equalPositions(left: Positions, right: Positions): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(id => left[id] === right[id]);
}

/** Room summaries bound local cursors. Other tabs can advance the same identity. */
export class RoomReadMarkers {
  private key: string | null = null;
  private saved: Positions = {};
  private positions: Positions = {};

  project(siteId: string, userId: string | undefined, rooms: readonly Room[]): Positions {
    const key = userId ? `piik.channel.read.${siteId}.${userId}` : null;
    const changedIdentity = this.key !== key;
    if (changedIdentity) {
      this.key = key;
      this.saved = {};
      this.positions = {};
    }
    if (!key) return this.positions;
    // Read other tabs' cursors before initializing a room or recording a history rewind.
    const needsSave = rooms.some(room => room.authorized && (this.saved[room.id] === undefined
      || (room.available && this.positions[room.id] > room.lastMessageSeq)));
    if (changedIdentity || needsSave) this.load(key);
    return this.update(key, rooms);
  }

  refresh(rooms: readonly Room[], changedKey?: string | null): Positions {
    if (!this.key || (changedKey != null && changedKey !== this.key)) return this.positions;
    this.load(this.key);
    return this.update(this.key, rooms);
  }

  advance(rooms: readonly Room[], roomId: string, seq: number): Positions {
    const room = rooms.find(room => room.id === roomId && room.authorized);
    const position = room && Math.min(seq, room.lastMessageSeq);
    if (!this.key || position === undefined || position <= (this.positions[roomId] ?? 0)) return this.positions;
    this.load(this.key);
    return this.update(this.key, rooms, { roomId, position });
  }

  private load(key: string): void {
    try { this.saved = savedPositions.parse(JSON.parse(localStorage.getItem(key) ?? "{}")); } catch { /* Keep local progress when storage is unavailable. */ }
  }

  private update(key: string, rooms: readonly Room[], advance?: { roomId: string; position: number }): Positions {
    let changed = false;
    const next: Positions = {};
    for (const room of rooms) {
      if (!room.authorized) continue;
      const prior = this.positions[room.id], saved = this.saved[room.id];
      let position = saved ?? prior ?? (room.available ? room.lastMessageSeq : 0);
      if (room.available && prior > room.lastMessageSeq) position = Math.min(position, room.lastMessageSeq);
      if (advance?.roomId === room.id) position = Math.max(position, advance.position);
      if (saved !== position) { this.saved[room.id] = position; changed = true; }
      next[room.id] = room.available ? Math.min(position, room.lastMessageSeq) : position;
    }
    // The directory is session-specific. An omitted room can still belong to another tab.
    if (changed) {
      try { localStorage.setItem(key, JSON.stringify(this.saved)); } catch { /* Reading still works without persistence. */ }
    }
    if (!equalPositions(next, this.positions)) this.positions = next;
    return this.positions;
  }
}
