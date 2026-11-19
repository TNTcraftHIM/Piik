import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture } from "./browser-fixture.mjs";

const origin = process.env.CHANNEL_UI_ORIGIN ?? "http://127.0.0.1:8790";
assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const executable = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe")
  : "agent-browser");
const session = `channel-directory-${randomUUID()}`;
function browser(_index, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--session", session, "--json", ...args], { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${args[0]}`)); }, 40_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        assert.equal(code, 0, stderr || stdout);
        const result = JSON.parse(stdout);
        assert(result.success, result.error);
        resolve(result.data);
      } catch (error) { reject(error); }
    });
  });
}
const { evaluate, until } = fixture(browser);
const sample = expression => evaluate(0, expression);
const gate = "window.__channelGate";
const rows = () => sample(`[...document.querySelectorAll('#c3-people .c3-user')].map(row => ({
  id: row.dataset.userId, name: row.querySelector('strong').firstChild.textContent,
  group: row.closest('section').ariaLabel, self: !!row.querySelector('.c3-you')
}))`);
const more = '#c3-people button[aria-label="More people"]';
const retry = '#c3-people button[aria-label="Retry"]';
try {
  await browser(0, "open", `${origin}/__channel-preview`);
  await sample("localStorage.setItem('piik:ui-lang', 'en')");
  await browser(0, "reload");
  await until("browser joins", () => sample(`${gate}?.snapshot().connection`), value => value === "connected");
  const initialCount = await sample(`${gate}.snapshot().state.channel.userCount`);
  const expectedCount = initialCount + 75;
  const identities = await sample(`(async () => {
    const { CHANNEL_PROTOCOL } = await import('/src/client/channel/protocol.ts');
    const self = window.__channelGate.snapshot().self.id;
    const room = window.__channelGate.snapshot().state.channel.rooms[0];
    const credential = localStorage.getItem('piik.channel.prototype.credential');
    async function connect(name, credential) {
      const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/prototype/channel');
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      function request(command, accepted) {
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(command.type)); }, 5000);
          function receive({ data }) {
            const event = JSON.parse(data);
            if ((event.requestId !== requestId && command.type !== 'join') || ![accepted, 'error', 'room_reply'].includes(event.type)) return;
            clearTimeout(timer); socket.removeEventListener('message', receive);
            if (event.type === 'error' || event.result?.type === 'error') reject(new Error(event.code ?? event.result.code)); else resolve(event);
          }
          socket.addEventListener('message', receive);
          socket.send(JSON.stringify({ ...command, requestId }));
        });
      }
      const signingKey = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])).publicKey)));
      const welcome = await request({ type: 'join', name, credential, signingKey, protocol: CHANNEL_PROTOCOL }, 'welcome');
      return { socket, request, welcome };
    }
    const offline = [];
    for (let i = 0; i < 73; i++) {
      const guest = await connect('Directory ' + i);
      offline.push(guest.welcome.selfProfile.id);
      guest.socket.send(JSON.stringify({ type: 'leave' }));
      guest.socket.close();
    }
    const sameIdentity = await connect('Same identity', credential);
    const online = await connect('Online only');
    const present = await connect('In room');
    await present.request({ type: 'browse', roomId: room.id, active: true }, 'ack');
    window.directoryAcceptance = { sameIdentity, online, present, connect };
    return { self, room, offline, online: online.welcome.selfProfile.id, present: present.welcome.selfProfile.id,
      sameIdentity: sameIdentity.welcome.selfProfile.id };
  })()`);
  assert.equal(identities.self, identities.sameIdentity);
  await until("synthetic guest endpoints retire", () => sample(`${gate}.snapshot().state.sessions.filter(session =>
    ${JSON.stringify(identities.offline)}.includes(session.userId)).length`), value => value === 0);
  await browser(0, "click", `.c3-room-link[aria-label=${JSON.stringify(identities.room.name)}]`);
  await browser(0, "click", "#c3-companion-trigger");
  await browser(0, "wait", more);
  const first = await rows();
  assert(first.length < expectedCount);
  assert.equal(first.filter(row => row.self).length, 1);

  await sample(`(() => {
    const send = WebSocket.prototype.send;
    window.directoryAcceptance.interrupt = true;
    WebSocket.prototype.send = function (data) {
      const command = JSON.parse(data);
      if (window.directoryAcceptance.interrupt && command.type === 'profiles' && command.after) {
        window.directoryAcceptance.interrupt = false;
        this.close();
        return;
      }
      return send.call(this, data);
    };
    document.querySelector(${JSON.stringify(more)}).focus();
  })()`);
  await browser(0, "press", "Enter");
  await until("next request was interrupted", () => sample("!window.directoryAcceptance.interrupt"), Boolean);
  await until("browser reconnects", () => sample(`${gate}.snapshot().connection`), value => value === "connected");
  await browser(0, "wait", retry);
  await until("reconnect restores the loaded rows", rows, value =>
    value.length === first.length && first.every(row => value.some(current => current.id === row.id)));
  await browser(0, "click", retry);
  const second = await until("retry loads the next page", rows, value => value.length > first.length);
  assert(second.length < expectedCount);
  await browser(0, "set", "viewport", "390", "844");
  if (await sample("document.querySelector('#c3-companion-trigger')?.getAttribute('aria-expanded') === 'false'"))
    await browser(0, "click", "#c3-companion-trigger");
  for (let page = 0; page < Math.ceil(expectedCount / 20) + 1 && (await rows()).length < expectedCount; page++) {
    await browser(0, "wait", more);
    const before = (await rows()).length;
    await browser(0, "click", more);
    await until("directory grows", rows, value => value.length > before);
  }
  const everyone = await rows();
  assert.equal(everyone.length, expectedCount);
  assert.equal(new Set(everyone.map(row => row.id)).size, expectedCount);
  assert(identities.offline.every(id => everyone.find(row => row.id === id)?.group === "Offline"));
  assert.equal(everyone.find(row => row.id === identities.online)?.group, "Online");
  assert.equal(everyone.find(row => row.id === identities.present)?.group, "This room");
  assert(await sample("document.documentElement.scrollWidth === innerWidth && document.querySelector('#c3-people').checkVisibility()"));
  await browser(0, "click", "#c3-people .c3-pane-back button");
  const lateId = await sample(`(async () => {
    const { socket, welcome } = await window.directoryAcceptance.connect("Joined while closed");
    window.directoryAcceptance.late = socket;
    return welcome.selfProfile.id;
  })()`);
  await until("late member is online", () => sample(`${gate}.snapshot().state.sessions.some(session => session.userId === ${JSON.stringify(lateId)})`), Boolean);
  await sample("(() => { window.directoryAcceptance.late.send(JSON.stringify({ type: 'leave' })); window.directoryAcceptance.late.close(); })()");
  await until("late member retires", () => sample(`${gate}.snapshot().state.sessions.some(session => session.userId === ${JSON.stringify(lateId)})`), value => !value);
  await browser(0, "click", "#c3-companion-trigger");
  await browser(0, "wait", more);
  for (let page = 0; page < Math.ceil(expectedCount / 20) + 1 && (await rows()).length < expectedCount + 1; page++) {
    await browser(0, "click", more);
    await until("directory page completes", () => sample("!document.querySelector('#c3-people p[role=status]')"), Boolean);
  }
  assert.equal((await rows()).find(row => row.id === lateId)?.group, "Offline");
  assert.equal(await sample("Number(document.querySelector('#c3-people-heading span').textContent)"), expectedCount + 1);
  await sample("window.directoryAcceptance.sameIdentity.request({ type: 'set_profile', name: 'Renamed endpoint', avatar: null }, 'ack')");
  await until("rename updates the single self row", rows, value =>
    value.filter(row => row.self).length === 1 && value.some(row => row.self && row.name === "Renamed endpoint"));
  await sample(`${gate}.session.joinAsNewIdentity()`);
  await until("new identity joins the same site", () => sample(`${gate}.snapshot().self?.id`), value => value && value !== identities.self);
  if (!await sample("!!document.querySelector('#c3-companion-trigger')")) {
    await browser(0, "click", "#c3-rooms-trigger");
    await browser(0, "click", `.c3-room-link[aria-label=${JSON.stringify(identities.room.name)}]`);
  }
  if (await sample("document.querySelector('#c3-companion-trigger')?.getAttribute('aria-expanded') === 'false'"))
    await browser(0, "click", "#c3-companion-trigger");
  await browser(0, "wait", more);
  const newScope = await rows();
  assert(newScope.length < expectedCount);
  assert(newScope.some(row => row.id === identities.self && !row.self));
  assert.equal(newScope.filter(row => row.self).length, 1);
  console.log("76 rendered identities, room/online/offline, keyboard pagination, disconnect and retry, 390px, two-endpoint rename, identity switch");
} finally { await browser(0, "close"); }
