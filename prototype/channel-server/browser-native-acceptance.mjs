import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// Exercise the normal interface against an actual Native room operator. The
// Browser harness replaces only capture, retaining real Opus and WebRTC peers.
export async function nativeRoom({ initial, serverRoom, browser, action, view, evaluate, until, sample,
  capturedScreen, playing, progressing, assertNoError, hook, output }) {
  const directory = await mkdtemp(join(tmpdir(), "piik-native-room-check-"));
  const database = join(directory, "room.sqlite");
  const room = "native-room", name = "Native room";
  const executable = resolve(process.env.CHANNEL_NATIVE_EXECUTABLE ??
    `prototype/channel-native/target/debug/piik-channel-native${process.platform === "win32" ? ".exe" : ""}`);
  let native, log = "";
  const start = () => {
    native = spawn(executable, ["--room", database, room, name], {
      env: { ...process.env, PIIK_CHANNEL_NATIVE_KEY: process.env.PIIK_CHANNEL_OWNER_KEY,
        PIIK_CHANNEL_NATIVE_NAME: "Native operator" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = chunk => { log = (log + chunk).slice(-64_000); };
    native.stdout.on("data", collect); native.stderr.on("data", collect);
    native.on("error", error => collect(String(error)));
  };
  const stop = async () => {
    if (native?.exitCode === null && native.signalCode === null) {
      const exited = once(native, "exit"); native.kill(); await exited;
    }
  };
  const energy = value => value.inbound.filter(row => row.kind === "audio")
    .reduce((total, row) => total + (row.energy ?? 0), 0);
  const audible = index => until(`Browser ${index} receives Native-forwarded voice`, () => sample(index),
    value => value.inbound.some(row => row.kind === "audio" && row.samples > 0 && row.energy > 0));
  const advancing = async index => {
    const before = energy(await sample(index));
    return until(`Browser ${index} voice keeps advancing`, () => sample(index), value => energy(value) > before);
  };
  try {
    start();
    await until("Native room becomes available", async () => {
      if (native.exitCode !== null) throw new Error(`Native host exited: ${log}`);
      return view(0);
    }, value => value.state.channel.rooms.some(entry => entry.id === room && entry.available));
    for (const index of [1, 2]) await browser(index, "click", `.c3-room-link[aria-label="${name}"]`);
    await until("both Browsers join the Native base", async () => Promise.all([view(1), view(2)]), values =>
      values.every(value => value.state.pairs.some(pair => pair.rooms.includes(room))));
    const pairs = await Promise.all([1, 2].map(async index =>
      (await view(index)).state.pairs.find(pair => pair.rooms.includes(room))));
    assert.equal(pairs[0].peerId, pairs[1].peerId, "voice must traverse the actual Native root");
    assert(!initial.some(value => value.sessionId === pairs[0].peerId), "an administration page is not the Native root");
    for (const index of [1, 2]) await until("Native DataChannel opens", () => sample(index), value =>
      value.channels.some(channel => channel.state === "open"));

    await action(1, `sendMessage('${room}', 'Confirmed by Native room')`);
    await until("Native-confirmed history arrives", () => evaluate(2,
      `${hook}.snapshot().messagesByRoom['${room}']`), messages => messages?.some(message => message.text === "Confirmed by Native room"));
    const stored = new DatabaseSync(database, { readOnly: true });
    const domain = new DatabaseSync(process.env.CHANNEL_DATA_FILE, { readOnly: true });
    try {
      assert.equal(stored.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count, 1);
      assert.equal(domain.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count, 0);
    } finally { stored.close(); domain.close(); }

    await action(2, `joinVoice('${room}', true)`);
    await evaluate(2, `window.__channelProbe.blockPeer(${JSON.stringify(pairs[1].peerId)})`);
    await action(1, `joinVoice('${room}')`);
    await until("Native renegotiation offer is actually withheld", () => sample(2), value => value.blockedOffers > 0);
    await evaluate(2, `window.__channelProbe.unblockPeer(${JSON.stringify(pairs[1].peerId)})`);
    await action(2, "reconnect()");
    await audible(2);
    assert.equal((await view(2)).state.pairs.find(pair => pair.rooms.includes(room)).id, pairs[1].id,
      "signaling recovery must complete pending negotiation on the existing pair");
    await action(2, `setMuted('${room}', false)`);
    await audible(1);
    const voiceIds = (await view(1)).state.publications.filter(publication => publication.roomId === room).map(publication => publication.id);
    for (const index of [1, 2]) assert((await view(index)).state.pairs.filter(pair =>
      pair.incoming.some(id => voiceIds.includes(id))).every(pair => pair.peerId === pairs[0].peerId));

    const fileSize = 1024 * 1024 + 17;
    const expected = createHash("sha256").update(Buffer.from(Array.from({ length: fileSize }, (_, index) => index % 251))).digest("hex");
    await evaluate(1, `(async () => {
      const bytes = Uint8Array.from({length:${fileSize}}, (_, index) => index % 251);
      await ${hook}.session.sendMessage('${room}', 'Peer file through Native', [{id:crypto.randomUUID(),file:new File([bytes], 'peer-proof.bin')}]);
      return true;
    })()`);
    const fileMessage = await until("confirmed peer file description", () => evaluate(2,
      `${hook}.snapshot().messagesByRoom['${room}']?.find(message => message.text === 'Peer file through Native')`), Boolean);
    assert.equal(fileMessage.attachments[0].sha256, expected);
    await evaluate(2, `(() => {
      const key = {roomId:'${room}',messageSeq:${fileMessage.seq},attachmentId:${JSON.stringify(fileMessage.attachments[0].id)}};
      const create = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function(...args) {
        const stream = await create.apply(this,args), write = stream.write.bind(stream);
        stream.write = async value => { await new Promise(resolve => setTimeout(resolve,40)); return write(value); };
        return stream;
      };
      window.__fileCheck = {busy:true};
      void ${hook}.session.attachments.content(key,${JSON.stringify(fileMessage.attachments[0])},new AbortController().signal).then(async file => {
        const digest = await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
        window.__fileCheck = {busy:false,size:file.size,sha256:[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
      },error => {window.__fileCheck = {busy:false,error:String(error)}}).finally(() => {FileSystemFileHandle.prototype.createWritable=create});
      return true;
    })()`);
    await until("file uses the Native base path", () => view(2), value => value.state.files.some(file =>
      file.attachment.id === fileMessage.attachments[0].id && file.upstream === pairs[0].peerId));
    assert.equal((await evaluate(2, "window.__fileCheck")).busy, true, "the file must still be in flight");
    await action(1, "reconnect()");
    await browser(2, "click", '.c3-room-link[aria-label="Living room"]');
    const receivedFile = await until("peer bytes finish after switching the room view", () => evaluate(2, "window.__fileCheck"), value => !value.busy);
    assert.equal(receivedFile.error, undefined, receivedFile.error);
    assert.equal(receivedFile.size, fileSize); assert.equal(receivedFile.sha256, expected);
    await advancing(2);
    const fileStore = new DatabaseSync(database, { readOnly: true });
    const fileDomain = new DatabaseSync(process.env.CHANNEL_DATA_FILE, { readOnly: true });
    try {
      assert.equal(fileStore.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='attachment'").get().count, 0);
      assert.equal(fileDomain.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count, 0);
    } finally { fileStore.close(); fileDomain.close(); }

    const picture = await capturedScreen(0, serverRoom);
    await action(2, `watch(${JSON.stringify(picture)})`);
    await playing(2, picture);
    await browser(1, "click", '.c3-room-link[aria-label="Living room"]');
    await advancing(2);
    await action(1, `leaveVoice('${room}')`);
    await action(1, `joinVoice('${room}')`);
    await advancing(2);
    assert.equal((await view(2)).state.pairs.find(pair => pair.rooms.includes(room)).id, pairs[1].id,
      "replacing voice capture must retain the room's physical connection");
    await progressing(2, picture);
    for (const index of [0, 1, 2]) await assertNoError(index, "Native voice and room lifecycle");

    // Kill the actual host, allowing the existing authority deadline to expire.
    // Restart uses its saved room data, never a test-made policy or route model.
    await stop();
    await until("Native host expiry pauses the room", () => view(2), value =>
      value.state.channel.rooms.some(entry => entry.id === room && !entry.available)
      && !value.state.voice.some(member => member.roomId === room), 30_000);
    assert((await sample(1)).captures.filter(track => track.kind === "audio").every(track => track.state === "ended"));
    await progressing(2, picture);
    start();
    await until("Native room reopens", () => view(2), value =>
      value.state.channel.rooms.some(entry => entry.id === room && entry.available));
    await action(2, `loadLatestHistory('${room}')`);
    assert((await evaluate(2, `${hook}.snapshot().messagesByRoom['${room}']`))
      .some(message => message.text === "Confirmed by Native room"));
    assert(!(await view(2)).state.voice.some(member => member.roomId === room), "saved data must not revive a call");
    await progressing(2, picture);
    await browser(2, "screenshot", join(output, "native-room.png"), "--full");
    await writeFile(join(output, "native-result.json"), JSON.stringify({ passed: true,
      scenarios: ["Native admitted root", "room SQLite owns confirmed history", "lost offer recovery on an existing pair", "bidirectional encoded Opus forwarding",
        "peer file through Native with final digest", "signaling reconnect and view switch preserve file and voice", "no domain or Native file-byte store",
        "view changes retain voice", "capture replacement keeps base", "other-room picture survives",
        "Native process expiry", "history restore without activity revival"] }, null, 2));
  } finally {
    await stop();
    await writeFile(join(output, "native.log"), log);
    assert(!relative(tmpdir(), directory).startsWith("..") && basename(directory).startsWith("piik-native-room-check-"));
    await rm(directory, { recursive: true, force: true });
  }
}
