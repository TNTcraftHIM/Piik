let request: Promise<void> | undefined;

/** Storage protection is optional and applies to the origin's default bucket. */
export function requestBrowserRoomPersistence(): void {
  if (request) return;
  request = (async () => {
    try { await navigator.storage?.persist?.(); }
    catch { /* Room records can still be written without the permission. */ }
  })().finally(() => { request = undefined; });
}

export async function readBrowserRoomPersistence(): Promise<boolean | null> {
  await request;
  try { return (await navigator.storage?.persisted?.()) ?? null; }
  catch { return null; }
}
