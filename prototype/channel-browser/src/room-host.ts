import init, { create_room_policy, RoomHost } from "../pkg/piik_channel_browser.js";
import type { ChannelMessage, ChannelRoom, ChannelSnapshot } from "../../../src/client/channel/protocol";

/** Supplied by the authenticated domain connection, never by a peer command. */
export interface RoomMember { userId: string; participates: boolean; domainOwner: boolean }
export interface NewRoomPolicy {
  id: string; name: string; creatorId: string; access: "public" | "private"; hidden: boolean; password?: string;
}
export interface AttachmentRecord { id: string; roomId: string; userId: string; committed: boolean }
interface StoredMessage extends ChannelMessage { roomId: string; nonce: string }
export interface SentResult { type: "sent"; message: ChannelMessage; inserted: boolean }
export interface PageResult {
  type: "page"; messages: ChannelMessage[]; hasMore: boolean; oldestSeq: number | null; before: number | null;
}
export type RoomSnapshot = Pick<ChannelSnapshot, "publications" | "voice" | "subscriptions"> & { room: ChannelRoom };
interface SendRequest { type: "send"; roomId: string; draft: { userId: string; nonce: string; attachments: string[] } }

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
  private constructor(private db: IDBDatabase, private room: RoomHost) {}

  static async open(databaseName: string, policy: string): Promise<BrowserRoomHost> {
    await init();
    const room = new RoomHost(policy);
    let db: IDBDatabase | undefined;
    try {
      db = await openDatabase(databaseName);
      const host = new BrowserRoomHost(db, room);
      let saved: { policy: string } | undefined;
      await host.transaction(["rooms"], "readwrite", (tx, abort) => {
        const rooms = tx.objectStore("rooms");
        read(rooms.get(room.room_id()), value => {
          saved = value;
          if (!saved) rooms.add({ id: room.room_id(), policy: room.policy() });
        }, abort);
      }, () => {});
      if (saved) { host.room = new RoomHost(saved.policy); room.free(); }
      return host;
    } catch (error) { room.free(); db?.close(); throw error; }
  }

  get roomId(): string { return this.room.room_id(); }
  exportPolicy(): string { return this.room.policy(); }
  snapshot(member: RoomMember, sessionId: string): RoomSnapshot | null {
    return JSON.parse(this.room.snapshot(JSON.stringify(member), sessionId));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("closed"));
    const result = this.tail.then(work).catch(error => { this.room.abort(); throw failure(error); });
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

  send(member: RoomMember, text: string, nonce: string, attachments: string[] = [], signal?: AbortSignal): Promise<SentResult> {
    return this.enqueue(async () => {
      const request: SendRequest = JSON.parse(this.room.begin_send(JSON.stringify(member), text, nonce,
        JSON.stringify(attachments), BigInt(Date.now())));
      return this.transaction(["messages", "attachments"], "readwrite", (tx, abort) => {
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
    });
  }

  history(member: RoomMember, before?: number, signal?: AbortSignal): Promise<PageResult> {
    return this.enqueue(async () => {
      const request: { roomId: string; before: number | null } = JSON.parse(this.room.begin_read(JSON.stringify(member),
        before === undefined ? undefined : BigInt(before)));
      const rows: StoredMessage[] = [];
      let oldest: number | undefined;
      return this.transaction(["messages"], "readonly", (tx, abort) => {
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
    });
  }

  stageAttachment(member: RoomMember, id: string): Promise<void> {
    return this.enqueue(async () => {
      this.room.authorize_attachment(JSON.stringify(member));
      return this.transaction(["attachments"], "readwrite", tx => {
        tx.objectStore("attachments").add({ id, roomId: this.roomId, userId: member.userId, committed: false });
      }, () => {});
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.tail;
    this.closing = true;
    await this.tail;
    this.db.close();
    this.room.free();
  }
}
