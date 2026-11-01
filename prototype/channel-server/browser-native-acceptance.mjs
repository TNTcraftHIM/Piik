import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { nativePreviews } from "./browser-preview-acceptance.mjs";

// App hosting and Browser participation share a user, not an endpoint or lifetime.
export async function appRoom({ initial, serverRoom, browser, action, view, evaluate, until, sample,
  capturedScreen, playing, progressing, hook, output }) {
  const directory = await mkdtemp(join(tmpdir(), "piik-app-room-check-"));
  const origin = process.env.CHANNEL_UI_ORIGIN;
  const freePort = async () => {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
  };
  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const assets = resolve(process.env.PIIK_CHANNEL_APP_WEB_DIR ?? "build/channel-web");
  const executable = resolve(process.env.CHANNEL_APP_EXECUTABLE ??
    `prototype/channel-server/target/debug/piik-channel-app${process.platform === "win32" ? ".exe" : ""}`);
  const url = `${origin}/__channel-preview?piik-client-port=${port}#piik-client=1`;
  let app, otherServer, otherWeb, approvalTab, personalTab, log = "";
  const start = () => {
    log = "";
    app = spawn(executable, [], { env: { ...process.env,
      PIIK_CHANNEL_APP_PORT: String(port), PIIK_CHANNEL_APP_DATA_DIR: directory,
      PIIK_CHANNEL_APP_WEB_DIR: assets, PIIK_CHANNEL_APP_NO_BROWSER: "1",
    }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = chunk => { log = (log + chunk).slice(-64000); };
    app.stdout.on("data", collect); app.stderr.on("data", collect);
    app.on("error", error => collect(String(error)));
  };
  const ready = () => until("App local socket starts", () => {
    if (app.exitCode !== null) throw new Error(log);
    return log;
  }, value => value.includes("App room socket listening"));
  const stop = async () => {
    if (app?.exitCode === null && app.signalCode === null) {
      const exited = once(app, "exit"); app.kill(); await exited;
    }
  };
  const health = site => fetch(`${local}/health`, { headers: { Origin: site } });
  const appReady = index => until("Browser verifies its current App connection", () => evaluate(index, `${hook}?.snapshot().appConnected ?? false`), Boolean);
  const approve = async site => {
    const destination = `${local}/client?site=${encodeURIComponent(site)}`;
    if (!approvalTab) {
      personalTab = (await browser(1, "tab")).tabs.find(tab => tab.active).targetId;
      approvalTab = (await browser(1, "tab", "new", destination)).targetId;
    } else {
      await browser(1, "tab", approvalTab);
      await browser(1, "open", destination);
    }
    await browser(1, "wait", "#site-approval-title");
    await browser(1, "find", "role", "button", "click", "--name", "English", "--exact");
    if (site === origin) {
      const viewport = await evaluate(1, "({ width: innerWidth, height: innerHeight })");
      await browser(1, "screenshot", join(output, "app-approval-desktop.png"));
      await browser(1, "set", "viewport", "390", "844");
      await browser(1, "screenshot", join(output, "app-approval-mobile.png"));
      await browser(1, "set", "viewport", String(viewport.width), String(viewport.height));
    }
    await browser(1, "find", "role", "button", "click", "--name", "Allow access", "--exact");
    await until("real approval page grants the exact Site", async () => (await health(site)).status, value => value === 200);
    await browser(1, "tab", personalTab);
  };
  try {
    const browserRoom = await action(1, "createRoom({name:'Browser-owned room',icon:'couch',access:'public',hidden:false})");
    start(); await ready();
    const discovery = await fetch(`${local}/connect-discovery`).then(response => response.json());
    assert.deepEqual(discovery, { service: "piik-channel-app", protocol: 1, port, connectURL: `${local}/client` });
    assert.equal((await health(origin)).status, 403, "discovery does not approve its caller");
    await approve(origin);
    const token = (await (await health(origin)).json()).token;
    const participants = await evaluate(0, `${hook}.snapshot().state.sessions.filter(session => session.online).length`);
    await browser(1, "open", url);
    await browser(1, "reload");
    await until("linked Browser restores its admitted identity", () => view(1), value => value.connection === "connected"
      && value.self.id === initial[1].self.id);
    await appReady(1);
    const room = await action(1, process.argv.includes("--previews")
      ? "createRoom({name:'Preview room',icon:'couch',access:'public',hidden:false})"
      : "createRoom({name:'App-owned room',icon:'couch',access:'private',hidden:true,password:'app-room-password'})");
    await action(1, `browse(${JSON.stringify(room)})`);
    if (process.argv.includes("--previews")) {
      await nativePreviews({ room, browser, action, view, evaluate, until, playing, progressing, hook, output, directory });
      return;
    }
    const invite = await action(1, `createRoomInvite(${JSON.stringify(room)})`);
    assert(!invite.includes(token), "room invitations never carry the local App token");
    await browser(2, "open", invite);
    await until("invited reader enters App-owned room", () => view(2), value => value.connection === "connected"
      && value.state.channel.rooms.some(entry => entry.id === room && entry.authorized));
    await action(2, `sendMessage(${JSON.stringify(room)}, 'Saved by the linked Rust App')`);
    await until("App room confirmation reaches its owner", () => evaluate(1,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), messages => messages?.some(message => message.text === "Saved by the linked Rust App"));
    const hosted = (await view(1)).state.channel.rooms.find(entry => entry.id === room);
    const nativeEndpoint = hosted.delivery.hostSessionId;
    assert.notEqual(nativeEndpoint, (await view(1)).sessionId, "App hosting uses its own endpoint");
    assert.equal(await evaluate(1, `${hook}.snapshot().state.sessions.find(session => session.id === ${JSON.stringify(nativeEndpoint)}).userId`), initial[1].self.id);
    assert.equal(await evaluate(1, `${hook}.snapshot().state.sessions.filter(session => session.online).length`), participants + 1,
      "one Native endpoint hosts the App rooms");
    assert.equal((await view(1)).state.channel.rooms.find(entry => entry.id === browserRoom).delivery.hostSessionId,
      (await view(1)).sessionId, "connecting App does not migrate an existing Browser room");
    const [siteData] = await readdir(join(directory, "rooms"));
    const storedPath = join(directory, "rooms", siteData, initial[1].state.channel.id, initial[1].self.id, `${room}.sqlite`);
    const stored = new DatabaseSync(storedPath, { readOnly: true });
    const domain = new DatabaseSync(process.env.CHANNEL_DATA_FILE, { readOnly: true });
    try {
      assert.equal(stored.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count, 1);
      assert.equal(domain.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count, 0);
    } finally { stored.close(); domain.close(); }
    assert.equal(await evaluate(1, `(async () => {
      for (const database of await indexedDB.databases()) {
        if (!database.name?.startsWith('piik.channel.rooms.')) continue;
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open(database.name);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          const tx = db.transaction('rooms'); const request = tx.objectStore('rooms').get(${JSON.stringify(room)});
          await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
          if (request.result) return true;
        } finally { db.close(); }
      }
      return false;
    })()`), false,
      "App room has no second Browser storage writer");
    const first = (await view(1)).state.channel.rooms.find(entry => entry.id === room).delivery.bindingId;
    const personalEndpoint = (await view(1)).sessionId;
    await action(1, `joinVoice(${JSON.stringify(room)})`);
    await action(2, `joinVoice(${JSON.stringify(room)})`);
    await until("linked room voice uses Browser media", () => sample(2), value => value.inbound.some(row => row.kind === "audio" && row.samples > 0));
    const picture = await capturedScreen(1, room);
    await action(2, `watch(${JSON.stringify(picture)})`); await playing(2, picture);
    const unrelated = await capturedScreen(0, serverRoom);
    await action(2, `watch(${JSON.stringify(unrelated)})`); await playing(2, unrelated);
    await evaluate(1, "window.__channelProbe.sockets.filter(socket => new URL(socket.url).pathname === '/rooms').forEach(socket => socket.close())");
    await until("local control disconnect is visible", () => evaluate(1, `${hook}.snapshot().appConnected`), value => value === false);
    await progressing(2, picture);
    await action(1, "close()");
    await browser(1, "open", "about:blank");
    await until("page close ends personal activity and Browser hosting only", () => view(2), value =>
      value.state.channel.rooms.some(entry => entry.id === room && entry.available && entry.delivery.hostSessionId === nativeEndpoint)
      && value.state.channel.rooms.some(entry => entry.id === browserRoom && !entry.available)
      && !value.state.publications.some(publication => publication.id === picture));
    await action(2, `sendMessage(${JSON.stringify(room)}, 'Still here after the owner closes the page')`);
    await until("App confirms chat without its owner's page", () => evaluate(2,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), messages => messages?.some(message => message.text === "Still here after the owner closes the page"));
    await progressing(2, unrelated);
    await browser(1, "open", url);
    await until("owner returns to the same Native hosting endpoint", () => view(1), value => value.connection === "connected"
      && value.state.channel.rooms.some(entry => entry.id === room && entry.available && entry.delivery.bindingId === first)
      && value.state.channel.rooms.some(entry => entry.id === browserRoom && entry.available && entry.delivery.hostSessionId === value.sessionId));
    await appReady(1);
    assert(!(await view(1)).state.voice.some(member => member.sessionId === personalEndpoint || member.sessionId === nativeEndpoint),
      "personal voice stops with its page and never becomes a hosting activity");
    await action(1, `browse(${JSON.stringify(room)})`);
    await until("returning owner's history includes the conversation during absence", () => evaluate(1,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), messages =>
      messages?.some(message => message.text === "Still here after the owner closes the page"));
    const endpoint = (await view(1)).sessionId;
    await stop();
    await until("App loss pauses only its room", () => view(2), value =>
      value.state.channel.rooms.some(entry => entry.id === room && !entry.available)
      && !value.state.publications.some(publication => publication.roomId === room), 30_000);
    assert.equal((await view(1)).sessionId, endpoint, "local App loss retains the Browser endpoint");
    assert((await view(1)).state.channel.rooms.some(entry => entry.id === browserRoom && entry.available),
      "App shutdown preserves Browser hosting");
    await progressing(2, unrelated);
    start(); await ready();
    assert.equal((await health(origin)).status, 200, "approved Site survives App restart");
    await action(1, "reconnect()");
    await appReady(1);
    await until("App reconnect restores data with a fresh binding", () => view(1), value => value.state?.channel.rooms.some(entry =>
      entry.id === room && entry.available && entry.delivery.bindingId !== first));
    await action(1, `browse(${JSON.stringify(room)})`);
    await until("App restart restores saved history", () => evaluate(1,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), messages =>
      messages?.some(message => message.text === "Saved by the linked Rust App"));
    assert(!(await view(1)).state.voice.some(member => member.roomId === room));
    assert(!(await view(1)).state.publications.some(publication => publication.roomId === room));
    await progressing(2, unrelated);
    const restoredBinding = (await view(1)).state.channel.rooms.find(entry => entry.id === room).delivery.bindingId;

    // A second ordinary domain exercises approval isolation with its own real
    // identity, room runtime and peer confirmation, not another claimed UUID.
    const otherPort = await freePort(), otherCorePort = await freePort();
    const otherOrigin = `http://127.0.0.1:${otherPort}`;
    const otherOwner = randomUUID();
    otherServer = spawn(resolve(process.env.CHANNEL_EXECUTABLE ??
      `prototype/channel-server/target/debug/piik-channel-prototype${process.platform === "win32" ? ".exe" : ""}`), [], {
      env: { ...process.env, PIIK_CHANNEL_PORT: String(otherCorePort), PIIK_CHANNEL_WEB_ORIGIN: otherOrigin,
        PIIK_CHANNEL_WEB_DIR: assets, PIIK_CHANNEL_DATA_DIR: join(directory, "other-domain"),
        PIIK_CHANNEL_OWNER_KEY: otherOwner, PIIK_CHANNEL_INVITE_KEY: randomUUID() },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const collectOther = chunk => { log = (log + String(chunk).replaceAll(otherOwner, "[other owner key]")).slice(-64000); };
    otherServer.stdout.on("data", collectOther); otherServer.stderr.on("data", collectOther);
    otherServer.on("error", error => collectOther(String(error)));
    otherWeb = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "prototype/channel-server/vite.config.ts"], {
      env: { ...process.env, PIIK_CHANNEL_PORT: String(otherCorePort), PIIK_CHANNEL_UI_PORT: String(otherPort) },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    otherWeb.stdout.on("data", collectOther); otherWeb.stderr.on("data", collectOther);
    otherWeb.on("error", error => collectOther(String(error)));
    await until("second ordinary Domain starts", () => fetch(`http://127.0.0.1:${otherCorePort}/healthz`).then(response => response.ok).catch(() => false), Boolean);
    await until("second Site's normal frontend starts", () => fetch(otherOrigin).then(response => response.ok).catch(() => false), Boolean);
    assert.equal((await health(otherOrigin)).status, 403, "one approved Site grants no authority to another");
    await approve(otherOrigin);
    const firstDomainTab = (await browser(0, "tab")).tabs.find(tab => tab.active).targetId;
    await browser(0, "tab", "new",
      `${otherOrigin}/__channel-preview?piik-client-port=${port}#owner=${otherOwner}&piik-client=1`);
    await until("second Site admits its own Browser user", () => view(0), value => value.connection === "connected");
    await appReady(0);
    const otherIdentity = (await view(0)).self.id;
    const otherRoom = await action(0, "createRoom({name:'Other Site App room',icon:'couch',access:'public',hidden:false})");
    const otherBinding = (await view(0)).state.channel.rooms.find(entry => entry.id === otherRoom).delivery.bindingId;
    await action(0, `sendMessage(${JSON.stringify(otherRoom)}, 'Other Site before revocation')`);
    await browser(1, "tab", approvalTab);
    await browser(1, "open", `${local}/client`);
    await browser(1, "wait", ".lr-client-approved-sites");
    await browser(1, "click", `.lr-client-approved-site:has(a[href^="${origin}/"]) button[aria-label="Revoke this Site's App access"]`);
    await until("revocation removes only this Site's health authority", async () => (await health(origin)).status, value => value === 403);
    await until("revoked Site's Native rooms stop", () => view(2), value => value.state.channel.rooms.some(entry => entry.id === room && !entry.available));
    assert.equal((await health(otherOrigin)).status, 200);
    assert.equal((await view(0)).self.id, otherIdentity);
    assert.equal((await view(0)).state.channel.rooms.find(entry => entry.id === otherRoom).delivery.bindingId, otherBinding);
    await action(0, `sendMessage(${JSON.stringify(otherRoom)}, 'Other Site still confirms after revocation')`);
    await until("another Site's actual room keeps confirming", () => evaluate(0,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(otherRoom)}]`), messages => messages?.some(message => message.text === "Other Site still confirms after revocation"));
    await browser(1, "open", `${local}/client?site=${encodeURIComponent(origin)}`);
    await browser(1, "wait", "#site-approval-title");
    await browser(1, "find", "role", "button", "click", "--name", "Allow access", "--exact");
    await until("reapproval restores the Site's existing local permission", async () => (await health(origin)).status, value => value === 200);
    await browser(1, "tab", personalTab);
    await action(1, "activateApp()");
    await until("reapproved Site restores its retained room", () => view(1), value => value.state.channel.rooms.some(entry =>
      entry.id === room && entry.available && entry.delivery.bindingId !== restoredBinding));
    const retained = new DatabaseSync(storedPath, { readOnly: true });
    try { assert(retained.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count >= 2); }
    finally { retained.close(); }
    assert.equal((await readdir(join(directory, "rooms"))).length, 2, "reapproval reuses the same Site data directory");
    await browser(0, "tab", firstDomainTab);
    await writeFile(join(output, "app-result.json"), JSON.stringify({ passed: true,
      scenarios: ["real Site approval", "unapproved Origin rejected", "saved approval reused", "cross-Site hosting isolation", "reapproval retains Site data",
        "separate hosting and personal endpoints", "Native SQLite ownership", "Browser rooms do not migrate", "peer chat confirmation",
        "Browser screen and voice", "control loss preserves media", "page close preserves App hosting and chat",
        "returning page reuses Native hosting", "App loss isolates its rooms", "fresh binding restores saved history"] }, null, 2));
  } catch (error) { console.error(log); throw error; }
  finally {
    await stop();
    for (const child of [otherWeb, otherServer]) if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    if (relative(tmpdir(), directory).startsWith("..") || !basename(directory).startsWith("piik-app-room-check-")) throw new Error("Unexpected App acceptance directory");
    await rm(directory, { recursive: true, force: true });
  }
}

// Exercise the normal interface against an actual Native room operator. The
// Browser harness replaces only capture, retaining real Opus and WebRTC peers.
export async function nativeRoom({ initial, serverRoom, browser, action, view, evaluate, until, sample, audioProgressing,
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
      pair.incoming.some(flow => voiceIds.includes(flow.publicationId))).every(pair => pair.peerId === pairs[0].peerId));

    await evaluate(1, "window.__channelProbe.captureAudio(true)");
    const nativePicture = await capturedScreen(1, room);
    await evaluate(1, "window.__channelProbe.captureAudio(false)");
    await action(2, `watch(${JSON.stringify(nativePicture)})`);
    await playing(2, nativePicture);
    await audioProgressing(2, nativePicture);
    const audioSeparationDb = await evaluate(2,
      `window.__channelProbe.screenAudioSeparation(${JSON.stringify(nativePicture)})`);
    assert(audioSeparationDb.every(db => db > 20),
      `Native screen sound lost stereo separation: ${JSON.stringify(audioSeparationDb)}`);
    assert((await view(2)).state.pairs.some(pair => pair.id === pairs[1].id && pair.incoming.some(flow => flow.publicationId === nativePicture)),
      "picture startup must reuse the established Native base path");

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

    await browser(2, "click", `.c3-room-link[aria-label="${name}"]`);
    await progressing(2, nativePicture);
    await action(1, `stopScreen(${JSON.stringify(nativePicture)})`);
    await until("stopping Native-forwarded picture retains the voice pair", () => view(2), value =>
      !value.state.publications.some(publication => publication.id === nativePicture)
      && value.state.pairs.some(pair => pair.id === pairs[1].id && pair.incoming.some(flow => voiceIds.includes(flow.publicationId))));
    await advancing(2);
    await browser(2, "click", '.c3-room-link[aria-label="Living room"]');

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
    await evaluate(2, `window.__channelProbe.historyBeforeNativeReentry = ${hook}.snapshot().historyByRoom['${room}']`);
    await browser(2, "click", `.c3-room-link[aria-label="${name}"]`);
    // Browse approval starts the automatic load; an idle flag alone can precede it.
    await until("Native room history finishes on re-entry", () => evaluate(2,
      `(() => { const state = ${hook}.snapshot(); return state.historyByRoom['${room}'] !== window.__channelProbe.historyBeforeNativeReentry
        && !state.pending.has('history:${room}'); })()`), Boolean);
    await evaluate(2, "delete window.__channelProbe.historyBeforeNativeReentry");
    assert((await evaluate(2, `${hook}.snapshot().messagesByRoom['${room}']`))
      .some(message => message.text === "Confirmed by Native room"));
    assert(!(await view(2)).state.voice.some(member => member.roomId === room), "saved data must not revive a call");
    await progressing(2, picture);
    await browser(2, "screenshot", join(output, "native-room.png"), "--full");
    await writeFile(join(output, "native-result.json"), JSON.stringify({ passed: true, audioSeparationDb,
      scenarios: ["Native admitted root", "room SQLite owns confirmed history", "lost offer recovery on an existing pair", "bidirectional encoded Opus forwarding",
        "picture startup through Native base", "simultaneous picture voice and file forwarding", "picture stop preserves voice",
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
