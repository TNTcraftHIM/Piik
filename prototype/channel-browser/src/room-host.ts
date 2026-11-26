import init, { attachment_result, backup_message_reply, create_room_policy, HistoryPage, history_page_size, message_retry_key, prepare_confirmation, reaction_result, RoomHost, SessionSigner } from "../pkg/piik_channel_browser.js";
export { AttachmentHash, BackupHistoryImport, CopyHistoryImport, DomainArchiveCheck, FileDelivery, ForwardingBudget, WatchDelivery, file_availability_limit, attachment_limits, attachment_media_type, backup_metadata, backup_record_bytes, message_mention_limit, decode_control, encode_control, verify_conversation, route_input, input_binding_current } from "../pkg/piik_channel_browser.js";
let initialization: Promise<void> | undefined;
export function initializeRuntime(): Promise<void> {
  return initialization ??= init().then(() => {}, error => {
    initialization = undefined;
    throw error;
  });
}
export async function createSessionSigner(seed: Uint8Array): Promise<SessionSigner> { await initializeRuntime(); return new SessionSigner(seed); }
import type { ChannelMessage, ChatOptions, ConversationAddress, ConversationReply, RoomSettings, RoomSummary, SignedConversationPacket, ReactionEvent, MessageReactions } from "../../../src/client/channel/protocol";
import { validBackupSequence, type BackupHistoryRow, type BrowserRoomSnapshot, type BrowserRoomStage, type HostedRoom, type PeerDelivery } from "./hosting-contract";

export interface NewRoomPolicy extends RoomSettings {
  id: string; creatorId: string;
}
interface RoomRecord { id: string; policy: string; historyLineage: string; bindingId?: string; clearedThrough?: number }
function savedRoom(record: RoomRecord, id: string): RoomHost {
  const room = new RoomHost(record.policy);
  if (room.room_id() === id) return room;
  room.free();
  throw new Error("invalid_room_policy");
}
interface RetainedMessage extends ChannelMessage { reactions: MessageReactions }
type StoredRow = BackupHistoryRow & { roomId: string; retryKey: string };
function indexed(row: BackupHistoryRow) { return "id" in row ? { ...row, retryKey: message_retry_key(row.userId, row.nonce) } : row; }
function portable(row: BackupHistoryRow & { retryKey: string }): BackupHistoryRow {
  if (!("id" in row)) return row;
  const { retryKey: _retryKey, ...message } = row;
  return message;
}
function live(row: StoredRow | undefined) { return row && "id" in row ? row : undefined; }
export interface SentResult { type: "sent"; message: RetainedMessage; inserted: boolean }
export interface PageResult {
  type: "page"; messages: RetainedMessage[]; hasMore: boolean; oldestSeq: number | null; before: number | null;
}
interface AttachmentResult { type: "attachment"; messageSeq: number; attachment: ChannelMessage["attachments"][number] }
interface ReactionResult { type: "reacted"; nonce: number; snapshot: MessageReactions & { messageId: string; messageSeq: number }; event: ReactionEvent | null }
type HistoryResult = SentResult | PageResult | AttachmentResult | ReactionResult | { type: "message_deleted"; messageSeq: number } | { type: "history_cleared"; throughSeq: number }
  | { type: "seek"; after: number; seq: number | null };
interface SendRequest { type: "send"; roomId: string; draft: ChatOptions & { userId: string; nonce: string; text: string; time: number; attachments: ChannelMessage["attachments"]; inlineImages?: ChannelMessage["inlineImages"] } }
interface ReadRequest { type: "read"; roomId: string; before: number | null }
interface AttachmentRequest { type: "attachment"; roomId: string; messageSeq: number; attachmentId: string }
interface ReactionRequest { type: "react"; roomId: string; messageSeq: number; nonce: number; event: ReactionEvent | null }
type HistoryRequest = SendRequest | ReadRequest | AttachmentRequest | ReactionRequest
  | { type: "seek"; roomId: string; after: number; excludeAuthor: string }
  | { type: "delete_message"; roomId: string; messageSeq: number; messageId: string; authorId?: string | null }
  | { type: "clear_history"; roomId: string; throughSeq: number };
