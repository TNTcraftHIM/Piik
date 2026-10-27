import { BrowserRoomHost, createRoomPolicy, type PageResult, type SentResult } from "../src/room-host";

declare global { interface Window { runBrowserRoomCheck(): Promise<object> } }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
interface Output {
  projection: { views: Record<string, { room: { canManage: boolean }; publications: unknown[] }> };
  reply: { result: { type: string; code?: string; key?: string; result?: SentResult | PageResult } } | null;
  invitation: { accepted: boolean } | null;
}
window.runBrowserRoomCheck = async () => {
  const database = `piik-browser-room-check-${crypto.randomUUID()}`;
  const owner = { userId: crypto.randomUUID(), participates: true, domainOwner: false };
  const session = crypto.randomUUID(), connection = crypto.randomUUID();
  let bindingId = crypto.randomUUID();
  let revision = 0;
  const endpoints = { [session]: { member: owner, connected: true } };
  const policy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Browser-owned room", creatorId: owner.userId,
    access: "public", hidden: false });
  let host = await BrowserRoomHost.open(database, policy);
  await host.bind(bindingId);
  const dispatch = async (command: object, signal?: AbortSignal, target = host): Promise<Output> => target.dispatch({
    bindingId, hostSessionId: session, revision: ++revision, endpoints,
    action: { type: "command", context: { connection, sessionId: session, requestId: crypto.randomUUID(), now: Date.now() }, command },
  }, signal) as Promise<Output>;
  const send = async (text: string, nonce: string, attachments: string[] = [], signal?: AbortSignal) => {
    const output = await dispatch({ type: "chat", roomId: host.roomId, text, nonce, attachments }, signal);
    check(output.reply?.result.type === "history" && output.reply.result.result?.type === "sent", "committed shared send result");
    return output.reply.result.result;
  };
  const history = async (before?: number) => {
    const output = await dispatch({ type: "history", roomId: host.roomId, before });
    check(output.reply?.result.type === "history" && output.reply.result.result?.type === "page", "shared history result");
    return output.reply.result.result;
  };
  try {
    const initial = await dispatch({ type: "browse", active: true, roomId: host.roomId });
    check(initial.projection.views[session].room.canManage, "room owner view comes from shared Rust");
    const privatePolicy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Hidden room", creatorId: owner.userId,
      access: "private", hidden: true });
    const privateHost = await BrowserRoomHost.open(database, privatePolicy);
    await privateHost.bind(bindingId);
    try {
      const guestSession = crypto.randomUUID();
      const output = await privateHost.dispatch({ bindingId, hostSessionId: session, revision: ++revision,
        endpoints: { ...endpoints, [guestSession]: { member: { ...owner, userId: crypto.randomUUID() }, connected: true } },
        action: { type: "command", context: { connection, sessionId: guestSession, requestId: "hidden", now: Date.now() },
          command: { type: "history", roomId: privateHost.roomId } },
      }) as Output;
      check(!output.projection.views[guestSession] && output.reply?.result.type === "error", "shared private-room policy hides its view");
      const invitation = await dispatch({ type: "room_invite", roomId: privateHost.roomId }, undefined, privateHost);
      const verified = await privateHost.dispatch({ bindingId, hostSessionId: session, revision: ++revision, endpoints,
        action: { type: "verify_invite", ticket: crypto.randomUUID(), key: invitation.reply!.result.key, member: null },
      }) as Output;
      check(verified.invitation?.accepted, "shared room verifies private invitation");
      const guest = { ...owner, userId: crypto.randomUUID() };
      const guestEndpoints = { ...endpoints, [guestSession]: { member: guest, connected: true } };
      const granted = await privateHost.dispatch({ bindingId, hostSessionId: session, revision: ++revision, endpoints: guestEndpoints,
        action: { type: "grant_invited", context: { connection, sessionId: guestSession, requestId: null, now: Date.now() } },
      }) as Output;
      check(granted.reply?.result.type === "invited" && granted.projection.views[guestSession], "committed grant returns invited projection");
      await privateHost.close();
      const reopened = await BrowserRoomHost.open(database, privatePolicy);
      await reopened.bind(bindingId);
      try {
        const restored = await reopened.dispatch({ bindingId, hostSessionId: session, revision: ++revision, endpoints: guestEndpoints, action: { type: "sync" } }) as Output;
        check(restored.projection.views[guestSession], "private invitation grant survives runtime reopen");
      } finally { await reopened.close(); }
    } finally { await privateHost.close(); }
    const [first, second] = await Promise.all([send("Original", "first"), send("Second", "second")]);
    check(first.inserted && first.message.seq === 1 && second.message.seq === 2, "serialized room order");
    const retry = await send("Changed retry", "first");
    check(!retry.inserted && JSON.stringify(retry.message) === JSON.stringify(first.message), "original confirmation");
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    await host.bind(bindingId);
    check((await send("After reopen", "third")).message.seq === 3, "persisted sequence after reopen");

    const controller = new AbortController();
    const originalAdd = IDBObjectStore.prototype.add;
    let insertSucceeded = false;
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      if (this.name === "messages") request.addEventListener("success", () => { insertSucceeded = true; controller.abort(); }, { once: true });
      return request;
    };
    try {
      const output = await dispatch({ type: "chat", roomId: host.roomId, text: "Cancelled", nonce: "cancelled", attachments: [] }, controller.signal);
      check(output.reply?.result.type === "error" && output.reply.result.code === "AbortError", "abort returns shared error projection, no confirmation");
    } finally { IDBObjectStore.prototype.add = originalAdd; }
    check(insertSucceeded && (await history()).messages.length === 3, "real add success then abort rolled back");
    check((await send("Retry cancelled", "cancelled")).message.seq === 4, "aborted transaction consumes no sequence");
    const unsupported = await dispatch({ type: "chat", roomId: host.roomId, text: "No domain upload", nonce: "file", attachments: [crypto.randomUUID()] });
    check(unsupported.reply?.result.code === "attachments_unavailable" && (await history()).messages.length === 4, "shared capability rejects unsupported file delivery");
    for (let index = 0; index < 106; index++) await send(`Message ${index}`, `page-${index}`);
    const latest = await history(), older = await history(latest.messages[0].seq), empty = await history(0);
    check(latest.messages.length === 100 && latest.hasMore && latest.oldestSeq === 1, "shared latest page");
    check(older.messages.length === 10 && !older.hasMore && older.messages[0].seq === 1 && older.messages.at(-1)!.seq === 10, "shared older page");
    check(empty.messages.length === 0 && !empty.hasMore && empty.oldestSeq === 1, "before zero empty page");
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    await host.bind(bindingId);
    check(JSON.stringify(await history()) === JSON.stringify(latest), "history survives runtime/database reopen");
    const original = await send("Changed again", "first");
    check(!original.inserted && JSON.stringify(original.message) === JSON.stringify(first.message), "nonce survives reopen");
    await dispatch({ type: "publish", publication: { id: crypto.randomUUID(), roomId: host.roomId, kind: "screen", muted: false } });
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    await host.bind(bindingId);
    const restored = await dispatch({ type: "browse", active: true, roomId: host.roomId });
    check(restored.projection.views[session].publications.length === 0, "restart restores policy/history, not capture");
    check((await BrowserRoomHost.storedPolicies(database)).length === 2, "persisted room policies enumerated");
    const publication = crypto.randomUUID();
    await dispatch({ type: "publish", publication: { id: publication, roomId: host.roomId, kind: "screen", muted: false } });
    await host.bind(bindingId);
    check((await dispatch({ type: "browse", active: true, roomId: host.roomId })).projection.views[session].publications.length === 1,
      "same binding preserves live activity");
    const previousHost = host, previousBinding = bindingId;
    const lateClaim = await BrowserRoomHost.open(database, policy);
    const replacement = await BrowserRoomHost.open(database, policy);
    bindingId = crypto.randomUUID();
    await replacement.bind(bindingId);
    try {
      const output = await dispatch({ type: "update_room", roomId: replacement.roomId,
        name: "New binding policy", access: "public", hidden: false }, undefined, replacement);
      check(output.reply?.result.type === "done" && output.projection.views[session].publications.length === 0,
        "new binding reloads policy without old activity");
      try { await lateClaim.bind(crypto.randomUUID()); throw new Error("late claim succeeded"); }
      catch (error) { check(error instanceof Error && error.message === "room_host_conflict", "late claim cannot replace new owner"); }
      try { await lateClaim.dispatch({ bindingId: previousBinding }); throw new Error("failed claim dispatched"); }
      catch (error) { check(error instanceof Error && error.message === "stale_room_host", "failed claim disables dispatch"); }
      for (const command of [
        { type: "update_room", roomId: previousHost.roomId, name: "Stale policy", access: "public", hidden: false },
        { type: "chat", roomId: previousHost.roomId, text: "Stale message", nonce: "stale", attachments: [] },
        { type: "history", roomId: previousHost.roomId },
      ]) {
        const stale = await previousHost.dispatch({ bindingId: previousBinding, hostSessionId: session, revision: ++revision, endpoints,
          action: { type: "command", context: { connection, sessionId: session, requestId: null, now: Date.now() }, command },
        }) as Output;
        check(stale.reply?.result.type === "error" && stale.reply.result.code === "stale_room_host", "old owner cannot write or confirm history");
      }
      const saved = (await BrowserRoomHost.storedPolicies(database)).map(value => JSON.parse(value)).find(value => value.id === replacement.roomId);
      check(saved.name === "New binding policy", "stale policy did not overwrite current policy");
      host = replacement;
      check((await send("After owner transfer", "after-bind")).message.seq === 111, "stale message consumed no sequence");
    } finally { await previousHost.close(); await lateClaim.close(); if (host !== replacement) await replacement.close(); }
    await new Promise<void>((resolve, reject) => {
      const upgrade = indexedDB.open(database, 2);
      upgrade.onsuccess = () => { upgrade.result.close(); resolve(); }; upgrade.onerror = () => reject(upgrade.error);
    });
    for (const nonce of ["closed", "closed-again"]) {
      const output = await dispatch({ type: "chat", roomId: host.roomId, text: "Closed", nonce, attachments: [] });
      check(output.reply?.result.type === "error" && output.reply.result.code?.includes("transaction"), "closed DB aborts shared pending operation");
    }
    return { passed: true, actualWasm: true, actualIndexedDB: true, serializedOrder: true, originalConfirmation: true,
      reopen: true, abortAfterInsertSuccess: insertSucceeded, abortConfirmed: false, attachmentsUnavailable: true,
      latest: latest.messages.length, older: older.messages.length, beforeZero: true, versionChangeClearsPending: true,
      bindingWriteOwner: true, lateBindingClaim: true, sameBindingActivity: true, privateRoomProjection: true, privateInvitationGrant: true, restoredWithoutCapture: true, domainCredentialDatabaseProvided: false };
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(database);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  }
};
