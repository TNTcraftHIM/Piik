import init, { create_room_policy, RoomHost } from "../pkg/piik_channel_browser.js";
import type { ChannelMessage, RoomSummary } from "../../../src/client/channel/protocol";

export interface NewRoomPolicy {
  id: string; name: string; creatorId: string; access: "public" | "private"; hidden: boolean; password?: string | null;
}
export interface AttachmentRecord { id: string; roomId: string; userId: string; committed: boolean }
interface RoomRecord { id: string; policy: string; bindingId?: string }
interface StoredMessage extends ChannelMessage { roomId: string; nonce: string }
export interface SentResult { type: "sent"; message: ChannelMessage; inserted: boolean }
export interface PageResult {
  type: "page"; messages: ChannelMessage[]; hasMore: boolean; oldestSeq: number | null; before: number | null;
}
interface SendRequest { type: "send"; roomId: string; draft: { userId: string; nonce: string; attachments: string[] } }
interface ReadRequest { type: "read"; roomId: string; before: number | null }
interface HostWork { policy: object | null; history: SendRequest | ReadRequest | null }

const failure = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
function read<T>(request: IDBRequest<T>, receive: (value: T) => void, abort: (error: Error) => void): void {
  request.onsuccess = () => { try { receive(request.result); } catch (error) { abort(failure(error)); } };
}
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("rooms", { keyPath: "id" });
      const messages = db.createObjectStore("messages", { keyPath: ["roomId", "seq"] });
      messages.createIndex("send", ["roomId", "userId", "nonce"], { unique: true });
      messages.createIndex("id", "id", { unique: true });
      db.createObjectStore("attachments", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

export async function createRoomPolicy(input: NewRoomPolicy): Promise<string> {
  await init();
  return create_room_policy(JSON.stringify(input));
}

/** One room's serialized authority/storage turn; DOM and network delivery stay with the caller. */
export class BrowserRoomHost {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private bindingId: string | undefined;
  private storedBindingId: string | undefined;
  private constructor(private db: IDBDatabase, private room: RoomHost) {}

  static async storedPolicies(databaseName: string): Promise<string[]> {
    const db = await openDatabase(databaseName);
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("rooms", "readonly");
        const request = tx.objectStore("rooms").getAll();
        tx.oncomplete = () => resolve(request.result.map((record: { policy: string }) => record.policy));
        tx.onabort = () => reject(tx.error ?? new Error("storage_failed"));
      });
    } finally { db.close(); }
  }

  static async open(databaseName: string, policy: string): Promise<BrowserRoomHost> {
    await init();
    const room = new RoomHost(policy);
    let db: IDBDatabase | undefined;
    try {
      db = await openDatabase(databaseName);
      const host = new BrowserRoomHost(db, room);
      let saved: RoomRecord | undefined;
      await host.transaction(["rooms"], "readwrite", (tx, abort) => {
        const rooms = tx.objectStore("rooms");
        read(rooms.get(room.room_id()), value => {
          saved = value;
          if (!saved) rooms.add({ id: room.room_id(), policy: room.policy() });
        }, abort);
      }, () => {});
      if (saved) { host.room = new RoomHost(saved.policy); room.free(); }
      host.storedBindingId = saved?.bindingId;
      return host;
    } catch (error) { room.free(); db?.close(); throw error; }
  }

  get roomId(): string { return this.room.room_id(); }
  summary(): RoomSummary { return JSON.parse(this.room.summary()); }

  /** Claim only the stored owner observed by this instance, then reload its policy. */
  bind(bindingId: string): Promise<void> {
    return this.enqueue(async () => {
      let replacement: RoomHost | undefined;
      try {
        await this.transaction(["rooms"], "readwrite", (tx, abort) => {
          const rooms = tx.objectStore("rooms");
          read<RoomRecord | undefined>(rooms.get(this.roomId), record => {
            if (!record) throw new Error("storage_failed");
            if (record.bindingId !== this.storedBindingId) throw new Error("room_host_conflict");
            if (this.bindingId !== bindingId) replacement = new RoomHost(record.policy);
            if (record.bindingId !== bindingId) rooms.put({ ...record, bindingId });
          }, abort);
        }, () => {
          if (replacement) {
            const previous = this.room;
            this.room = replacement;
            replacement = undefined;
            previous.free();
          }
          this.bindingId = bindingId;
          this.storedBindingId = bindingId;
        });
      } catch (error) {
        this.bindingId = undefined;
        replacement?.free();
        throw error;
      }
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("closed"));
    const result = this.tail.then(work).catch(error => { throw failure(error); });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private transaction<T>(stores: string[], mode: IDBTransactionMode,
    start: (tx: IDBTransaction, abort: (error: Error) => void) => void,
    complete: () => T, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
      const tx = this.db.transaction(stores, mode);
      let reason: Error | undefined;
      const abort = (error: Error) => { reason = error; tx.abort(); };
      const cancelled = () => abort(new DOMException("Cancelled", "AbortError"));
      signal?.addEventListener("abort", cancelled, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", cancelled);
      tx.onabort = () => { cleanup(); reject(reason ?? tx.error ?? new Error("storage_failed")); };
      tx.oncomplete = () => { cleanup(); try { resolve(complete()); } catch (error) { reject(failure(error)); } };
      try { start(tx, abort); } catch (error) { abort(failure(error)); }
    });
  }

  /** Read the owner and execute all work in one transaction with a competing claim. */
  private roomTransaction<T>(stores: string[], mode: IDBTransactionMode,
    start: (tx: IDBTransaction, abort: (error: Error) => void) => void,
    complete: () => T, signal?: AbortSignal): Promise<T> {
    return this.transaction(stores, mode, (tx, abort) => {
      read<RoomRecord | undefined>(tx.objectStore("rooms").get(this.roomId), record => {
        if (!this.bindingId || record?.bindingId !== this.bindingId) throw new Error("stale_room_host");
        start(tx, abort);
      }, abort);
    }, complete, signal);
  }

  dispatch(input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.enqueue(async () => {
      if (!this.bindingId || (input as { bindingId?: string } | null)?.bindingId !== this.bindingId) {
        throw new Error("stale_room_host");
      }
      const work: HostWork = JSON.parse(this.room.dispatch(JSON.stringify(input)));
      try {
        if (work.history?.type === "send") return await this.send(work.history, work.policy, signal);
        if (work.history?.type === "read") return await this.history(work.history, work.policy, signal);
        if (work.policy) return await this.roomTransaction(["rooms"], "readwrite", tx => {
          this.savePolicy(tx, work.policy!);
        }, () => JSON.parse(this.room.finish()), signal);
        return await this.roomTransaction(["rooms"], "readonly", () => {}, () => JSON.parse(this.room.finish()), signal);
      } catch (error) {
        const cause = failure(error);
        return JSON.parse(this.room.abort(cause.name === "AbortError" ? cause.name : cause.message));
      }
    });
  }

  private savePolicy(tx: IDBTransaction, policy: object | null): void {
    if (policy) tx.objectStore("rooms").put({ id: this.roomId, policy: JSON.stringify(policy), bindingId: this.bindingId });
  }

  private send(request: SendRequest, policy: object | null, signal?: AbortSignal): Promise<unknown> {
      return this.roomTransaction(["rooms", "messages", "attachments"], "readwrite", (tx, abort) => {
        this.savePolicy(tx, policy);
        const messages = tx.objectStore("messages"), files = tx.objectStore("attachments");
        const prepare = (input: object, records: AttachmentRecord[] = []) => {
          const result: Omit<SentResult, "type"> = JSON.parse(this.room.prepare_confirmation(JSON.stringify(input)));
          if (result.inserted) {
            messages.add({ ...result.message, roomId: request.roomId, nonce: request.draft.nonce });
            for (const file of records) files.put({ ...file, committed: true });
          }
        };
        read<StoredMessage | undefined>(messages.index("send").get([request.roomId, request.draft.userId, request.draft.nonce]), previous => {
          if (previous) { prepare({ type: "existing", message: previous }); return; }
          let remaining = request.draft.attachments.length + 1, lastSeq = 0;
          const records: AttachmentRecord[] = [];
          const ready = () => { if (--remaining === 0) prepare({ type: "new", lastSeq, attachments: records }, records); };
          read(messages.openCursor(IDBKeyRange.bound([request.roomId], [request.roomId, Infinity]), "prev"), cursor => {
            lastSeq = cursor?.value.seq ?? 0; ready();
          }, abort);
          for (const id of request.draft.attachments) read<AttachmentRecord | undefined>(files.get(id), file => {
            if (file) records.push(file);
            ready();
          }, abort);
        }, abort);
      }, () => JSON.parse(this.room.finish_send()), signal);
  }

  private history(request: ReadRequest, policy: object | null, signal?: AbortSignal): Promise<unknown> {
      const rows: StoredMessage[] = [];
      let oldest: number | undefined;
      return this.roomTransaction(["rooms", "messages"], policy ? "readwrite" : "readonly", (tx, abort) => {
        this.savePolicy(tx, policy);
        const messages = tx.objectStore("messages");
        const range = IDBKeyRange.bound([request.roomId], [request.roomId, request.before ?? Infinity], false, request.before !== null);
        const cursor = messages.openCursor(range, "prev");
        read(cursor, value => {
          if (!value) return;
          rows.push(value.value);
          if (rows.length < this.room.page_size() + 1) value.continue();
        }, abort);
        read(messages.openCursor(IDBKeyRange.bound([request.roomId], [request.roomId, Infinity])), value => {
          oldest = value?.value.seq;
        }, abort);
      }, () => JSON.parse(this.room.finish_read(JSON.stringify(rows), oldest === undefined ? undefined : BigInt(oldest))), signal);
  }

  async close(): Promise<void> {
    if (this.closing) return this.tail;
    this.closing = true;
    await this.tail;
    this.db.close();
    this.room.free();
  }
}
