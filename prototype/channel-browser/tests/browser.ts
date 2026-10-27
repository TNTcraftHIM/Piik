import { BrowserRoomHost, createRoomPolicy, type AttachmentRecord } from "../src/room-host";

declare global { interface Window { runBrowserRoomCheck(): Promise<object> } }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejected(work: Promise<unknown>, code: string) {
  try { await work; } catch (error) {
    check(error instanceof Error && (error.message === code || error.name === code), `expected ${code}: ${error}`);
    return;
  }
  throw new Error(`expected rejection: ${code}`);
}
async function attachment(database: string, id: string): Promise<AttachmentRecord> {
  const opening = indexedDB.open(database);
  return new Promise((resolve, reject) => {
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("attachments");
      const request = tx.objectStore("attachments").get(id);
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

window.runBrowserRoomCheck = async () => {
  const database = `piik-browser-room-check-${crypto.randomUUID()}`;
  const owner = { userId: crypto.randomUUID(), participates: true, domainOwner: false };
  const policy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Browser-owned room", creatorId: owner.userId,
    access: "public", hidden: false });
  let host = await BrowserRoomHost.open(database, policy);
  try {
    const session = crypto.randomUUID();
    check(host.snapshot(owner, session)?.room.canManage, "room owner projection comes from shared Rust");
    const privatePolicy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Hidden room", creatorId: owner.userId,
      access: "private", hidden: true });
    const privateHost = await BrowserRoomHost.open(database, privatePolicy);
    try {
      const guest = { ...owner, userId: crypto.randomUUID() };
      check(privateHost.snapshot(guest, crypto.randomUUID()) === null, "hidden-room projection does not expose its summary");
      await rejected(privateHost.history(guest), "room_unavailable");
      check((await privateHost.send(owner, "Private", "first")).message.seq === 1, "each room owns its order in the same database");
    } finally { await privateHost.close(); }
    await rejected(host.send({ ...owner, participates: false }, "Denied", "denied"), "forbidden");
    const [first, second] = await Promise.all([host.send(owner, "Original", "first"), host.send(owner, "Second", "second")]);
    check(first.inserted && first.message.seq === 1 && second.message.seq === 2, "serialized room order");
    const retry = await host.send(owner, "Changed retry", "first");
    check(!retry.inserted && JSON.stringify(retry.message) === JSON.stringify(first.message), "shared Rust preserves original confirmation");
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    const afterReopen = await host.send(owner, "After reopen", "third");
    check(afterReopen.message.seq === 3, "persisted order after reopening database");

    const controller = new AbortController();
    const originalAdd = IDBObjectStore.prototype.add;
    let insertSucceeded = false, confirmed = false;
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      if (this.name === "messages") request.addEventListener("success", () => {
        insertSucceeded = true; controller.abort();
      }, { once: true });
      return request;
    };
    try {
      await rejected(host.send(owner, "Cancelled", "cancelled", [], controller.signal).then(value => { confirmed = true; return value; }), "AbortError");
    } finally { IDBObjectStore.prototype.add = originalAdd; }
    check(insertSucceeded && !confirmed, "transaction aborted after real add success without confirmation");
    check((await host.history(owner)).messages.length === 3, "aborted insert did not persist");
    const fourth = await host.send(owner, "Retry cancelled", "cancelled");
    check(fourth.message.seq === 4, "aborted transaction consumed no sequence");

    const file = crypto.randomUUID();
    await host.stageAttachment(owner, file);
    await rejected(host.send(owner, "Missing file", "files", [file, crypto.randomUUID()]), "attachment_unavailable");
    check(!(await attachment(database, file)).committed, "missing attachment did not publish another draft");
    const fifth = await host.send(owner, "File", "files", [file]);
    check(fifth.message.seq === 5 && (await attachment(database, file)).committed, "attachment and message committed together");
    for (let index = 0; index < 105; index++) await host.send(owner, `Message ${index}`, `page-${index}`);
    const latest = await host.history(owner);
    check(latest.messages.length === 100 && latest.hasMore && latest.oldestSeq === 1, "shared Rust latest-page semantics");
    const older = await host.history(owner, latest.messages[0].seq);
    check(older.messages.length === 10 && !older.hasMore && older.messages[0].seq === 1 && older.messages.at(-1)!.seq === 10, "shared Rust older-page semantics");
    const empty = await host.history(owner, 0);
    check(empty.messages.length === 0 && !empty.hasMore && empty.oldestSeq === 1, "before-zero matches native empty-page semantics");
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    const retained = await host.history(owner);
    check(JSON.stringify(retained) === JSON.stringify(latest), "history persists across database/runtime reopen");
    const original = await host.send(owner, "Another changed retry", "first");
    check(JSON.stringify(original.message) === JSON.stringify(first.message) && !original.inserted, "nonce result survives reopen");
    await new Promise<void>((resolve, reject) => {
      const upgrade = indexedDB.open(database, 2);
      upgrade.onsuccess = () => { upgrade.result.close(); resolve(); };
      upgrade.onerror = () => reject(upgrade.error);
    });
    await rejected(host.send(owner, "Closed database", "closed"), "InvalidStateError");
    await rejected(host.send(owner, "Still closed", "closed-again"), "InvalidStateError");
    return { passed: true, actualWasm: true, actualIndexedDB: true, serializedOrder: true,
      originalConfirmation: true, reopen: true, abortAfterInsertSuccess: insertSucceeded,
      abortConfirmed: confirmed, missingAttachmentRollback: true, latest: latest.messages.length, older: older.messages.length,
      domainCredentialDatabaseProvided: false, beforeZero: true, versionChangeClearsPending: true, privateRoomProjection: true };
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(database);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
  }
};
