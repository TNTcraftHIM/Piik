import type { ChannelAttachment, ChannelFileKey } from "./protocol";

export interface FileScope { domainId: string; userId: string }
export interface FileRetentionLimits { maxRetainedBytes: number; maxRetainedFiles: number }
export interface RetainedFile { key: ChannelFileKey; attachment: ChannelAttachment; file: File }
interface StoredFile extends RetainedFile { id?: number; cacheKey: string }
const cacheKey = (key: ChannelFileKey) => JSON.stringify([key.roomId, key.messageSeq, key.attachmentId]);

/** Participant files and their room-confirmed descriptions commit together. */
export class FileStore {
  private name: string;
  constructor(scope: FileScope) { this.name = `piik.channel.files.${scope.domainId}.${scope.userId}`; }

  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "id", autoIncrement: true }).createIndex("key", "cacheKey", { unique: true });
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("files", mode);
        let value: T;
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(transaction.error ?? new Error("file_storage_failed"));
        try { work(transaction.objectStore("files"), result => { value = result; }); }
        catch (error) { transaction.abort(); reject(error); }
      });
    } finally { database.close(); }
  }

  list(): Promise<RetainedFile[]> {
    return this.transaction("readonly", (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => done((request.result as StoredFile[]).map(({ key, attachment, file }) => ({ key, attachment, file })));
    });
  }

  async retain(entry: RetainedFile, limits: FileRetentionLimits): Promise<{ file: File | null; evicted: ChannelFileKey[] }> {
    if (entry.file.size > limits.maxRetainedBytes || limits.maxRetainedFiles < 1) return Promise.reject(new Error("file_retention_limit"));
    const evicted = await this.transaction<ChannelFileKey[]>("readwrite", (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => {
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
    // A GET inside the write transaction can still return the original OPFS
    // snapshot. Reopen after commit to read the independent IndexedDB value.
    const file = await this.transaction<File | null>("readonly", (store, done) => {
      const request = store.index("key").get(cacheKey(entry.key));
      request.onsuccess = () => done((request.result as StoredFile | undefined)?.file ?? null);
    });
    return { file, evicted };
  }

  remove(key: ChannelFileKey): Promise<void> {
    return this.transaction("readwrite", (store, done) => {
      const request = store.index("key").getKey(cacheKey(key));
      request.onsuccess = () => { if (request.result !== undefined) store.delete(request.result); done(); };
    });
  }
}
