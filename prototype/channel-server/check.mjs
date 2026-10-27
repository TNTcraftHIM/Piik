import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import WebSocket from "ws";
import { eventSchema } from "../../src/client/channel/protocol.ts";

const endpoint = process.env.CHANNEL_WS_URL ?? "ws://127.0.0.1:8791/prototype/channel";
const origin = process.env.CHANNEL_UI_ORIGIN ?? "http://127.0.0.1:8790";
assert(["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname), "Checks only target loopback");
const ownerKey = process.env.PIIK_CHANNEL_OWNER_KEY;
const inviteKey = process.env.PIIK_CHANNEL_INVITE_KEY;
assert(ownerKey && inviteKey, "Set PIIK_CHANNEL_OWNER_KEY and PIIK_CHANNEL_INVITE_KEY to the local server's test keys");

async function connect(t, join) {
  const socket = new WebSocket(endpoint, { origin });
  const inbox = [], waiters = [];
  socket.on("message", bytes => {
    const event = JSON.parse(bytes.toString());
    const index = waiters.findIndex(waiter => waiter.predicate(event));
    if (index < 0) inbox.push(event);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer); waiter.resolve(event);
    }
  });
  const wait = (predicate, description) => {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Waiting for ${description}; received event types: ${inbox.map(event => event.type).join(", ")}`));
      }, 5000) };
      waiters.push(waiter);
    });
  };
  t.after(() => { socket.terminate(); for (const waiter of waiters) clearTimeout(waiter.timer); });
  await once(socket, "open");
  const client = { socket, wait,
    request(command) {
      const requestId = randomUUID();
      const response = wait(event => event.requestId === requestId && ["ack", "error"].includes(event.type), command.type);
      socket.send(JSON.stringify({ ...command, requestId }));
      return response;
    },
  };
  socket.send(JSON.stringify({ type: "join", name: "Protocol check", ...join }));
  client.welcome = await wait(event => ["welcome", "error"].includes(event.type), "join result");
  return client;
}

test("the frontend accepts real cross-room publications and subscriptions", { timeout: 30_000 }, async t => {
  const clients = [];
  try {
    for (let index = 0; index < 20; index++) clients.push(await connect(t, { key: index === 0 ? ownerKey : inviteKey }));
    for (const client of clients) assert.equal(client.welcome.type, "welcome");
    const reader = clients[0], rooms = reader.welcome.state.channel.rooms;
    assert.equal(rooms.length, 3);
    for (const room of rooms) for (const client of clients) {
      assert.equal((await client.request({ type: "voice", roomId: room.id, joined: true, muted: false, deafened: false })).type, "ack");
      for (const kind of ["screen", "voice"]) {
        const publicationId = randomUUID();
        assert.equal((await client.request({ type: "publish", publication: { id: publicationId, roomId: room.id, kind, muted: false } })).type, "ack");
        if (client !== reader && kind === "screen") assert.equal((await reader.request({ type: "subscribe", publicationId, enabled: true })).type, "ack");
      }
    }
    const event = await reader.wait(event => event.type === "state" && event.state.publications.length === 120
      && event.state.subscriptions.length === 114, "three rooms with independent activity");
    assert.equal(event.state.voice.length, 60);
    const parsed = eventSchema.safeParse(event);
    assert(parsed.success, JSON.stringify(parsed.error?.issues));
    const negotiated = eventSchema.safeParse({ type: "signal", pairId: randomUUID(),
      fromSessionId: reader.welcome.sessionId,
      payload: { tracks: event.state.publications.map(publication => ({ publicationId: publication.id, streamId: randomUUID() })) } });
    assert(negotiated.success, JSON.stringify(negotiated.error?.issues));
  } finally {
    // Leave immediately so the following protocol cases have the same endpoint budget.
    for (const client of clients) if (client.socket.readyState === WebSocket.OPEN) await client.request({ type: "leave" });
  }
});

test("authenticated users, role authority, attributed chat and selective source ownership", { timeout: 30_000 }, async t => {
  const owner = await connect(t, { key: ownerKey, name: "Owner check" });
  const friend = await connect(t, { key: inviteKey, name: "Friend check" });
  const other = await connect(t, { key: inviteKey, name: "Other check" });
  for (const client of [owner, friend, other]) assert.equal(client.welcome.type, "welcome");
  const state = owner.welcome.state;
  assert(Number.isSafeInteger(state.channel.historyWindow) && state.channel.historyWindow > 0);
  const ownerSession = state.sessions.find(session => session.id === owner.welcome.sessionId);
  assert.equal(ownerSession.userId, state.channel.ownerId);
  assert.notEqual(friend.welcome.sessionId, other.welcome.sessionId);
  const friendUser = friend.welcome.state.sessions.find(session => session.id === friend.welcome.sessionId).userId;

  assert.equal((await friend.request({ type: "set_roles", userId: friendUser, roles: ["moderator"] })).type, "error");
  assert.equal((await owner.request({ type: "set_roles", userId: friendUser, roles: ["member", "moderator"] })).type, "ack");
  assert.equal((await owner.request({ type: "set_roles", userId: friendUser, roles: ["member"] })).type, "ack");

  const roomId = state.channel.rooms[0].id;
  for (const client of [owner, friend, other]) assert.equal((await client.request({ type: "browse", roomId, active: true })).type, "ack");
  const text = `prototype-check-${randomUUID()}`;
  const nonce = randomUUID();
  const received = other.wait(event => event.type === "message" && event.message.text === text, "attributed message");
  assert.equal((await friend.request({ type: "chat", roomId, text, nonce })).type, "ack");
  assert.equal((await received).message.userId, friendUser);
  assert.equal((await friend.request({ type: "chat", roomId, text, nonce })).type, "ack");
  const attacker = await connect(t, { key: inviteKey, name: "Spoof check" });
  const rejected = Promise.race([
    attacker.wait(event => event.type === "error", "spoof rejection"),
    once(attacker.socket, "close"),
  ]);
  attacker.socket.send(JSON.stringify({ type: "chat", roomId, text: "forged", nonce: randomUUID(), userId: state.channel.ownerId }));
  await rejected;
  attacker.socket.close();

  const publicationId = randomUUID();
  assert.equal((await friend.request({ type: "publish", publication: { id: publicationId, roomId, kind: "screen", muted: false } })).type, "ack");
  assert.equal((await other.request({ type: "unpublish", publicationId })).type, "error");
  assert.equal((await other.request({ type: "subscribe", publicationId, enabled: true })).type, "ack");
  const routed = await other.wait(event => event.type === "state" && event.state.pairs.some(pair => pair.incoming.includes(publicationId)), "admitted subscription");
  assert(routed.state.pairs.every(pair => pair.peerId !== other.welcome.sessionId));
  assert.equal((await owner.request({ type: "signal", pairId: randomUUID(), payload: { description: { type: "offer", sdp: "invalid" } } })).type, "error");
  assert.equal((await friend.request({ type: "unpublish", publicationId })).type, "ack");
  await other.wait(event => event.type === "state" && !event.state.publications.some(publication => publication.id === publicationId)
    && event.state.pairs.every(pair => !pair.incoming.includes(publicationId)), "source retirement");

  const disconnected = once(friend.socket, "close");
  friend.socket.close();
  await disconnected;
  const resumed = await connect(t, { credential: friend.welcome.credential, sessionId: friend.welcome.sessionId });
  assert.equal(resumed.welcome.type, "welcome");
  assert.equal(resumed.welcome.sessionId, friend.welcome.sessionId, "a transient disconnect resumes the same endpoint");

  const returning = await connect(t, { credential: friend.welcome.credential, name: "Returning friend" });
  assert.equal(returning.welcome.type, "welcome");
  const returningUser = returning.welcome.state.sessions.find(session => session.id === returning.welcome.sessionId).userId;
  assert.equal(returningUser, friendUser);
  assert.notEqual(returning.welcome.sessionId, friend.welcome.sessionId, "another page is another endpoint");
  assert.equal((await returning.request({ type: "browse", roomId, active: true })).type, "ack");
  const history = await returning.wait(event => event.type === "history" && event.roomId === roomId, "authorized history");
  assert.equal(history.messages.filter(message => message.text === text).length, 1);
  assert.equal(typeof history.hasMore, "boolean");
  assert.equal(history.before, undefined, "fresh browse omits the older-page cursor");
  const olderCursor = history.messages[0].seq;
  assert.equal((await returning.request({ type: "history", roomId, before: olderCursor })).type, "ack");
  const olderPage = await returning.wait(event => event.type === "history" && event.roomId === roomId && event.before === olderCursor, "echoed older cursor");
  assert(olderPage.messages.every(message => message.seq < olderCursor));
  assert(Number.isSafeInteger(history.oldestSeq));
  assert(history.messages.every(message => message.seq >= history.oldestSeq));
  assert(history.messages.length <= returning.welcome.state.channel.historyWindow);
  assert(history.messages.every(message => Number.isSafeInteger(message.seq) && Array.isArray(message.attachments)));

  const stolen = await connect(t, { credential: other.welcome.credential, sessionId: friend.welcome.sessionId });
  if (stolen.welcome.type === "welcome") {
    assert.notEqual(stolen.welcome.sessionId, friend.welcome.sessionId, "another user cannot resume the victim's session");
  } else assert.equal(stolen.welcome.type, "error");

  const anonymous = await connect(t, { key: "invalid-test-invitation" });
  assert.equal(anonymous.welcome.type, "error");
});


test("Server-owned private invitations admit new users, conceal content and revoke room grants", { timeout: 30_000 }, async t => {
  const creator = await connect(t, { key: ownerKey });
  const outsider = await connect(t, { key: inviteKey });
  const roomId = "studio";
  assert.equal((await creator.request({ type: "update_room", roomId, name: "Private check", access: "private", hidden: true, password: "test-room-password" })).type, "ack");
  const concealed = await outsider.wait(event => event.type === "state" && !event.state.channel.rooms.some(room => room.id === roomId), "hidden room excluded");
  assert(!concealed.state.publications.some(p => p.roomId === roomId));
  assert.equal((await outsider.request({ type: "browse", roomId, active: true })).type, "error");
  assert.equal((await outsider.request({ type: "enter_room", roomId, password: "wrong" })).type, "error");
  assert.equal((await creator.request({ type: "room_invite", roomId })).type, "ack");
  const invitation = await creator.wait(event => event.type === "room_invite" && event.roomId === roomId, "room invitation");
  assert.equal(typeof invitation.requestId, "string");
  const guest = await connect(t, { key: invitation.key, roomId });
  assert.equal(guest.welcome.type, "welcome");
  assert(guest.welcome.state.channel.rooms.some(room => room.id === roomId && room.authorized));
  const guestUser = guest.welcome.state.sessions.find(session => session.id === guest.welcome.sessionId).userId;
  assert.equal((await creator.request({ type: "chat", roomId, text: "private-content", nonce: randomUUID() })).type, "ack");
  const privatePublication = randomUUID();
  assert.equal((await creator.request({ type: "publish", publication: { id: privatePublication, roomId, kind: "screen", muted: false } })).type, "ack");
  assert.equal((await outsider.request({ type: "subscribe", publicationId: privatePublication, enabled: true })).type, "error");
  assert.equal((await guest.request({ type: "subscribe", publicationId: privatePublication, enabled: true })).type, "ack");
  assert.equal((await guest.request({ type: "browse", roomId, active: true })).type, "ack");
  const history = await guest.wait(event => event.type === "history" && event.roomId === roomId, "private history");
  assert(history.messages.some(message => message.text === "private-content"));
  assert.equal((await creator.request({ type: "revoke_room_access", roomId, userId: guestUser })).type, "ack");
  const revoked = await guest.wait(event => event.type === "state" && !event.state.channel.rooms.some(room => room.id === roomId), "private grant revoked");
  assert(!revoked.state.publications.some(p => p.id === privatePublication));
  assert(revoked.state.pairs.every(pair => !pair.incoming.includes(privatePublication) && !pair.outgoing.includes(privatePublication)));
  assert.equal((await guest.request({ type: "history", roomId })).type, "error");
  assert.equal((await creator.request({ type: "unpublish", publicationId: privatePublication })).type, "ack");
  assert.equal((await creator.request({ type: "update_room", roomId, name: "Studio", access: "public", hidden: false })).type, "ack");
});
