const namespace = "piik-channel-transfer-sessions";

export interface TransferStorage {
  directory: FileSystemDirectoryHandle;
  close(): Promise<void>;
}

export async function openTransferStorage(): Promise<TransferStorage> {
  if (!navigator.storage?.getDirectory || !navigator.locks) throw new Error("file_storage_unavailable");
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle(namespace, { create: true });
  const name = crypto.randomUUID();
  const lockName = (session: string) => `${namespace}/${session}`;

  // Every session acquires its lock before publishing a directory. A retired
  // document releases it automatically, even if it never ran cleanup.
  const abandoned = new Set<string>();
  for await (const entry of sessions.values()) {
    if (entry.kind === "directory") abandoned.add(entry.name);
  }
  for (const entry of abandoned) {
    await navigator.locks.request(lockName(entry), { ifAvailable: true }, async lock => {
      if (lock) await sessions.removeEntry(entry, { recursive: true }).catch(() => {});
    });
  }

  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  return new Promise<TransferStorage>((resolve, reject) => {
    const locked = navigator.locks.request(lockName(name), async () => {
      const directory = await sessions.getDirectoryHandle(name, { create: true });
      resolve({
        directory,
        close: () => { release(); return locked; },
      });
      await closed;
      await sessions.removeEntry(name, { recursive: true });
    });
    void locked.catch(reject);
  });
}
