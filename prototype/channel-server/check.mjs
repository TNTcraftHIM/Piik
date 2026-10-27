import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import WebSocket from "ws";

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

test("authenticated users, role authority, attributed chat and selective source ownership", { timeout: 30_000 }, async t => {
  const owner = await connect(t, { key: ownerKey, name: "Owner check" });
  const friend = await connect(t, { key: inviteKey, name: "Friend check" });
  const other = await connect(t, { key: inviteKey, name: "Other check" });
  for (const client of [owner, friend, other]) assert.equal(client.welcome.type, "welcome");
  const state = owner.welcome.state;
  const ownerSession = state.sessions.find(session => session.id === owner.welcome.sessionId);
  assert.equal(ownerSession.userId, state.channel.ownerId);
  assert.notEqual(friend.welcome.sessionId, other.welcome.sessionId);
  const friendUser = friend.welcome.state.sessions.find(session => session.id === friend.welcome.sessionId).userId;

  assert.equal((await friend.request({ type: "create_room", name: "Not authorized" })).type, "error");
  assert.equal((await friend.request({ type: "set_roles", userId: friendUser, roles: ["moderator"] })).type, "error");
  assert.equal((await owner.request({ type: "set_roles", userId: friendUser, roles: ["member", "moderator"] })).type, "ack");
  assert.equal((await friend.request({ type: "create_room", name: `Check ${randomUUID().slice(0, 8)}` })).type, "ack");
  assert.equal((await owner.request({ type: "set_roles", userId: friendUser, roles: ["member"] })).type, "ack");

  const roomId = state.channel.rooms[0].id;
  for (const client of [owner, friend, other]) assert.equal((await client.request({ type: "browse", roomId })).type, "ack");
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
  assert.equal((await returning.request({ type: "browse", roomId })).type, "ack");
  const history = await returning.wait(event => event.type === "history" && event.roomId === roomId, "authorized history");
  assert.equal(history.messages.filter(message => message.text === text).length, 1);

  const stolen = await connect(t, { credential: other.welcome.credential, sessionId: friend.welcome.sessionId });
  if (stolen.welcome.type === "welcome") {
    assert.notEqual(stolen.welcome.sessionId, friend.welcome.sessionId, "another user cannot resume the victim's session");
  } else assert.equal(stolen.welcome.type, "error");

  const anonymous = await connect(t, { key: "invalid-test-invitation" });
  assert.equal(anonymous.welcome.type, "error");
});
