import { fileKeyString, type ChannelCommand, type ChannelFileKey, type ChannelRoom } from "./protocol";
import type { FileScope } from "./file-store";

interface FileObservation {
  bindingId: string;
  observationId: string;
  indices: Map<string, number>;
}

export class VisibleFileAvailability {
  private observed = new Map<string, { key: ChannelFileKey; count: number }>();
  private observationScope: FileScope | null = null;
  private observations = new Map<string, FileObservation>();
  private observationScheduled = false;

  constructor(private rooms: () => readonly ChannelRoom[],
    private command: (command: Extract<ChannelCommand, { type: "observe_files" }>) => Promise<void>,
    private changed: () => void,
    private messageRemoved: (key: ChannelFileKey) => boolean,
    private limit: () => number) {}

  observe(key: ChannelFileKey): () => void {
    const id = fileKeyString(key);
    const entry = this.observed.get(id) ?? { key, count: 0 };
    this.observed.set(id, entry);
    entry.count++;
    this.scheduleObservations();
    let released = false;
    return () => {
      if (released || this.observed.get(id) !== entry) return;
      released = true;
      if (--entry.count === 0) this.observed.delete(id);
      this.scheduleObservations();
    };
  }

  current(key: ChannelFileKey, room?: ChannelRoom): boolean | undefined {
    const id = fileKeyString(key);
    if (!room?.available || !room.reading || !this.observed.has(id)) return undefined;
    const observation = this.observations.get(key.roomId);
    const index = observation?.indices.get(id);
    const reported = room.fileAvailability;
    if (index === undefined || !observation || observation.bindingId !== room.delivery?.bindingId
      || reported?.observationId !== observation.observationId || reported.available.length !== observation.indices.size) return undefined;
    return reported.available[index];
  }

  private scheduleObservations(): void {
    if (this.observationScheduled) return;
    this.observationScheduled = true;
    queueMicrotask(() => {
      this.observationScheduled = false;
      const rooms = this.rooms();
      const limit = this.limit();
      if (!rooms.length || !limit) return;
      const keysByRoom = new Map<string, [string, ChannelFileKey][]>();
      for (const [id, { key }] of this.observed) {
        if (this.messageRemoved(key)) continue;
        const entries = keysByRoom.get(key.roomId);
        if (entries) entries.push([id, key]);
        else keysByRoom.set(key.roomId, [[id, key]]);
      }
      let changed = false;
      for (const room of rooms) {
        const bindingId = room.delivery?.bindingId;
        if (!room.authorized || !room.available || !room.reading || !room.historyLineage || !bindingId) continue;
        const entries = keysByRoom.get(room.id)?.slice(0, limit) ?? [];
        const previous = this.observations.get(room.id);
        if (previous?.bindingId === bindingId && previous.indices.size === entries.length
          && entries.every(([id], index) => previous.indices.get(id) === index)) continue;
        if (!entries.length && (!previous || previous.bindingId !== bindingId)) continue;
        const observationId = crypto.randomUUID();
        this.observations.set(room.id, { bindingId, observationId, indices: new Map(entries.map(([id], index) => [id, index])) });
        changed = true;
        void this.command({ type: "observe_files", roomId: room.id, observationId,
          keys: entries.map(([, key]) => [key.messageSeq, key.attachmentId]) }).catch(() => {
          if (this.observations.get(room.id)?.observationId !== observationId) return;
          if (previous) this.observations.set(room.id, previous);
          else this.observations.delete(room.id);
          this.changed();
        });
      }
      if (changed) this.changed();
    });
  }

  update(scope: FileScope, previous: readonly ChannelRoom[]): boolean {
    if (this.observationScope && (this.observationScope.domainId !== scope.domainId || this.observationScope.userId !== scope.userId)) {
      this.observed.clear();
    }
    this.observationScope = scope;
    const rooms = this.rooms();
    let changed = false;
    for (const [id, observation] of this.observations) {
      const room = rooms.find(room => room.id === id);
      if (!room?.authorized || !room.available || !room.reading || !room.historyLineage
        || room.delivery?.bindingId !== observation.bindingId) {
        this.observations.delete(id);
        changed = true;
        continue;
      }
      const before = previous.find(room => room.id === id)?.fileAvailability, after = room.fileAvailability;
      if (before?.observationId !== after?.observationId || before?.available.length !== after?.available.length
        || after?.available.some((available, i) => before?.available[i] !== available)) changed = true;
    }
    if (this.observed.size || this.observations.size) this.scheduleObservations();
    return changed;
  }

  disconnect(): void {
    this.observations.clear();
  }
}
