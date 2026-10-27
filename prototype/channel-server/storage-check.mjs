// Real isolated Server HTTP/WS/restart acceptance. Never uses the running preview.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";

const directory = await mkdtemp(join(tmpdir(), "piik-channel-store-"));
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}/prototype/channel`;
const origin = "http://127.0.0.1:8790";
const ownerKey = randomUUID(), inviteKey = randomUUID();
const executable = resolve("prototype/channel-server/target/debug/piik-channel-prototype" + (process.platform === "win32" ? ".exe" : ""));
let child;
const clients = [];
async function start() {
  child = spawn(executable, [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
    PIIK_CHANNEL_PORT: String(port), PIIK_CHANNEL_WEB_ORIGIN: origin,
    PIIK_CHANNEL_OWNER_KEY: ownerKey, PIIK_CHANNEL_INVITE_KEY: inviteKey, PIIK_CHANNEL_DATA_DIR: directory,
    PIIK_CHANNEL_FILE_LIMIT: "1024", PIIK_CHANNEL_ATTACHMENT_BUDGET: "4096" } });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  child.on("error", error => { output += String(error); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.ok).catch(() => false)) return;
    if (child.exitCode !== null) throw new Error(`isolated server failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("isolated server did not start");
}
async function stop() {
  for (const client of clients.splice(0)) client.socket.terminate();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
}
async function connect(input) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/prototype/channel`, { origin });
  const inbox = [], waiting = [];
  socket.on("message", bytes => {
    const event = JSON.parse(bytes.toString()), index = waiting.findIndex(item => item.predicate(event));
    if (index < 0) inbox.push(event);
    else { const [item] = waiting.splice(index, 1); clearTimeout(item.timer); item.resolve(event); }
  });
  function wait(predicate) {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { predicate, resolve, timer: setTimeout(() => {
        waiting.splice(waiting.indexOf(item), 1); reject(new Error("expected isolated WS event was not received"));
      }, 5000) }; waiting.push(item);
    });
  }
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "join", name: "Storage check", ...input }));
  const welcome = await wait(event => event.type === "welcome" || event.type === "error");
  assert.equal(welcome.type, "welcome");
  const client = { socket, welcome, wait, request: async command => {
    const requestId = randomUUID(), result = wait(event => event.requestId === requestId && ["ack", "error"].includes(event.type));
    socket.send(JSON.stringify({ ...command, requestId })); return result;
  } }; clients.push(client); return client;
}
const headers = client => ({ Origin: origin, Authorization: `Bearer ${client.welcome.credential}` });
async function upload(client, room, name, bytes) {
  return fetch(`${base}/rooms/${room}/attachments`, { method: "POST", headers: { ...headers(client), "X-File-Name": encodeURIComponent(name) }, body: bytes });
}
async function history(client, roomId, before) {
  const result = client.wait(event => event.type === "history" && event.roomId === roomId);
  assert.equal((await client.request({ type: "history", roomId, before })).type, "ack");
  return result;
}

try {
  await start();
  let owner = await connect({ key: ownerKey }), member = await connect({ key: inviteKey });
  const outsider = await connect({ key: inviteKey });
  const channelId = owner.welcome.state.channel.id;
  assert.equal((await owner.request({ type: "create_room", name: "Private retained room", access: "private", hidden: true, password: "local-test-password" })).type, "ack");
  const privateState = await owner.wait(event => event.type === "state" && event.state.channel.rooms.some(room => room.name === "Private retained room"));
  const roomId = privateState.state.channel.rooms.find(room => room.name === "Private retained room").id;
  assert.equal((await member.request({ type: "enter_room", roomId, password: "local-test-password" })).type, "ack");
  const limits = await fetch(`${base}/limits`).then(response => response.json());
  assert.equal(limits.maxFileBytes, 1024); assert.equal(limits.totalBytes, 4096);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=", "base64");
  const response = await upload(member, roomId, "图片.svg", png);
  assert.equal(response.status, 200);
  const attachment = await response.json();
  assert.equal(attachment.mediaType, "image/png"); assert.equal(attachment.size, png.length);
  assert.equal((await fetch(`${base}/attachments/${attachment.id}`, { headers: headers(owner) })).status, 403, "even a room manager cannot read someone else's composer draft");
  assert.equal((await fetch(`${base}/attachments/${attachment.id}/content`, { headers: headers(owner) })).status, 403);
  assert.equal((await fetch(`${base}/attachments/${attachment.id}`, { headers: headers(outsider) })).status, 403);
  const downloaded = await fetch(`${base}/attachments/${attachment.id}/content`, { headers: headers(member) });
  assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
  assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.equal((await upload(member, roomId, "too-big.bin", Buffer.alloc(1025))).status, 413);
  assert.equal((await upload(outsider, roomId, "forbidden.bin", Buffer.alloc(1))).status, 403);
  const activeFile = await upload(member, roomId, "drawing.svg", Buffer.from("<svg onload='alert(1)'/>"));
  const draft = await activeFile.json();
  assert.equal(draft.mediaType, "application/octet-stream");
  assert.equal((await fetch(`${base}/attachments/${draft.id}?draft=true`, { method: "DELETE", headers: headers(member) })).status, 204);
  assert.equal((await fetch(`${base}/attachments/${draft.id}`, { headers: headers(member) })).status, 404);

  const nonce = randomUUID();
  assert.equal((await member.request({ type: "chat", roomId, text: "", nonce, attachments: [attachment.id] })).type, "ack");
  assert.equal((await fetch(`${base}/attachments/${attachment.id}`, { headers: headers(owner) })).status, 200);
  const publishedFile = await fetch(`${base}/attachments/${attachment.id}/content`, { headers: headers(owner) });
  assert.equal(publishedFile.status, 200); await publishedFile.arrayBuffer();
  const discardedSent = await fetch(`${base}/attachments/${attachment.id}?draft=true`, { method: "DELETE", headers: headers(member) });
  assert.equal(discardedSent.status, 409);
  assert.equal((await discardedSent.json()).code, "attachment_already_sent");
  const intact = await fetch(`${base}/attachments/${attachment.id}/content`, { headers: headers(member) });
  assert.equal(intact.status, 200);
  assert.deepEqual(Buffer.from(await intact.arrayBuffer()), png);
  assert.equal((await member.request({ type: "chat", roomId: "living", text: "wrong room", nonce: randomUUID(), attachments: [attachment.id] })).type, "error");
  for (let index = 0; index < 104; index++) assert.equal((await member.request({ type: "chat", roomId, text: `saved-${index}`, nonce: randomUUID() })).type, "ack");
  const page = await history(member, roomId);
  assert.equal(page.messages.length, 100); assert.equal(page.hasMore, true);
  const earlier = await history(member, roomId, page.messages[0].seq);
  assert.equal(earlier.messages.length, 5);
  assert(earlier.messages.at(-1).seq < page.messages[0].seq);
  const stableUser = member.welcome.state.sessions.find(session => session.id === member.welcome.sessionId).userId;
  const credential = member.welcome.credential, oldSession = member.welcome.sessionId;
  const database = new DatabaseSync(join(directory, "channel.sqlite"));
  database.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'test write failure'); END;");
  const failedWrite = await owner.request({ type: "set_name", name: "must-not-save" });
  assert.equal(failedWrite.type, "error"); assert.equal(failedWrite.code, "storage_failed");
  assert(!database.prepare("SELECT body FROM checkpoint WHERE id=1").get().body.includes("must-not-save"));
  database.exec("DROP TRIGGER fail_checkpoint"); database.close();
  const restoredLive = owner.wait(event => event.type === "state" && event.state.users.some(user => user.name === "Still present"));
  assert.equal((await member.request({ type: "set_name", name: "Still present" })).type, "ack");
  assert(!(await restoredLive).state.users.some(user => user.name === "must-not-save"), "failed storage must roll back live state before events/ack");
  assert.equal((await member.request({ type: "publish", publication: { id: randomUUID(), roomId, kind: "screen", muted: false } })).type, "ack");
  await stop(); await start();
  owner = await connect({ key: ownerKey });
  member = await connect({ credential, sessionId: oldSession });
  assert.equal(member.welcome.state.channel.id, channelId);
  assert.notEqual(member.welcome.sessionId, oldSession);
  assert.equal(member.welcome.state.publications.length, 0);
  assert(member.welcome.state.channel.rooms.some(room => room.id === roomId && room.authorized));
  assert.equal(member.welcome.state.sessions.find(session => session.id === member.welcome.sessionId).userId, stableUser);
  assert.equal((await member.request({ type: "chat", roomId, text: "", nonce, attachments: [attachment.id] })).type, "ack");
  const retained = await history(member, roomId, page.messages[0].seq);
  assert.equal(retained.messages.length, 5, "nonce retry after restart must not duplicate the attachment message");
  assert.equal((await fetch(`${base}/attachments/${attachment.id}`, { headers: headers(member) })).status, 200);
  assert.equal((await owner.request({ type: "revoke_room_access", roomId, userId: stableUser })).type, "ack");
  assert.equal((await fetch(`${base}/attachments/${attachment.id}/content`, { headers: headers(member) })).status, 403);
  assert.equal((await fetch(`${base}/attachments/${attachment.id}`, { method: "DELETE", headers: headers(owner) })).status, 204);
  assert.equal((await fetch(`${base}/attachments/${attachment.id}`, { headers: headers(owner) })).status, 404);
  let quotaRejected = false;
  for (let index = 0; index < 6; index++) {
    const response = await upload(owner, roomId, `budget-${index}.bin`, Buffer.alloc(1024));
    if (response.status === 507) { quotaRejected = true; break; }
    assert.equal(response.status, 200);
  }
  assert(quotaRejected, "actual HTTP upload must enforce the advertised total byte budget");
  console.log("Isolated HTTP/WS/restart passed: identity/catalog/grants/history/nonce, pagination, attachments, quotas and revocation");
} finally {
  await stop();
  assert(relative(tmpdir(), directory).startsWith("piik-channel-store-"));
  await rm(directory, { recursive: true, force: true });
}