interface HostWork { policy: object | null; history: HistoryRequest | null; delete: boolean }
type ConversationWork = { type: "history"; value: HistoryRequest } | { type: "immediate"; value: ConversationReply["record"] };
type ConversationResult = { type: "history"; value: HistoryResult } | { type: "immediate"; value: ConversationReply["record"] };

const failure = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
function roomErrorCode(error: unknown): string {
  if (error instanceof DOMException) return error.name === "AbortError" ? error.name : "storage_failed";
  return failure(error).message || "storage_failed";
}
function read<T>(request: IDBRequest<T>, receive: (value: T) => void, abort: (error: Error) => void): void {
  request.onsuccess = () => { try { receive(request.result); } catch (error) { abort(failure(error)); } };
}
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 9);
    let unsupported = false;
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) { unsupported = true; request.transaction!.abort(); return; }
      const db = request.result;
      db.createObjectStore("rooms", { keyPath: "id" });
      const messages = db.createObjectStore("messages", { keyPath: ["roomId", "seq"] });
      messages.createIndex("send", ["roomId", "retryKey"], { unique: true });
      messages.createIndex("id", "id", { unique: true });
      const backup = db.createObjectStore("backup", { keyPath: "seq" });
      backup.createIndex("send", "retryKey", { unique: true });
      backup.createIndex("id", "id", { unique: true });
    };
    // VersionError: a newer build already raised the stored version past this one.
    request.onerror = () => reject(unsupported || request.error?.name === "VersionError" ? new Error("unsupported_storage_version") : request.error);
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

interface RoomTransactionOptions extends IDBTransactionOptions { signal?: AbortSignal }

function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  start: (tx: IDBTransaction, abort: (error: Error) => void) => void,
  complete: () => T, { signal, durability }: RoomTransactionOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
    const tx = db.transaction(stores, mode, { durability });
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

interface BackupMarker { seq: 0; stageId: string }

// One replaceable work slot per participant database. Interrupted work leaves
// at most one temporary history, reused by the next operation without a GC owner.
class RoomBackup implements BrowserRoomSnapshot, BrowserRoomStage {
  readonly stageId = crypto.randomUUID();
  private closed: Promise<void> | undefined;
  constructor(private db: IDBDatabase, readonly policy: string, readonly roomId: string, private readonly storedBindingId?: string) {}

  private turn<T>(stores: string[], mode: IDBTransactionMode,
    start: (tx: IDBTransaction, abort: (error: Error) => void) => void,
    complete: () => T, options?: RoomTransactionOptions): Promise<T> {
    if (this.closed) return Promise.reject(new Error("closed"));
    return transaction(this.db, stores, mode, (tx, abort) => {
      read<BackupMarker | undefined>(tx.objectStore("backup").get(0), marker => {
        if (marker?.stageId !== this.stageId) throw new Error("stale_backup");
        start(tx, abort);
      }, abort);
    }, complete, options);
  }

  initialize(tx: IDBTransaction): void {
    const store = tx.objectStore("backup");
    store.clear();
    store.put({ seq: 0, stageId: this.stageId } satisfies BackupMarker);
  }

  append(row: BackupHistoryRow): Promise<void> {
    if (!validBackupSequence(row.seq)) return Promise.reject(new Error("invalid_backup_history"));
    return this.turn(["backup"], "readwrite", (tx, abort) => {
      const store = tx.objectStore("backup");
      if (!("id" in row) || !row.reply) { store.add(indexed(row)); return; }
      const { reply, ...message } = row;
      read(store.get(reply.seq), target => {
        const original = live(target);
        if (!original) { store.add(indexed(message)); return; }
        const quote = backup_message_reply(BigInt(original.seq), original.userId, original.text, original.archivedAuthorName, reply.notify);
        store.add(indexed({ ...message, reply: JSON.parse(quote) }));
      }, abort);
    }, () => {});
  }

  get rows(): AsyncIterable<BackupHistoryRow> { return this.readRows(); }
  private async *readRows(): AsyncGenerator<BackupHistoryRow> {
    let after = 0;
    for (;;) {
      const rows: BackupHistoryRow[] = [];
      await this.turn(["backup"], "readonly", (tx, abort) => {
        read(tx.objectStore("backup").openCursor(IDBKeyRange.lowerBound(after, true)), cursor => {
          if (!cursor) return;
          rows.push(portable(cursor.value));
          if (rows.length < history_page_size()) cursor.continue();
        }, abort);
      }, () => {});
      if (!rows.length) return;
      for (const row of rows) { after = row.seq; yield row; }
      // Even the final empty page checks the marker, so superseded streams fail
      // explicitly rather than silently finishing with somebody else's rows.
    }
  }

