import { fileKeyString, type ChannelAttachment, type ChannelFileKey } from "./protocol";

export const sameContent = (a: ChannelAttachment, b: ChannelAttachment) => a.size === b.size && a.sha256.toLowerCase() === b.sha256.toLowerCase();

export interface FileScope { domainId: string; userId: string }
export interface FileRetentionLimits { maxRetainedBytes: number; maxRetainedFiles: number }
export interface RetainedFile { key: ChannelFileKey; attachment: ChannelAttachment; file: File }
export interface SavedReceipt { key: ChannelFileKey; sha256: string; receipt: string }
interface StoredFile extends RetainedFile { id?: number; fileKeyString: string }
function roomKeys(roomId: string): IDBKeyRange {
  // Serialized keys start with the quoted room ID and a comma. A hyphen
  // immediately follows the comma in IndexedDB's string ordering.
  const prefix = JSON.stringify([roomId]).slice(0, -1);
  return IDBKeyRange.bound(prefix + ",", prefix + "-", true, true);
}
function roomIndex(store: IDBObjectStore): IDBIndex | IDBObjectStore {
  return store.name === "files" ? store.index("key") : store;
}

/** Participant files and their room-confirmed descriptions commit together. */
export class FileStore {
  private name: string;
  constructor(scope: FileScope) { this.name = `piik.channel.files.${scope.domainId}.${scope.userId}`; }

  private async transaction<T>(
    tables: string | string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction, result: (value: T) => void) => void,
  ): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = event => {
        if (event.oldVersion === 0) request.result.createObjectStore("files", { keyPath: "id", autoIncrement: true }).createIndex("key", "fileKeyString", { unique: true });
        request.result.createObjectStore("receipts");
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(tables, mode);
        let value: T;
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(transaction.error ?? new Error("file_storage_failed"));
        try { work(transaction, result => { value = result; }); }
        catch (error) { transaction.abort(); reject(error); }
      });
    } finally { database.close(); }
  }

  receipts(roomIds: readonly string[]): Promise<SavedReceipt[]> {
    return this.roomEntries<SavedReceipt>("receipts", roomIds);
  }

  saveReceipt(entry: SavedReceipt, allowed: () => boolean): Promise<boolean> {
    return this.transaction("receipts", "readwrite", (transaction, done) => {
      if (!allowed()) { done(false); return; }
      transaction.objectStore("receipts").put(entry, fileKeyString(entry.key));
      done(true);
    });
  }

  forgetReceipt(entry: SavedReceipt): Promise<void> {
    return this.transaction("receipts", "readwrite", (transaction, done) => {
      const store = transaction.objectStore("receipts");
      const id = fileKeyString(entry.key), request = store.get(id);
      request.onsuccess = () => {
        if (request.result?.receipt === entry.receipt) store.delete(id);
        done();
      };
    });
  }

  async list(roomIds: readonly string[]): Promise<RetainedFile[]> {
    const entries = await this.roomEntries<StoredFile>("files", roomIds);
    return entries.map(({ key, attachment, file }) => ({ key, attachment, file }));
  }

  private roomEntries<T>(table: "files" | "receipts", roomIds: readonly string[]): Promise<T[]> {
    if (!roomIds.length) return Promise.resolve([]);
    return this.transaction(table, "readonly", (transaction, done) => {
      const index = roomIndex(transaction.objectStore(table));
      const entries: T[] = [];
      let pending = roomIds.length;
      for (const roomId of roomIds) {
        const request = index.getAll(roomKeys(roomId));
        request.onsuccess = () => {
          for (const entry of request.result as T[]) entries.push(entry);
          if (--pending === 0) done(entries);
        };
      }
    });
  }

  async retain(entry: RetainedFile, limits: FileRetentionLimits, allowed: () => boolean = () => true): Promise<{ file: File | null; evicted: ChannelFileKey[] }> {
    if (entry.file.size > limits.maxRetainedBytes || limits.maxRetainedFiles < 1) return Promise.reject(new Error("file_retention_limit"));
    if (!allowed()) return { file: null, evicted: [] };
    // IndexedDB can preserve a File's dependency on its backing path. Stream
    // cacheable bytes into an independent browser Blob before releasing that path.
    const source = entry.file;
    let cancelled = false;
    const stream = source.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!allowed()) {
          cancelled = true;
          controller.error(new DOMException("Cancelled", "AbortError"));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    const blob = await new Response(stream).blob().catch(error => {
      if (cancelled) return null;
      throw error;
    });
    if (!blob) return { file: null, evicted: [] };
    const file = new File([blob], source.name, { type: source.type, lastModified: source.lastModified });
    const evicted = await this.transaction<ChannelFileKey[] | null>("files", "readwrite", (transaction, done) => {
      const store = transaction.objectStore("files");
      const request = store.getAll();
      request.onsuccess = () => {
        if (!allowed()) { done(null); return; }
        const rows = request.result as StoredFile[], key = fileKeyString(entry.key);
        const previous = rows.find(row => row.fileKeyString === key);
        const retained = rows.filter(row => row !== previous);
        let bytes = retained.reduce((total, row) => total + row.file.size, entry.file.size);
        const evicted: ChannelFileKey[] = [];
        while (retained.length + 1 > limits.maxRetainedFiles || bytes > limits.maxRetainedBytes) {
          const oldest = retained.shift()!;
          store.delete(oldest.id!); bytes -= oldest.file.size; evicted.push(oldest.key);
        }
        const put = store.put({ ...entry, file, fileKeyString: key, ...(previous ? { id: previous.id } : {}) } satisfies StoredFile);
        put.onsuccess = () => done(evicted);
      };
    });
    return evicted ? { file, evicted } : { file: null, evicted: [] };
  }

  remove(key: ChannelFileKey, attachment: ChannelAttachment, { forgetReceipt = false } = {}): Promise<void> {
    return this.transaction<void>(forgetReceipt ? ["files", "receipts"] : "files", "readwrite", transaction => {
      const id = fileKeyString(key);
      const file = transaction.objectStore("files").index("key").openCursor(id);
      file.onsuccess = () => {
        const cursor = file.result;
        if (cursor && sameContent(cursor.value.attachment, attachment)) cursor.delete();
      };
      if (forgetReceipt) {
        const receipt = transaction.objectStore("receipts").openCursor(id);
        receipt.onsuccess = () => {
          const cursor = receipt.result;
          if (cursor && cursor.value.sha256 === attachment.sha256.toLowerCase()) cursor.delete();
        };
      }
    });
  }

  removeMessages(roomId: string, removed: (seq: number) => boolean): Promise<void> {
    return this.transaction<void>(["files", "receipts"], "readwrite", transaction => {
      const range = roomKeys(roomId);
      for (const name of transaction.objectStoreNames) {
        const request = roomIndex(transaction.objectStore(name)).openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const { key } = cursor.value as StoredFile | SavedReceipt;
          if (removed(key.messageSeq)) cursor.delete();
          cursor.continue();
        };
      }
    });
  }
}
