import { BrowserRoomHost, createRoomPolicy, createSessionSigner, decode_control, encode_control, verify_reply, type SentResult } from "../src/room-host";
import type { SignedConversationPacket } from "../../../src/client/channel/protocol";

declare global { interface Window { runBrowserRoomCheck(): Promise<object> } }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
interface Output {
  projection: { views: Record<string, { room: { canManage: boolean; participantSessionIds: string[] }; publications: unknown[] }> };
  reply: { result: { type: string; code?: string; key?: string } } | null;
  invitation: { accepted: boolean } | null;
}
window.runBrowserRoomCheck = async () => {
  const database = `piik-browser-room-check-${crypto.randomUUID()}`;
  const signer = await createSessionSigner(crypto.getRandomValues(new Uint8Array(32)));
  const peerSigner = await createSessionSigner(crypto.getRandomValues(new Uint8Array(32)));
  const signingKey = Array.from(signer.signing_key()), peerSigningKey = Array.from(peerSigner.signing_key());
  const owner = { userId: crypto.randomUUID(), participates: true, domainOwner: false };
  const session = crypto.randomUUID(), connection = crypto.randomUUID();
  const peerSession = crypto.randomUUID(), peerMember = { ...owner, userId: crypto.randomUUID() };
  let bindingId = crypto.randomUUID();
  let revision = 0;
  const endpoints = { [session]: { member: owner, connected: true, signingKey },
    [peerSession]: { member: peerMember, connected: true, signingKey: peerSigningKey } };
  const policy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Browser-owned room", icon: "future-room_7", creatorId: owner.userId,
    access: "public", hidden: false });
  let host = await BrowserRoomHost.open(database, policy);
  check(host.summary().icon === "future-room_7", "unknown valid decorative key survives the shared policy and summary");
  const dispatch = async (command: object, signal?: AbortSignal, target = host): Promise<Output> => target.dispatch({
    now: Date.now(), bindingId, hostSessionId: session, revision: ++revision, endpoints,
    action: { type: "command", context: { connection, sessionId: session, requestId: crypto.randomUUID(), now: Date.now() }, command },
  }, signal) as Promise<Output>;
  const bindHost = async () => {
    await host.bind(bindingId);
    await host.dispatch({ now: Date.now(), bindingId, hostSessionId: session, revision: ++revision, endpoints, action: { type: "sync" } });
  };
  const peerPacket = (command: object, binding = bindingId): SignedConversationPacket => JSON.parse(peerSigner.sign(peerSession, JSON.stringify({
    roomId: host.roomId, bindingId: binding, sender: peerSession, recipient: session, requestId: crypto.randomUUID(), command,
  })));
  const send = async (text: string, nonce: string, attachments: SentResult["message"]["attachments"] = [], signal?: AbortSignal) => {
    const replies = await host.dispatchPeer(peerPacket({ type: "chat", text, nonce, attachments }), Date.now(), signal);
    const confirmation = replies[0]?.record;
    check(confirmation?.type === "confirmed", "committed signed peer send result");
    return confirmation;
  };
  const history = async (before?: number) => {
    const replies = await host.dispatchPeer(peerPacket({ type: "history", before: before ?? null }), Date.now());
    const end = replies.at(-1)?.record;
    check(end?.type === "history_end", "signed peer history completes its page");
    const messages = replies.flatMap(({ record }) => record.type === "history_message" ? [record.message] : []);
    check(messages.length === end.count, "signed peer page count matches its records");
    const snapshots = JSON.parse(JSON.stringify(replies)).filter((reply: { record: { type: string } }) => reply.record.type === "message_reactions");
    check(snapshots.length === messages.length, "every retained body has its reaction snapshot");
    return { messages, hasMore: end.hasMore, oldestSeq: end.oldestSeq, before: end.before };
  };
  try {
    const previousDatabase = `${database}-schema-2`;
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(previousDatabase, 2);
      request.onupgradeneeded = () => { request.result.createObjectStore("retained").put("original", "marker"); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    old.close();
    try {
      try { await BrowserRoomHost.storedPolicies(previousDatabase); throw new Error("old schema accepted"); }
      catch (error) { check(String(error).includes("unsupported_storage_version"), "previous private schema is explicitly rejected"); }
      const saved = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(previousDatabase, 2);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const marker = await new Promise(resolve => {
          const request = saved.transaction("retained").objectStore("retained").get("marker");
          request.onsuccess = () => resolve(request.result);
        });
        check(marker === "original", "rejecting the old schema does not clear its data");
      } finally { saved.close(); }
    } finally {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(previousDatabase);
        request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      });
    }
    await bindHost();
    const initial = await dispatch({ type: "browse", active: true, roomId: host.roomId });
    check(initial.reply?.result.type === "done", "browse confirms activity without reading history");
    check((await history()).messages.length === 0, "history is an explicit independent read");
    check(initial.projection.views[session].room.canManage, "room owner view comes from shared Rust");
    check(initial.projection.views[session].room.participantSessionIds.join() === session
      && initial.projection.views[peerSession].room.participantSessionIds.join() === session,
    "shared Rust projects reading activity to every authorized view without inventing a seat for an idle endpoint");
    const privatePolicy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Hidden room", icon: "future-room_7", creatorId: owner.userId,
      access: "private", hidden: true });
    const privateHost = await BrowserRoomHost.open(database, privatePolicy);
    await privateHost.bind(bindingId);
    try {
      const guestSession = crypto.randomUUID();
      const output = await privateHost.dispatch({ now: Date.now(), bindingId, hostSessionId: session, revision: ++revision,
        endpoints: { ...endpoints, [guestSession]: { member: { ...owner, userId: crypto.randomUUID() }, connected: true, signingKey: peerSigningKey } },
        action: { type: "command", context: { connection, sessionId: guestSession, requestId: "hidden", now: Date.now() },
          command: { type: "browse", roomId: privateHost.roomId, active: true } },
      }) as Output;
      check(!output.projection.views[guestSession] && output.reply?.result.type === "error", "shared private-room policy hides its view");
      const invitation = await dispatch({ type: "room_invite", roomId: privateHost.roomId }, undefined, privateHost);
      const verified = await privateHost.dispatch({ now: Date.now(), bindingId, hostSessionId: session, revision: ++revision, endpoints,
        action: { type: "verify_invite", ticket: crypto.randomUUID(), key: invitation.reply!.result.key, member: null },
      }) as Output;
      check(verified.invitation?.accepted, "shared room verifies private invitation");
      const guest = { ...owner, userId: crypto.randomUUID() };
      const guestEndpoints = { ...endpoints, [guestSession]: { member: guest, connected: true, signingKey: peerSigningKey } };
      const granted = await privateHost.dispatch({ now: Date.now(), bindingId, hostSessionId: session, revision: ++revision, endpoints: guestEndpoints,
        action: { type: "grant_invited", context: { connection, sessionId: guestSession, requestId: null, now: Date.now() } },
      }) as Output;
      check(granted.reply?.result.type === "invited" && granted.projection.views[guestSession], "committed grant returns invited projection");
      await privateHost.close();
      const reopened = await BrowserRoomHost.open(database, privatePolicy);
      await reopened.bind(bindingId);
      try {
        const restored = await reopened.dispatch({ now: Date.now(), bindingId, hostSessionId: session, revision: ++revision, endpoints: guestEndpoints, action: { type: "sync" } }) as Output;
        check(restored.projection.views[guestSession], "private invitation grant survives runtime reopen");
      } finally { await reopened.close(); }
    } finally { await privateHost.close(); }
    const file: SentResult["message"]["attachments"][number] = { id: crypto.randomUUID(), name: "file.bin", size: 3, mediaType: "application/octet-stream",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    const [first, second] = await Promise.all([send("Original", "first", [file]), send("Second", "second")]);
    check(first.inserted && first.message.seq === 1 && second.message.seq === 2, "serialized room order");
    check(JSON.stringify(first.message.attachments) === JSON.stringify([file]), "description committed inside message");
    const offered = await dispatch({ type: "file_offer", roomId: host.roomId, messageSeq: 1, attachmentId: file.id, available: true });
    check(offered.reply?.result.type === "done", "complete copy offered through confirmed message");
    const missing = await dispatch({ type: "file_offer", roomId: host.roomId, messageSeq: 2, attachmentId: file.id, available: true });
    check(missing.reply?.result.code === "attachment_unavailable", "missing attachment aborts the shared turn");
    const retry = await send("Changed retry", "first", [{ ...file, sha256: "0".repeat(64) }]);
    check(!retry.inserted && JSON.stringify(retry.message) === JSON.stringify(first.message), "original confirmation");
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    await bindHost();
    check((await send("After reopen", "third")).message.seq === 3, "persisted sequence after reopen");

    const react = async (reaction: string, active: boolean, asOwner = false, signal?: AbortSignal) => {
      const command = { type: "set_reaction", messageSeq: 1, reaction, active };
      const packet = asOwner ? JSON.parse(signer.sign(session, JSON.stringify({
        roomId: host.roomId, bindingId, sender: session, recipient: session, requestId: crypto.randomUUID(), command,
      }))) : peerPacket(command);
      return JSON.parse(JSON.stringify(await host.dispatchPeer(packet, Date.now(), signal)))[0].record;
    };
    const firstReaction = await react("wave", true);
    check(firstReaction.type === "reaction_confirmed" && firstReaction.changed && firstReaction.snapshot.revision === 1
      && firstReaction.snapshot.choices[peerMember.userId][0] === "wave", "reaction belongs to the authenticated user");
    const repeatedReaction = await react("wave", true);
    check(!repeatedReaction.changed && JSON.stringify(repeatedReaction.snapshot) === JSON.stringify(firstReaction.snapshot), "explicit reaction set is idempotent");
    const [ownerReaction, secondChoice] = await Promise.all([react("wave", true, true), react("laugh", true)]);
    check(ownerReaction.snapshot.revision === 2 && secondChoice.snapshot.revision === 3
      && secondChoice.snapshot.choices[peerMember.userId].length === 2, "serialized users preserve independent choices");
    const removedReaction = await react("wave", false);
    check(removedReaction.snapshot.revision === 4 && removedReaction.snapshot.choices[peerMember.userId].join() === "laugh"
      && removedReaction.snapshot.choices[owner.userId].join() === "wave", "removing a choice keeps the other user and reaction");
    check(!(await react("wave", false)).changed, "repeated removal is idempotent");
    const reactionAbort = new AbortController(), originalPut = IDBObjectStore.prototype.put;
    let reactionWriteSucceeded = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      if (this.name === "messages") request.addEventListener("success", () => { reactionWriteSucceeded = true; reactionAbort.abort(); }, { once: true });
      return request;
    };
    try {
      const failure = await react("heart", true, false, reactionAbort.signal);
      check(failure.type === "error" && failure.code === "AbortError", "aborted reaction write cannot confirm");
    }
    finally { IDBObjectStore.prototype.put = originalPut; }
    check(reactionWriteSucceeded, "reaction rollback occurs after a real IndexedDB put success");
    await host.close(); host = await BrowserRoomHost.open(database, policy); await bindHost();
    const recovered = JSON.parse(JSON.stringify(await host.dispatchPeer(peerPacket({ type: "history", before: null }), Date.now())));
    const recoveredReaction = recovered.find((reply: { record: { type: string; snapshot?: { messageSeq: number } } }) =>
      reply.record.type === "message_reactions" && reply.record.snapshot?.messageSeq === 1).record.snapshot;
    check(JSON.stringify(recoveredReaction) === JSON.stringify(removedReaction.snapshot), "reopen restores committed reactions and excludes the aborted choice");

    const controller = new AbortController();
    const originalAdd = IDBObjectStore.prototype.add;
    let insertSucceeded = false;
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      if (this.name === "messages") request.addEventListener("success", () => { insertSucceeded = true; controller.abort(); }, { once: true });
      return request;
    };
    try {
      const replies = await host.dispatchPeer(peerPacket({ type: "chat", text: "Cancelled", nonce: "cancelled", attachments: [] }), Date.now(), controller.signal);
      check(replies[0]?.record.type === "error" && replies[0].record.code === "AbortError", "abort returns a signed peer error, no confirmation");
    } finally { IDBObjectStore.prototype.add = originalAdd; }
    check(insertSucceeded && (await history()).messages.length === 3, "real add success then abort rolled back");
    check((await send("Retry cancelled", "cancelled")).message.seq === 4, "aborted transaction consumes no sequence");
    const unavailable = await dispatch({ type: "file_receive", roomId: host.roomId, messageSeq: 1, attachmentId: file.id, enabled: true });
    check(unavailable.reply?.result.code === "attachment_unavailable" && (await history()).messages.length === 4, "runtime reopen does not revive complete copy sources");
    for (let index = 0; index < 106; index++) await send(`Message ${index}`, `page-${index}`);
    const latest = await history(), older = await history(latest.messages[0].seq), empty = await history(0);
    check(latest.messages.length === 50 && latest.hasMore && latest.oldestSeq === 1, "shared latest page");
    check(older.messages.length === 50 && older.hasMore && older.messages[0].seq === 11 && older.messages.at(-1)!.seq === 60, "shared older page");
    const earliest = await history(older.messages[0].seq);
    check(earliest.messages.length === 10 && !earliest.hasMore && earliest.messages[0].seq === 1, "all older history remains reachable");
    check(empty.messages.length === 0 && !empty.hasMore && empty.oldestSeq === 1, "before zero empty page");
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    await bindHost();
    check(JSON.stringify(await history()) === JSON.stringify(latest), "history survives runtime/database reopen");
    const original = await send("Changed again", "first", [{ ...file, sha256: "0".repeat(64) }]);
    check(!original.inserted && JSON.stringify(original.message) === JSON.stringify(first.message), "nonce survives reopen");
    await dispatch({ type: "publish", publication: { id: crypto.randomUUID(), roomId: host.roomId, kind: "screen", muted: false } });
    await host.close();
    host = await BrowserRoomHost.open(database, policy);
    await bindHost();
    const restored = await dispatch({ type: "browse", active: true, roomId: host.roomId });
    check(restored.projection.views[session].publications.length === 0, "restart restores policy/history, not capture");
    check((await BrowserRoomHost.storedPolicies(database)).length === 2, "persisted room policies enumerated");
    const publication = crypto.randomUUID();
    await dispatch({ type: "publish", publication: { id: publication, roomId: host.roomId, kind: "screen", muted: false } });
    await bindHost();
    check((await dispatch({ type: "browse", active: true, roomId: host.roomId })).projection.views[session].publications.length === 1,
      "same binding preserves live activity");
    const previousHost = host, previousBinding = bindingId;
    const lateClaim = await BrowserRoomHost.open(database, policy);
    const replacement = await BrowserRoomHost.open(database, policy);
    bindingId = crypto.randomUUID();
    await replacement.bind(bindingId);
    try {
      const output = await dispatch({ type: "update_room", roomId: replacement.roomId,
        name: "New binding policy", icon: "future-room_7", access: "public", hidden: false }, undefined, replacement);
      check(output.reply?.result.type === "done" && output.projection.views[session].publications.length === 0,
        "new binding reloads policy without old activity");
      try { await lateClaim.bind(crypto.randomUUID()); throw new Error("late claim succeeded"); }
      catch (error) { check(error instanceof Error && error.message === "room_host_conflict", "late claim cannot replace new owner"); }
      try { await lateClaim.dispatch({ bindingId: previousBinding }); throw new Error("failed claim dispatched"); }
      catch (error) { check(error instanceof Error && error.message === "stale_room_host", "failed claim disables dispatch"); }
      const stale = await previousHost.dispatch({ now: Date.now(), bindingId: previousBinding, hostSessionId: session, revision: ++revision, endpoints,
        action: { type: "command", context: { connection, sessionId: session, requestId: null, now: Date.now() },
          command: { type: "update_room", roomId: previousHost.roomId, name: "Stale policy", icon: "future-room_7", access: "public", hidden: false } },
      }) as Output;
      check(stale.reply?.result.type === "error" && stale.reply.result.code === "stale_room_host", "old owner cannot update policy");
      for (const command of [{ type: "chat", text: "Stale message", nonce: "stale", attachments: [] }, { type: "history", before: null },
        { type: "interaction_ready" }, { type: "interaction", reaction: "wave" }]) {
        const replies = await previousHost.dispatchPeer(peerPacket(command, previousBinding), Date.now());
        check(replies[0]?.record.type === "error" && replies[0].record.code === "stale_room_host", "old owner cannot confirm history or an immediate result");
      }
      const saved = (await BrowserRoomHost.storedPolicies(database)).map(value => JSON.parse(value)).find(value => value.id === replacement.roomId);
      check(saved.name === "New binding policy", "stale policy did not overwrite current policy");
      host = replacement;
      check((await send("After owner transfer", "after-bind")).message.seq === 111, "stale message consumed no sequence");
    } finally { await previousHost.close(); await lateClaim.close(); if (host !== replacement) await replacement.close(); }
    await dispatch({ type: "browse", roomId: host.roomId, active: true });
    check(host.currentReaders().length === 1 && host.currentReaders()[0] === session, "reading audience comes from shared room state");
    const packet = peerPacket({ type: "chat", text: "Signed peer", nonce: "peer-send", attachments: [] });
    const frame = JSON.parse(decode_control(encode_control(JSON.stringify({ kind: "conversation", body: packet }))));
    check(frame.kind === "conversation" && frame.body.payload === packet.payload, "Rust control framing preserves signed payload bytes");
    const replies = await host.dispatchPeer(frame.body, Date.now());
    const confirmation = replies[0];
    check(replies.length === 2 && confirmation.record.type === "confirmed" && confirmation.record.message.seq === 112 && confirmation.record.inserted,
      "signed peer send confirms persisted room sequence");
    const signedReply = signer.sign(session, JSON.stringify(confirmation));
    check(JSON.stringify(JSON.parse(verify_reply(signedReply, signer.signing_key()))) === JSON.stringify(confirmation), "Rust verifies typed reply");
    try { await host.dispatchPeer({ ...packet, payload: packet.payload + " " }, Date.now()); throw new Error("tampered signature accepted"); }
    catch (error) { check(String(error).includes("invalid_conversation_signature"), "tampered request rejected before storage"); }
    const repeated = await host.dispatchPeer(packet, Date.now());
    check(repeated[0].record.type === "confirmed" && !repeated[0].record.inserted && confirmation.record.type === "confirmed"
      && JSON.stringify(repeated[0].record.message) === JSON.stringify(confirmation.record.message), "peer retry reuses original confirmation");
    const page = await host.dispatchPeer(peerPacket({ type: "history", before: null }), Date.now());
    check(page.length === 101 && page.slice(0, 100).every((reply, index) => String(reply.record.type) === (index % 2 ? "message_reactions" : "history_message"))
      && page[100].record.type === "history_end" && page[100].record.hasMore, "history returns shared typed records and one end marker");
    peerMember.participates = false;
    await host.dispatch({ now: Date.now(), bindingId, hostSessionId: session, revision: ++revision, endpoints, action: { type: "sync" } });
    const denied = await host.dispatchPeer(peerPacket({ type: "chat", text: "Not allowed", nonce: "peer-denied", attachments: [] }), Date.now());
    check(denied.length === 1 && denied[0].record.type === "error" && denied[0].record.code === "forbidden", "current domain write permission controls signed peer sends");
    const readable = await host.dispatchPeer(peerPacket({ type: "history", before: null }), Date.now());
    check(readable.at(-1)?.record.type === "history_end", "losing write permission preserves permitted history reads");
    const readOnlyReaction = await react("laugh", true);
    check(readOnlyReaction.type === "reaction_confirmed" && !readOnlyReaction.changed,
      "room access permits the existing user's reaction independently of chat write permission");
    const ready = JSON.parse(JSON.stringify(await host.dispatchPeer(peerPacket({ type: "interaction_ready" }), 1000)));
    check(ready[0].record.type === "interaction_ready" && ready[0].record.serverTime === 1000 && ready[0].record.reactionIds.includes("wave"), "read-only participant initializes interaction time and reactions");
    const interactionPacket = peerPacket({ type: "interaction", reaction: "wave", targetUserId: owner.userId });
    const interaction = JSON.parse(JSON.stringify(await host.dispatchPeer(interactionPacket, 2000)));
    check(interaction[0].record.type === "interaction" && interaction[0].record.senderUserId === peerMember.userId
      && interaction[0].record.targetUserId === owner.userId && interaction[0].record.occurredAt === 2000
      && interaction[0].requestId === JSON.parse(interactionPacket.payload).requestId, "immediate signed result retains authenticated actor, target, time and request identity");
    check(JSON.parse(verify_reply(signer.sign(session, JSON.stringify(interaction[0])), signer.signing_key())).record.id === interaction[0].record.id, "Host signature covers the immediate result");
    const limited = await host.dispatchPeer(interactionPacket, 2001);
    check(limited[0].record.type === "error" && limited[0].record.code === "rate_limited", "Host applies existing 800ms interaction limit");
    const afterInteraction = await host.dispatchPeer(peerPacket({ type: "history", before: null }), 3000);
    check(JSON.stringify(afterInteraction.map(reply => reply.record)) === JSON.stringify(page.map(reply => reply.record)), "immediate interaction does not add retained history");
    // Old private checkpoints must fail explicitly, without replacing the saved policy.
    const legacyPolicy = await createRoomPolicy({ id: crypto.randomUUID(), name: "Old checkpoint", icon: "future-room_7",
      creatorId: owner.userId, access: "public", hidden: false });
    const legacyHost = await BrowserRoomHost.open(database, legacyPolicy);
    const legacyId = legacyHost.roomId;
    await legacyHost.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database, 3);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    let oldPolicy = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("rooms", "readwrite"), rooms = tx.objectStore("rooms"), request = rooms.get(legacyId);
        request.onsuccess = () => {
          const record = request.result, policy = JSON.parse(record.policy);
          delete policy.icon;
          oldPolicy = JSON.stringify(policy);
          rooms.put({ ...record, policy: oldPolicy });
        };
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      let rejected = false;
      try { await BrowserRoomHost.open(database, legacyPolicy); }
      catch (error) { rejected = String(error) === "invalid_request"; }
      check(rejected, "old room policy without icon is explicitly rejected");
      check((await BrowserRoomHost.storedPolicies(database)).includes(oldPolicy), "invalid old policy remains unchanged");
    } finally { db.close(); }
    await new Promise<void>((resolve, reject) => {
      const upgrade = indexedDB.open(database, 4);
      upgrade.onsuccess = () => { upgrade.result.close(); resolve(); }; upgrade.onerror = () => reject(upgrade.error);
    });
    for (const nonce of ["closed", "closed-again"]) {
      const replies = await host.dispatchPeer(peerPacket({ type: "chat", text: "Closed", nonce, attachments: [] }), Date.now());
      check(replies[0]?.record.type === "error" && replies[0].record.code.includes("transaction"), "closed DB aborts shared pending peer operation");
    }
    return { passed: true, actualWasm: true, actualIndexedDB: true, serializedOrder: true, originalConfirmation: true,
      reopen: true, abortAfterInsertSuccess: insertSucceeded, abortConfirmed: false, unavailableSourceRejected: true, missingAttachmentRejected: true,
      latest: latest.messages.length, older: older.messages.length, beforeZero: true, versionChangeClearsPending: true,
      bindingWriteOwner: true, lateBindingClaim: true, sameBindingActivity: true, privateRoomProjection: true, privateInvitationGrant: true, restoredWithoutCapture: true,
      signedPeerHistory: true, signedPeerPermission: true, immediateReadPermission: true, immediateBindingFence: true, immediateNotHistory: true,
      retainedReactions: true, independentUserChoices: true, reactionAbortAfterPutSuccess: reactionWriteSucceeded,
      previousSchemaPreserved: true,
      missingIconRejectedWithoutOverwrite: true, domainCredentialDatabaseProvided: false };
  } finally {
    await host.close();
    signer.free(); peerSigner.free();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(database);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  }
};