  replace(signal?: AbortSignal): Promise<void> {
    return this.install({ id: this.roomId, policy: this.policy }, false, signal);
  }

  async createRoom(policy: string, signal?: AbortSignal): Promise<void> {
    const room = new RoomHost(policy);
    try {
      await this.install({ id: room.room_id(), policy: room.policy() }, true, signal);
    } finally { room.free(); }
  }

  private install(target: Pick<RoomRecord, "id" | "policy">, create: boolean, signal?: AbortSignal): Promise<void> {
    return this.turn(["backup", "rooms", "messages"], "readwrite", (tx, abort) => {
      const rooms = tx.objectStore("rooms"), messages = tx.objectStore("messages");
      read<RoomRecord | undefined>(rooms.get(target.id), record => {
        if (create ? record !== undefined : record?.bindingId !== this.storedBindingId) throw new Error("room_host_conflict");
        if (!create) messages.delete(IDBKeyRange.bound([target.id], [target.id, Infinity]));
        let firstLive: number | undefined;
        let lastSeq = 0;
        read(tx.objectStore("backup").openCursor(IDBKeyRange.lowerBound(0, true)), cursor => {
          if (!cursor) {
            const clearedThrough = firstLive === undefined ? lastSeq : firstLive - 1;
            const installed = { ...target, historyLineage: crypto.randomUUID(), clearedThrough };
            // Retire the prior durable write binding in the same commit as the data.
            if (create) rooms.add(installed);
            else rooms.put(installed);
            tx.objectStore("backup").clear();
            return;
          }
          const row: StoredRow = cursor.value;
          lastSeq = row.seq;
          if (live(row)) firstLive ??= row.seq;
          messages.add({ ...row, roomId: target.id });
          cursor.continue();
        }, abort);
      }, abort);
    }, () => {}, { signal, durability: "strict" });
  }

  close(): Promise<void> {
    return this.closed ??= transaction(this.db, ["backup"], "readwrite", (tx, abort) => {
      read<BackupMarker | undefined>(tx.objectStore("backup").get(0), marker => {
        if (marker?.stageId === this.stageId) tx.objectStore("backup").clear();
      }, abort);
    }, () => {}).finally(() => this.db.close());
  }
}

export async function createRoomPolicy(input: NewRoomPolicy): Promise<string> {
  await initializeRuntime();
  return create_room_policy(JSON.stringify(input));
}

/** One room's serialized authority/storage turn; DOM and network delivery stay with the caller. */
export class BrowserRoomHost implements HostedRoom {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private bindingId: string | undefined;
  private storedBindingId: string | undefined;
  private constructor(private db: IDBDatabase, private room: RoomHost) {}

  static async storedRoomIds(databaseName: string): Promise<string[]> {
    const db = await openDatabase(databaseName);
    try {
      let request: IDBRequest<IDBValidKey[]>;
      return await transaction(db, ["rooms"], "readonly", tx => {
        request = tx.objectStore("rooms").getAllKeys();
      }, () => request.result.filter((key): key is string => typeof key === "string"));
    } finally { db.close(); }
  }

  static async open(databaseName: string, policy: string): Promise<BrowserRoomHost> {
    await initializeRuntime();
    const room = new RoomHost(policy);
    return this.loadRoom(databaseName, room.room_id(), room);
  }

  static async openExisting(databaseName: string, id: string): Promise<BrowserRoomHost> {
    await initializeRuntime();
    return this.loadRoom(databaseName, id);
  }

