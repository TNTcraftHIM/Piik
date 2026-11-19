import { z } from "zod";
import type { ChannelRoom } from "./protocol";

type Room = Pick<ChannelRoom, "id" | "authorized" | "available" | "lastMessageSeq" | "delivery">;
type Positions = Record<string, number>;
const sequence = z.number().int().nonnegative();
const savedMarkers = z.record(z.string(), z.union([sequence, z.object({ seq: sequence, binding: z.string() })]));

function equalPositions(left: Positions, right: Positions): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(id => left[id] === right[id]);
}

export class RoomReadMarkers {
  private key: string | null = null;
  private saved: z.infer<typeof savedMarkers> = {};
  private positions: Positions = {};
  private readonly observed = new Map<string, string>();

  project(siteId: string, userId: string | undefined, rooms: readonly Room[]): Positions {
    const key = userId ? `piik.channel.read.${siteId}.${userId}` : null;
    const changedIdentity = this.key !== key;
    if (changedIdentity) {
      this.key = key;
      this.saved = {};
      this.positions = {};
      this.observed.clear();
    }
    if (!key) return this.positions;
    if (changedIdentity || rooms.some(room => room.authorized && room.available && room.delivery
      && this.observed.get(room.id) !== room.delivery.bindingId)) this.load(key);
    return this.update(rooms, true);
  }

  refresh(rooms: readonly Room[], changedKey?: string | null): Positions {
    if (!this.key || (changedKey != null && changedKey !== this.key)) return this.positions;
    this.load(this.key);
    return this.update(rooms, false);
  }

  advance(rooms: readonly Room[], roomId: string, seq: number): Positions {
    const room = rooms.find(room => room.id === roomId && room.authorized);
    if (!this.key || !room?.available || !room.delivery || Math.min(seq, room.lastMessageSeq) <= (this.positions[roomId] ?? 0)) return this.positions;
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
      const saved = typeof record === "number" ? record : record?.seq;
      const binding = room.available ? room.delivery?.bindingId : undefined;
      let position = saved ?? this.positions[id] ?? (binding ? room.lastMessageSeq : 0);
      if (binding) {
        const entering = fromAuthority && this.observed.get(id) !== binding;
        const storedBinding = typeof record === "object" ? record.binding : undefined;
        const rebound = entering && storedBinding !== binding;
        // Only a fresh authority projection may supersede another binding.
        // Same-binding storage can be ahead of this tab's last projection.
        if (rebound) position = Math.min(position, room.lastMessageSeq);
        if (entering) this.observed.set(id, binding);
        if (entering || !storedBinding || storedBinding === binding) {
          if (advance?.roomId === id) position = Math.max(position, Math.min(advance.seq, room.lastMessageSeq));
          if (position !== saved || rebound) {
            this.saved[id] = { seq: position, binding };
            changed = true;
          }
        }
      }
      next[id] = binding ? Math.min(position, room.lastMessageSeq) : position;
    }
    if (changed && this.key) {
      try { localStorage.setItem(this.key, JSON.stringify(this.saved)); } catch { /* Volatile reading still works. */ }
    }
    if (!equalPositions(next, this.positions)) this.positions = next;
    return this.positions;
  }
}
