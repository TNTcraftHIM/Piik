import type { ChannelAttachment, ChannelFileKey } from "./protocol";

export interface FileScope { domainId: string; userId: string }
export interface FileRetentionLimits { maxRetainedBytes: number; maxRetainedFiles: number }
export interface RetainedFile { key: ChannelFileKey; attachment: ChannelAttachment; file: File }
export interface SavedReceipt { key: ChannelFileKey; sha256: string; receipt: string }
interface StoredFile extends RetainedFile { id?: number; cacheKey: string }
const cacheKey = (key: ChannelFileKey) => JSON.stringify([key.roomId, key.messageSeq, key.attachmentId]);

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
        if (event.oldVersion === 0) request.result.createObjectStore("files", { keyPath: "id", autoIncrement: true }).createIndex("key", "cacheKey", { unique: true });
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

  receipts(): Promise<SavedReceipt[]> {
    return this.transaction("receipts", "readonly", (transaction, done) => {
      const request = transaction.objectStore("receipts").getAll();
      request.onsuccess = () => done(request.result as SavedReceipt[]);
    });
  }

  saveReceipt(entry: SavedReceipt, allowed: () => boolean): Promise<boolean> {
    return this.transaction("receipts", "readwrite", (transaction, done) => {
      if (!allowed()) { done(false); return; }
      transaction.objectStore("receipts").put(entry, cacheKey(entry.key));
      done(true);
    });
  }

  forgetReceipt(entry: SavedReceipt): Promise<void> {
    return this.transaction("receipts", "readwrite", (transaction, done) => {
      const store = transaction.objectStore("receipts");
      const id = cacheKey(entry.key), request = store.get(id);
      request.onsuccess = () => {
        if (request.result?.receipt === entry.receipt) store.delete(id);
        done();
      };
    });
  }

  list(): Promise<RetainedFile[]> {
    return this.transaction("files", "readonly", (transaction, done) => {
      const request = transaction.objectStore("files").getAll();
      request.onsuccess = () => done((request.result as StoredFile[]).map(({ key, attachment, file }) => ({ key, attachment, file })));
    });
  }

  async retain(entry: RetainedFile, limits: FileRetentionLimits, allowed?: () => boolean): Promise<{ file: File | null; evicted: ChannelFileKey[] }> {
    if (entry.file.size > limits.maxRetainedBytes || limits.maxRetainedFiles < 1) return Promise.reject(new Error("file_retention_limit"));
    const evicted = await this.transaction<ChannelFileKey[] | null>("files", "readwrite", (transaction, done) => {
      const store = transaction.objectStore("files");
      const request = store.getAll();
      request.onsuccess = () => {
        if (allowed && !allowed()) { done(null); return; }
        const rows = request.result as StoredFile[], key = cacheKey(entry.key);
        const previous = rows.find(row => row.cacheKey === key);
        const retained = rows.filter(row => row !== previous);
        let bytes = retained.reduce((total, row) => total + row.file.size, entry.file.size);
        const evicted: ChannelFileKey[] = [];
        while (retained.length + 1 > limits.maxRetainedFiles || bytes > limits.maxRetainedBytes) {
          const oldest = retained.shift()!;
          store.delete(oldest.id!); bytes -= oldest.file.size; evicted.push(oldest.key);
        }
        const put = store.put({ ...entry, cacheKey: key, ...(previous ? { id: previous.id } : {}) } satisfies StoredFile);
        put.onsuccess = () => done(evicted);
      };
    });
    if (!evicted) return { file: null, evicted: [] };
    // A GET inside the write transaction can still return the original OPFS
    // snapshot. Reopen after commit to read the independent IndexedDB value.
    const file = await this.transaction<File | null>("files", "readonly", (transaction, done) => {
      const request = transaction.objectStore("files").index("key").get(cacheKey(entry.key));
      request.onsuccess = () => done((request.result as StoredFile | undefined)?.file ?? null);
    });
    return { file, evicted };
  }

  remove(key: ChannelFileKey): Promise<void> {
    return this.transaction("files", "readwrite", (transaction, done) => {
      const store = transaction.objectStore("files");
      const request = store.index("key").getKey(cacheKey(key));
      request.onsuccess = () => { if (request.result !== undefined) store.delete(request.result); done(); };
    });
  }

  removeMessages(roomId: string, removed: (seq: number) => boolean): Promise<void> {
    return this.transaction<void>(["files", "receipts"], "readwrite", transaction => {
      for (const name of transaction.objectStoreNames) {
        const request = transaction.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const { key } = cursor.value as StoredFile | SavedReceipt;
          if (key.roomId === roomId && removed(key.messageSeq)) cursor.delete();
          cursor.continue();
        };
      }
    });
  }
}