  private static async loadRoom(databaseName: string, id: string, room?: RoomHost): Promise<BrowserRoomHost> {
    let db: IDBDatabase | undefined;
    try {
      db = await openDatabase(databaseName);
      let saved: RoomRecord | undefined;
      await transaction(db, ["rooms"], room ? "readwrite" : "readonly", (tx, abort) => {
        const rooms = tx.objectStore("rooms");
        read(rooms.get(id), value => {
          saved = value;
          if (!saved && room) rooms.add({ id, policy: room.policy(), historyLineage: crypto.randomUUID() } satisfies RoomRecord);
        }, abort);
      }, () => {}, { durability: room ? "strict" : undefined });
      if (saved) { const previous = room; room = savedRoom(saved, id); previous?.free(); }
      if (!room) throw new Error("room_not_found");
      const host = new BrowserRoomHost(db, room);
      host.storedBindingId = saved?.bindingId;
      return host;
    } catch (error) { room?.free(); db?.close(); throw error; }
  }

  get roomId(): string { return this.room.room_id(); }
  summary(): Promise<RoomSummary> { return this.enqueue(() => JSON.parse(this.room.summary())); }
  broadcastRecipients(requester: string): Promise<string[]> {
    return this.enqueue(() => JSON.parse(this.room.broadcast_recipients(requester)));
  }

  /** Capture persisted policy and complete history at one IndexedDB commit. */
  snapshot(signal?: AbortSignal): Promise<BrowserRoomSnapshot> {
    return this.enqueue(async () => {
      const db = await openDatabase(this.db.name);
      let snapshot: RoomBackup | undefined;
      try {
        await transaction(db, ["rooms", "messages", "backup"], "readwrite", (tx, abort) => {
          read<RoomRecord | undefined>(tx.objectStore("rooms").get(this.roomId), record => {
            if (!record) throw new Error("storage_failed");
            snapshot = new RoomBackup(db, record.policy, this.roomId);
            snapshot.initialize(tx);
            read(tx.objectStore("messages").openCursor(IDBKeyRange.bound([this.roomId], [this.roomId, Infinity])), cursor => {
              if (!cursor) return;
              const { roomId: _roomId, ...row } = cursor.value as StoredRow;
              tx.objectStore("backup").add(row);
              cursor.continue();
            }, abort);
          }, abort);
        }, () => {}, { signal });
        return snapshot!;
      } catch (error) { db.close(); throw error; }
    });
  }

  /** The archive owner supplies a Core-validated policy and canonical rows. */
  static async stage(databaseName: string, policy: string): Promise<BrowserRoomStage> {
    await initializeRuntime();
    const roomId: string = JSON.parse(policy).id;
    const db = await openDatabase(databaseName);
    let stage: RoomBackup | undefined;
    try {
      await transaction(db, ["rooms", "backup"], "readwrite", (tx, abort) => {
        read<RoomRecord | undefined>(tx.objectStore("rooms").get(roomId), record => {
          stage = new RoomBackup(db, policy, roomId, record?.bindingId);
          stage.initialize(tx);
        }, abort);
      }, () => {});
      return stage!;
    } catch (error) { db.close(); throw error; }
  }

