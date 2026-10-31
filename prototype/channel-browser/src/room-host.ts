import init, { attachment_result, conversation_replies, create_room_policy, history_page, history_page_size, prepare_confirmation, RoomHost, SessionSigner } from "../pkg/piik_channel_browser.js";
export { AttachmentHash, FileDelivery, attachment_limits, attachment_media_type, decode_control, encode_control, route_conversation, route_input, input_binding_current, verify_reply } from "../pkg/piik_channel_browser.js";
export async function initializeFiles(): Promise<void> { await init(); }
export async function createSessionSigner(seed: Uint8Array): Promise<SessionSigner> { await init(); return new SessionSigner(seed); }
import type { ChannelMessage, ConversationAddress, ConversationReply, RoomSettings, RoomSummary, SignedConversationPacket } from "../../../src/client/channel/protocol";

export interface NewRoomPolicy extends RoomSettings {
  id: string; creatorId: string;
}
interface RoomRecord { id: string; policy: string; bindingId?: string }
interface StoredMessage extends ChannelMessage { roomId: string; nonce: string }
export interface SentResult { type: "sent"; message: ChannelMessage; inserted: boolean }
export interface PageResult {
  type: "page"; messages: ChannelMessage[]; hasMore: boolean; oldestSeq: number | null; before: number | null;
}
interface AttachmentResult { type: "attachment"; messageSeq: number; attachment: ChannelMessage["attachments"][number] }
type HistoryResult = SentResult | PageResult | AttachmentResult;
interface SendRequest { type: "send"; roomId: string; draft: { userId: string; nonce: string; text: string; time: number; attachments: ChannelMessage["attachments"] } }
interface ReadRequest { type: "read"; roomId: string; before: number | null }
interface AttachmentRequest { type: "attachment"; roomId: string; messageSeq: number; attachmentId: string }
type HistoryRequest = SendRequest | ReadRequest | AttachmentRequest;
interface HostWork { policy: object | null; history: HistoryRequest | null }
type HistoryOutcome = { Ok: HistoryRequest } | { Err: string };

const failure = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
function read<T>(request: IDBRequest<T>, receive: (value: T) => void, abort: (error: Error) => void): void {
  request.onsuccess = () => { try { receive(request.result); } catch (error) { abort(failure(error)); } };
}
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    let unsupported = false;
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) { unsupported = true; request.transaction!.abort(); return; }
      const db = request.result;
      db.createObjectStore("rooms", { keyPath: "id" });
      const messages = db.createObjectStore("messages", { keyPath: ["roomId", "seq"] });
      messages.createIndex("send", ["roomId", "userId", "nonce"], { unique: true });
      messages.createIndex("id", "id", { unique: true });
    };
    request.onerror = () => reject(unsupported ? new Error("unsupported_storage_version") : request.error);
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
  currentReaders(): string[] { return JSON.parse(this.room.current_readers()); }

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
        let result: HistoryResult | undefined;
        if (work.history) result = await this.executeHistory(work.history, work.policy, signal);
        else await this.roomTransaction(["rooms"], work.policy ? "readwrite" : "readonly", tx => {
          this.savePolicy(tx, work.policy);
        }, () => {}, signal);
        return JSON.parse(this.room.finish(result && JSON.stringify(result)));
      } catch (error) {
        const cause = failure(error);
        return JSON.parse(this.room.abort(cause.name === "AbortError" ? cause.name : cause.message));
      }
    });
  }

  dispatchPeer(packet: SignedConversationPacket, now: number, signal?: AbortSignal): Promise<ConversationReply[]> {
    return this.enqueue(async () => {
      if (!this.bindingId) throw new Error("stale_room_host");
      const prepared: { address: ConversationAddress; history: HistoryOutcome } = JSON.parse(this.room.prepare_peer(JSON.stringify(packet), BigInt(now)));
      let result: { Ok: HistoryResult } | { Err: string };
      try {
        if ("Err" in prepared.history) {
          await this.roomTransaction(["rooms"], "readonly", () => {}, () => {}, signal);
          result = prepared.history;
        } else result = { Ok: await this.executeHistory(prepared.history.Ok, null, signal) };
      } catch (error) {
        const cause = failure(error);
        result = { Err: cause.name === "AbortError" ? cause.name : cause.message };
      }
      return JSON.parse(conversation_replies(JSON.stringify(prepared.address), JSON.stringify(result)));
    });
  }

  private savePolicy(tx: IDBTransaction, policy: object | null): void {
    if (policy) tx.objectStore("rooms").put({ id: this.roomId, policy: JSON.stringify(policy), bindingId: this.bindingId });
  }

  private executeHistory(request: HistoryRequest, policy: object | null, signal?: AbortSignal): Promise<HistoryResult> {
    const rows: StoredMessage[] = [];
    let oldest: number | undefined, result: HistoryResult;
    return this.roomTransaction(["rooms", "messages"], request.type === "send" || policy ? "readwrite" : "readonly", (tx, abort) => {
      this.savePolicy(tx, policy);
      const messages = tx.objectStore("messages");
      if (request.type === "send") {
        const prepare = (input: object) => {
          const confirmation: SentResult = JSON.parse(prepare_confirmation(JSON.stringify(request.draft), JSON.stringify(input)));
          if (confirmation.inserted) messages.add({ ...confirmation.message, roomId: request.roomId, nonce: request.draft.nonce });
          result = confirmation;
        };
        read<StoredMessage | undefined>(messages.index("send").get([request.roomId, request.draft.userId, request.draft.nonce]), previous => {
          if (previous) { prepare({ type: "existing", message: previous }); return; }
          read(messages.openCursor(IDBKeyRange.bound([request.roomId], [request.roomId, Infinity]), "prev"), cursor => {
            prepare({ type: "new", lastSeq: cursor?.value.seq ?? 0 });
          }, abort);
        }, abort);
      } else if (request.type === "attachment") {
        read<StoredMessage | undefined>(messages.get([request.roomId, request.messageSeq]), value => {
          result = JSON.parse(attachment_result(JSON.stringify(request), JSON.stringify(value ?? null)));
        }, abort);
      } else {
        const range = IDBKeyRange.bound([request.roomId], [request.roomId, request.before ?? Infinity], false, request.before !== null);
        const cursor = messages.openCursor(range, "prev");
        read(cursor, value => {
          if (!value) return;
          rows.push(value.value);
          if (rows.length < history_page_size() + 1) value.continue();
        }, abort);
        read(messages.openCursor(IDBKeyRange.bound([request.roomId], [request.roomId, Infinity])), value => {
          oldest = value?.value.seq;
        }, abort);
      }
    }, () => request.type === "read"
      ? JSON.parse(history_page(JSON.stringify(rows), oldest === undefined ? undefined : BigInt(oldest), request.before === null ? undefined : BigInt(request.before)))
      : result, signal);
  }

  async close(): Promise<void> {
    if (this.closing) return this.tail;
    this.closing = true;
    await this.tail;
    this.db.close();
    this.room.free();
  }
}
