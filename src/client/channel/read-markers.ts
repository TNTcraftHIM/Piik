import { z } from "zod";
import type { ChannelRoom } from "./protocol";

type Room = Pick<ChannelRoom, "id" | "authorized" | "available" | "lastMessageSeq" | "historyLineage" | "delivery">;
type Positions = Record<string, number>;
const sequence = z.number().int().nonnegative();
const savedMarkers = z.record(z.string(), z.object({ seq: sequence, lineage: z.string() }));

function equalPositions(left: Positions, right: Positions): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(id => left[id] === right[id]);
}

export class RoomReadMarkers {
  private key: string | null = null;
  private saved: z.infer<typeof savedMarkers> = {};
  private positions: Positions = {};
  private readonly observed = new Map<string, { lineage: string; savedAtEntry?: string }>();

  project(siteId: string, userId: string | undefined, rooms: readonly Room[]): Positions {
    const key = userId ? `piik.channel.read.v2.${siteId}.${userId}` : null;
    const changedIdentity = this.key !== key;
    if (changedIdentity) {
      this.key = key;
      this.saved = {};
      this.positions = {};
      this.observed.clear();
    }
    if (!key) return this.positions;
    if (changedIdentity || rooms.some(room => room.authorized && room.available && room.delivery
      && this.observed.get(room.id)?.lineage !== room.historyLineage)) this.load(key);
    return this.update(rooms, true);
  }

  refresh(rooms: readonly Room[], changedKey?: string | null): Positions {
    if (!this.key || (changedKey != null && changedKey !== this.key)) return this.positions;
    this.load(this.key);
    return this.update(rooms, false);
  }

  advance(rooms: readonly Room[], roomId: string, seq: number): Positions {
    const room = rooms.find(room => room.id === roomId && room.authorized);
    if (!this.key || !room?.available || !room.delivery || !room.historyLineage || Math.min(seq, room.lastMessageSeq) <= (this.positions[roomId] ?? 0)) return this.positions;
    this.load(this.key);
    return this.update(rooms, false, { roomId, seq });
  }

  private load(key: string): void {
    try { this.saved = savedMarkers.parse(JSON.parse(localStorage.getItem(key) ?? "{}")); }
    catch { /* Keep local progress when storage is unavailable. */ }
  }

  private update(rooms: readonly Room[], fromAuthority: boolean, advance?: { roomId: string; seq: number }): Positions {
    let changed = false;
    const next: Positions = {};
    for (const room of rooms) {
      if (!room.authorized) continue;
      const id = room.id, record = this.saved[id];
      const lineage = room.available && room.delivery ? room.historyLineage : undefined;
      const observed = this.observed.get(id);
      if (!lineage) {
        next[id] = this.positions[id] ?? record?.seq ?? 0;
        continue;
      }
      if (fromAuthority && observed?.lineage !== lineage) {
        this.observed.set(id, { lineage, savedAtEntry: record?.lineage });
      }
      const current = this.observed.get(id);
      if (current?.lineage !== lineage) {
        next[id] = this.positions[id] ?? 0;
        continue;
      }
      const sameHistory = record?.lineage === lineage;
      let position = sameHistory ? record.seq : 0;
      if (!record && !observed) position = room.lastMessageSeq;
      if (observed?.lineage === lineage) position = Math.max(position, this.positions[id] ?? 0);
      const reading = advance?.roomId === id;
      const writable = !record || sameHistory || (reading && record.lineage === current.savedAtEntry);
      if (reading && writable) position = Math.max(position, Math.min(advance.seq, room.lastMessageSeq));
      if (writable && (record?.lineage !== lineage || record.seq !== position)) {
        this.saved[id] = { seq: position, lineage };
        changed = true;
      }
      next[id] = Math.min(position, room.lastMessageSeq);
    }
    if (changed && this.key) {
      try { localStorage.setItem(this.key, JSON.stringify(this.saved)); } catch { /* Volatile reading still works. */ }
    }
    if (!equalPositions(next, this.positions)) this.positions = next;
    return this.positions;
  }
}