  /** Claim only the stored owner observed by this instance, then reload its policy. */
  bind(bindingId: string): Promise<void> {
    return this.enqueue(async () => {
      let replacement: RoomHost | undefined;
      try {
        await this.transaction(["rooms", "messages"], "readwrite", (tx, abort) => {
          const rooms = tx.objectStore("rooms");
          read<RoomRecord | undefined>(rooms.get(this.roomId), record => {
            if (!record) throw new Error("storage_failed");
            if (record.bindingId !== this.storedBindingId) throw new Error("room_host_conflict");
            if (this.bindingId !== bindingId) {
              replacement = savedRoom(record, this.roomId);
              read(tx.objectStore("messages").openCursor(IDBKeyRange.bound([this.roomId], [this.roomId, Infinity]), "prev"), cursor => {
                replacement!.seed_history(record.historyLineage, BigInt(cursor?.value.seq ?? 0));
              }, abort);
            }
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

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("closed"));
    const result = this.tail.then(work).catch(error => { throw failure(error); });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private transaction<T>(stores: string[], mode: IDBTransactionMode,
    start: (tx: IDBTransaction, abort: (error: Error) => void) => void,
    complete: () => T, signal?: AbortSignal): Promise<T> {
    return transaction(this.db, stores, mode, start, complete, { signal, durability: mode === "readwrite" ? "strict" : undefined });
  }

  /** Read the owner and execute all work in one transaction with a competing claim. */
  private roomTransaction<T>(stores: string[], mode: IDBTransactionMode,
    start: (tx: IDBTransaction, abort: (error: Error) => void, record: RoomRecord) => void,
    complete: () => T, signal?: AbortSignal): Promise<T> {
    return this.transaction(stores, mode, (tx, abort) => {
      read<RoomRecord | undefined>(tx.objectStore("rooms").get(this.roomId), record => {
        if (!this.bindingId || record?.bindingId !== this.bindingId) throw new Error("stale_room_host");
        start(tx, abort, record);
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
        if (work.delete) {
          await this.roomTransaction(["rooms", "messages"], "readwrite", tx => {
            tx.objectStore("rooms").delete(this.roomId);
            tx.objectStore("messages").delete(IDBKeyRange.bound([this.roomId], [this.roomId, Infinity]));
          }, () => {}, signal);
          this.bindingId = undefined;
        } else if (work.history) result = await this.executeHistory(work.history, work.policy, signal);
        else await this.roomTransaction(["rooms"], work.policy ? "readwrite" : "readonly", (tx, _abort, record) => {
          this.savePolicy(tx, record, work.policy);
        }, () => {}, signal);
        return JSON.parse(this.room.finish(result && JSON.stringify(result)));
      } catch (error) {
        return JSON.parse(this.room.abort(roomErrorCode(error)));
      }
    });
  }

  dispatchPeer(packet: SignedConversationPacket, now: number, signal?: AbortSignal, publish?: (output: unknown) => void): Promise<PeerDelivery> {
    return this.enqueue(async () => {
      if (!this.bindingId) throw new Error("stale_room_host");
      const prepared: { address: ConversationAddress; work: { Ok: ConversationWork } | { Err: string } } = JSON.parse(this.room.prepare_peer(JSON.stringify(packet), BigInt(now)));
      const work = prepared.work;
      let result: { Ok: ConversationResult } | { Err: string };
      try {
        if ("Err" in work) {
          await this.roomTransaction(["rooms"], "readonly", () => {}, () => {}, signal);
          result = work;
        } else if (work.Ok.type === "immediate") {
          await this.roomTransaction(["rooms"], "readonly", () => {}, () => {}, signal);
          result = { Ok: work.Ok };
        } else result = { Ok: { type: "history", value: await this.executeHistory(work.Ok.value, null, signal) } };
      } catch (error) {
        result = { Err: roomErrorCode(error) };
      }
      const { replies, broadcast, projectionUpdate }: PeerDelivery & { projectionUpdate: unknown } = JSON.parse(
        this.room.finish_peer(JSON.stringify(prepared.address), JSON.stringify(result)));
      if (projectionUpdate) publish?.(projectionUpdate);
      return { replies, broadcast };
    });
  }

  private savePolicy(tx: IDBTransaction, record: RoomRecord, policy: object | null, clearedThrough = record.clearedThrough): void {
    if (policy || clearedThrough !== record.clearedThrough) {
      tx.objectStore("rooms").put({ ...record, policy: policy ? JSON.stringify(policy) : record.policy, clearedThrough });
    }
  }

  private executeHistory(request: HistoryRequest, policy: object | null, signal?: AbortSignal): Promise<HistoryResult> {
    let page = request.type === "read" ? new HistoryPage() : undefined;
    let oldest: number | undefined, result: HistoryResult;
    return this.roomTransaction(["rooms", "messages"], request.type === "send" || request.type === "delete_message" || request.type === "clear_history" || request.type === "react" && request.event !== null || policy ? "readwrite" : "readonly", (tx, abort, record) => {
      const clearedThrough = record.clearedThrough ?? 0;
      this.savePolicy(tx, record, policy, request.type === "clear_history"
        ? Math.max(clearedThrough, request.throughSeq) : record.clearedThrough);
      const messages = tx.objectStore("messages");
      if (request.type === "send") {
        const retryKey = message_retry_key(request.draft.userId, request.draft.nonce);
        const prepare = (input: object) => {
          const confirmation: SentResult = JSON.parse(prepare_confirmation(JSON.stringify(request.draft), JSON.stringify(input)));
          if (confirmation.inserted) messages.add({ ...confirmation.message, roomId: request.roomId, nonce: request.draft.nonce, retryKey });
          result = confirmation;
        };
        read<StoredRow | undefined>(messages.index("send").get([request.roomId, retryKey]), previous => {
          if (previous && !live(previous)) throw new Error("message_unavailable");
          if (previous) { prepare({ type: "existing", message: previous }); return; }
          read(messages.openCursor(IDBKeyRange.bound([request.roomId], [request.roomId, Infinity]), "prev"), cursor => {
            const lastSeq = cursor?.value.seq ?? 0;
            if (request.draft.reply) {
              read<StoredRow | undefined>(messages.get([request.roomId, request.draft.reply.seq]), reply => {
                prepare({ type: "new", lastSeq, reply: live(reply) ?? null });
              }, abort);
            } else prepare({ type: "new", lastSeq });
          }, abort);
        }, abort);
      } else if (request.type === "delete_message" || request.type === "clear_history") {
        const single = request.type === "delete_message";
        const through = single ? request.messageSeq : request.throughSeq;
        result = single ? { type: "message_deleted", messageSeq: through } : { type: "history_cleared", throughSeq: through };
        if (!single && through <= clearedThrough) return;
        const range = IDBKeyRange.bound([request.roomId, single ? through : clearedThrough], [request.roomId, Infinity], !single);
        let found = false;
        read(messages.openCursor(range), cursor => {
          if (!cursor) {
            if (single && !found) throw new Error("message_unavailable");
            return;
          }
          const row: StoredRow = cursor.value;
          if (row.seq <= through) {
            found = true;
            const message = live(row);
            if (single && message?.id !== request.messageId) throw new Error("message_unavailable");
            if (message) {
              if (single && request.authorId && request.authorId !== message.userId) throw new Error("forbidden");
              cursor.update({ roomId: row.roomId, seq: row.seq, retryKey: row.retryKey });
            }
          } else {
            if (single && !found) throw new Error("message_unavailable");
            const message = live(row);
            if (message?.reply && (single ? message.reply.seq === through : message.reply.seq <= through)) {
              delete message.reply;
              cursor.update(message);
            }
          }
          cursor.continue();
        }, abort);
      } else if (request.type === "react") {
        read<StoredRow | undefined>(messages.get([request.roomId, request.messageSeq]), previous => {
          const confirmation: ReactionResult = JSON.parse(reaction_result(JSON.stringify(request), JSON.stringify(live(previous) ?? null)));
          if (confirmation.event) messages.put({ ...previous!, reactions: {
            revision: confirmation.snapshot.revision, counts: confirmation.snapshot.counts,
          } });
          result = confirmation;
        }, abort);
      } else if (request.type === "attachment") {
        read<StoredRow | undefined>(messages.get([request.roomId, request.messageSeq]), value => {
          result = JSON.parse(attachment_result(JSON.stringify(request), JSON.stringify(live(value) ?? null)));
        }, abort);
      } else if (request.type === "seek") {
        const range = IDBKeyRange.bound([request.roomId, Math.max(request.after, clearedThrough)], [request.roomId, Infinity], true);
        read(messages.openCursor(range), cursor => {
          const message = live(cursor?.value);
          if (cursor && (!message || message.userId === request.excludeAuthor)) cursor.continue();
          else result = { type: "seek", after: request.after, seq: message?.seq ?? null };
        }, abort);
      } else {
        const lower = [request.roomId, clearedThrough];
        if (request.before === null || request.before > clearedThrough) {
          const range = IDBKeyRange.bound(lower, [request.roomId, request.before ?? Infinity], true, request.before !== null);
          read(messages.openCursor(range, "prev"), value => {
            if (!value) return;
            if (!live(value.value) || page!.push(JSON.stringify(value.value))) value.continue();
          }, abort);
        }
        read(messages.openCursor(IDBKeyRange.bound(lower, [request.roomId, Infinity], true)), value => {
          if (value && !live(value.value)) value.continue();
          else oldest = value?.value.seq;
        }, abort);
      }
    }, () => {
      if (request.type !== "read") return result;
      const current = page!; page = undefined;
      return JSON.parse(current.finish(oldest === undefined ? undefined : BigInt(oldest), request.before === null ? undefined : BigInt(request.before)));
    }, signal).finally(() => page?.free());
  }

  async close(): Promise<void> {
    if (this.closing) return this.tail;
    this.closing = true;
    await this.tail;
    this.db.close();
    this.room.free();
  }
}
