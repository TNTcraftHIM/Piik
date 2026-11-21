import { vi } from "vitest";

export function stubTransferStorage(directory: object, removeSession = async (_name: string) => {}) {
  const sessions = {
    async *values() {},
    getDirectoryHandle: async () => directory,
    removeEntry: removeSession,
  };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => sessions }) },
    locks: { request: async (_name: string, run: () => Promise<void>) => run() },
  });
}
