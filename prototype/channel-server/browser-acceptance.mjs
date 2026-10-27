// Local prototype acceptance: agent-browser drives real UI/session and WebRTC.
// Only OS capture is substituted with moving canvas and oscillator tracks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// On Windows the daemon can inherit a CLI pipe. Wait for the command's exit,
// rather than execFile's close event, which would also wait for that daemon.
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("agent-browser command timed out")); }, options.timeout ?? 35_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `agent-browser exited ${code}`));
    });
  });
}
const executable = process.env.AGENT_BROWSER_BIN ?? (process.platform === "win32"
  ? join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe")
  : "agent-browser");
const origin = process.env.CHANNEL_UI_ORIGIN ?? "http://127.0.0.1:8790";
assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "Acceptance only targets loopback");
const output = resolve("build/channel-acceptance");
const ownerKey = process.env.PIIK_CHANNEL_OWNER_KEY;
const inviteKey = process.env.PIIK_CHANNEL_INVITE_KEY;
assert(ownerKey && inviteKey, "Set the local server's PIIK_CHANNEL_OWNER_KEY and PIIK_CHANNEL_INVITE_KEY");
const sessionPrefix = (await run(executable, ["session", "id", "--scope", "worktree", "--prefix", "channel-acceptance"])).stdout.trim();
const sessions = ["a", "b", "c", "d", "e"].map(name => `${sessionPrefix}-${name}`);
const lifecycleOnly = process.argv.includes("--lifecycle");
const roomsOnly = process.argv.includes("--rooms");
const active = lifecycleOnly || roomsOnly ? [0, 1, 2] : [0, 1, 2, 3, 4];
async function browser(index, ...args) {
  const { stdout } = await run(executable, ["--session", sessions[index], "--json", ...args], {
    timeout: 35_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  const result = JSON.parse(stdout);
  assert(result.success, result.error ?? `agent-browser ${args[0]} failed`);
  return result.data;
}
async function evaluate(index, expression) {
  const script = `(async () => JSON.stringify(await (${expression})))()`;
  const data = await browser(index, "eval", "-b", Buffer.from(script).toString("base64"));
  return data.result === undefined ? undefined : JSON.parse(data.result);
}
async function until(label, sample, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await sample();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

function captureProbe(name) {
  return `(() => {
    localStorage.setItem('piik:ui-lang', 'en');
    localStorage.setItem('piik:ui-mode', 'text');
    const peers = [], sockets = [], captures = [], contexts = [];
    const NativePC = window.RTCPeerConnection, NativeWS = window.WebSocket;
    window.RTCPeerConnection = class extends NativePC {
      constructor(...args) { super(...args); peers.push(this); }
    };
    window.WebSocket = class extends NativeWS {
      constructor(...args) { super(...args); sockets.push(this); }
    };
    const microphone = () => {
      const context = new AudioContext(), oscillator = context.createOscillator();
      contexts.push(context);
      oscillator.frequency.value = ${330 + name.charCodeAt(0)};
      const gain = context.createGain(), destination = context.createMediaStreamDestination();
      gain.gain.value = .05; oscillator.connect(gain); gain.connect(destination); oscillator.start();
      const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.stop(); void context.close(); };
      void context.resume(); captures.push(destination.stream); return destination.stream;
    };
    navigator.mediaDevices.getUserMedia = async options => {
      if (options.video) throw new Error('This gate only substitutes microphone capture');
      return microphone();
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = 'hsl(' + (frame++ % 360) + ' 70% 40%)'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = 'white'; ctx.font = '40px sans-serif'; ctx.fillText('${name} ' + frame, 40, 150);
      }, 100);
      const stream = canvas.captureStream(10); captures.push(stream);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
    window.__channelProbe = { peers, sockets, captures, contexts,
      async sample() {
        const inbound = [], outbound = [];
        for (const pc of peers) if (pc.connectionState === 'connected') {
          for (const stat of (await pc.getStats()).values()) {
            if (stat.type === 'inbound-rtp') inbound.push({ kind: stat.kind, bytes: stat.bytesReceived,
              frames: stat.framesDecoded, samples: stat.totalSamplesReceived, energy: stat.totalAudioEnergy });
            if (stat.type === 'outbound-rtp') outbound.push({ kind: stat.kind, bytes: stat.bytesSent, frames: stat.framesEncoded });
          }
        }
        return { inbound, outbound, connections: peers.map(pc => pc.connectionState),
          videos: [...document.querySelectorAll('video')].map(video => ({ time: video.currentTime,
            frames: video.getVideoPlaybackQuality().totalVideoFrames, width: video.videoWidth, paused: video.paused })),
          captures: captures.flatMap(stream => stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }))),
          overflow: document.documentElement.scrollWidth > innerWidth,
          text: document.body.innerText.slice(-1800) };
      }
    };
  })()`;
}

const hook = "window.__channelGate";
const action = (index, expression) => evaluate(index, `${hook}.session.${expression}`);
const view = index => evaluate(index, `(() => {
  const value = ${hook}?.snapshot();
  if (!value) return { connection: 'connecting', state: null };
  return { sessionId: value.sessionId, connection: value.connection, self: value.self,
    state: value.state && { channel: value.state.channel, publications: value.state.publications,
      subscriptions: value.state.subscriptions, pairs: value.state.pairs, voice: value.state.voice },
    streams: [...value.streams.keys()], error: value.error };
})()`);
const picture = (index, publicationId) => evaluate(index, `(() => {
  const stream = ${hook}.snapshot().streams.get(${JSON.stringify(publicationId)});
  const video = [...document.querySelectorAll('video')].find(element => element.srcObject === stream);
  return { received: !!stream, frames: video?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
    time: video?.currentTime ?? 0, live: stream?.getVideoTracks().some(track => track.readyState === 'live') ?? false };
})()`);
async function playing(index, publicationId) {
  return until(`browser ${index} decodes ${publicationId}`, () => picture(index, publicationId),
    sample => sample.live && sample.frames > 0);
}
async function progressing(index, publicationId) {
  const before = await playing(index, publicationId);
  return until(`browser ${index} advances ${publicationId}`, () => picture(index, publicationId),
    sample => sample.live && sample.frames > before.frames && sample.time > before.time);
}
const publishScreen = (index, roomId) => action(index,
  `publish('screen', ${JSON.stringify(roomId)}, await navigator.mediaDevices.getDisplayMedia({video:true}))`);
async function capturedScreen(index, roomId) {
  await action(index, `startScreen(${JSON.stringify(roomId)})`);
  const current = await view(index);
  return current.state.publications.find(publication => publication.sessionId === current.sessionId && publication.kind === "screen").id;
}
const sample = index => evaluate(index, "window.__channelProbe.sample()");
const dropSignaling = index => evaluate(index,
  "window.__channelProbe.sockets.filter(socket => socket.readyState === WebSocket.OPEN && new URL(socket.url).pathname === '/prototype/channel').forEach(socket => socket.close())");
async function lifecycle(initial, roomId) {
  await action(1, `joinVoice(${JSON.stringify(roomId)}, true)`);
  assert.equal((await sample(1)).captures.filter(track => track.kind === "audio" && track.state === "live").length, 0);
  await action(1, `setMuted(${JSON.stringify(roomId)}, false)`);
  assert((await sample(1)).captures.some(track => track.kind === "audio" && track.state === "live"));
  await action(1, `leaveVoice(${JSON.stringify(roomId)})`);
  await until("leave releases microphone capture", () => sample(1), value => value.captures.every(track => track.state === "ended"));
  console.log("Listen-only takes no microphone; unmute captures; leave releases it");

  const otherScreen = await capturedScreen(2, roomId);
  await action(2, `joinVoice(${JSON.stringify(roomId)})`);
  const revokedScreen = await capturedScreen(1, roomId);
  await action(0, `setRoles(${JSON.stringify(initial[1].self.id)}, [])`);
  await until("role revocation releases the local screen", () => sample(1), value => value.captures.every(track => track.state === "ended"));
  assert(!(await view(1)).streams.includes(revokedScreen));
  await action(0, `setRoles(${JSON.stringify(initial[1].self.id)}, ['member'])`);
  console.log("Authority role revocation retires local capture");

  await action(1, `joinVoice(${JSON.stringify(roomId)})`);
  await action(1, `watch(${JSON.stringify(otherScreen)})`);
  await playing(1, otherScreen);
  await until("voice receives actual samples", () => sample(1), value => value.inbound.some(row => row.kind === "audio" && row.samples > 0));
  const sameSession = (await view(1)).sessionId;
  await browser(1, "set", "offline", "on");
  await dropSignaling(1);
  await until("signaling is offline", () => view(1), value => value.connection === "reconnecting");
  await action(1, `unwatch(${JSON.stringify(otherScreen)})`);
  await action(1, `leaveVoice(${JSON.stringify(roomId)})`);
  await until("offline stop releases microphone and playback", async () => ({ state: await view(1),
    capture: await sample(1), audio: await evaluate(1, "[...document.querySelectorAll('audio')].filter(audio => audio.srcObject && !audio.paused && !audio.muted).length") }), value =>
    value.capture.captures.every(track => track.state === "ended") && value.audio === 0 &&
    !value.state.state.subscriptions.includes(otherScreen) && !value.state.state.voice.some(member => member.sessionId === sameSession));
  await until("offline unwatch removes the local player", () => picture(1, otherScreen), value => value.frames === 0 && value.time === 0);
  await browser(1, "set", "offline", "off");
  await action(1, "reconnect()");
  await until("offline intent survives authoritative reconciliation", () => view(1), value => value.connection === "connected" &&
    value.sessionId === sameSession && !value.state.subscriptions.includes(otherScreen) &&
    !value.state.voice.some(member => member.sessionId === sameSession));
  assert((await sample(1)).captures.every(track => track.state === "ended"));
  console.log("Offline unwatch/leave immediately stop consumption and do not revive on resume");

  const expiringScreen = await capturedScreen(1, roomId);
  await action(0, `watch(${JSON.stringify(expiringScreen)})`);
  await playing(0, expiringScreen);
  const previousSession = (await view(1)).sessionId;
  await browser(1, "set", "offline", "on");
  const disconnectedAt = Date.now();
  await dropSignaling(1);
  await until("20-second authority deadline retires media", async () => ({ state: await view(1), media: await sample(1) }), value =>
    value.state.sessionId === null && value.media.captures.every(track => track.state === "ended") &&
    value.media.connections.every(connection => connection === "closed"), 28_000);
  assert(Date.now() - disconnectedAt >= 19_000, "capture must survive the bounded recovery window before expiry");
  await browser(1, "set", "offline", "off");
  await action(1, "reconnect()");
  await until("expiry admits a fresh endpoint without old capture", () => view(1), value => value.connection === "connected" &&
    value.sessionId !== previousSession && !value.state.publications.some(publication => publication.id === expiringScreen));
  assert((await sample(1)).captures.every(track => track.state === "ended"));
  console.log("Signaling deadline releases all captures/transports; a fresh session does not resurrect them");

  await browser(0, "set", "viewport", "390", "844");
  await evaluate(0, `(async () => {
    (await import('/src/client/ui/copy.ts')).setCopy({lang:'zh',vis:false});
    (await import('/src/client/ui/theme.ts')).applyTheme('light');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  assert.equal((await sample(0)).overflow, false);
  await browser(0, "screenshot", join(output, "lifecycle-zh-light-390.png"), "--full");
  await writeFile(join(output, "lifecycle-result.json"), JSON.stringify({ passed: true,
    scenarios: ["listen-only", "unmute capture", "leave capture retirement", "role revoke capture retirement",
      "offline unwatch/leave", "same-session intent reconciliation", "20s media expiry", "new-session no resurrection"],
    recoveryMs: Date.now() - disconnectedAt }, null, 2));
}

async function roomsAndFiles() {
  await browser(0, "find", "role", "button", "click", "--name", "Create room", "--exact");
  await browser(0, "fill", ".c3-room-form input:not([type])", "Movie night");
  await browser(0, "check", ".c3-room-form input[value=private]");
  await browser(0, "fill", ".c3-room-form input[type=password]", "movie-night-test");
  await browser(0, "click", ".c3-room-form button[type=submit]");
  const created = await until("new private room is selected", () => view(0), value => value.state.channel.rooms.some(room => room.name === "Movie night"));
  const room = created.state.channel.rooms.find(room => room.name === "Movie night");
  await browser(1, "click", '.c3-room-link[aria-label="Movie night"]');
  await until("unadmitted user sees password entry", () => evaluate(1, "!!document.querySelector('.c3-locked-room input')"), Boolean);
  assert.equal(await evaluate(1, "!!document.querySelector('.c3-composer')"), false);
  await browser(1, "fill", ".c3-locked-room input", "movie-night-test");
  await browser(1, "click", ".c3-locked-room button[type=submit]");
  await until("room grant opens the conversation", () => evaluate(1, "!!document.querySelector('.c3-composer textarea')"), Boolean);
  await browser(1, "fill", ".c3-composer textarea", "Hello from the private room");
  await browser(1, "click", ".c3-composer button[type=submit]");
  await until("private chat reaches its reader", () => evaluate(0, "document.querySelector('.c3-message-log').textContent"), text => text.includes("Hello from the private room"));

  const png = join(temporary, "picture.png"), text = join(temporary, "notes.txt");
  await writeFile(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=", "base64"));
  await writeFile(text, "A file shared through the actual composer.");
  await browser(1, "upload", '.c3-composer input[type="file"]', png, text);
  await until("two draft files", () => evaluate(1, "document.querySelectorAll('.c3-draft-files > div').length"), count => count === 2);
  await browser(1, "click", ".c3-composer button[type=submit]");
  await until("attachment metadata arrives in chat", () => evaluate(0, "document.querySelector('.c3-message-log').textContent"), text => text.includes("picture.png") && text.includes("notes.txt"));
  await browser(0, "find", "role", "button", "click", "--name", "View image", "--exact");
  await until("PNG preview decodes", () => evaluate(0, "[...document.querySelectorAll('.c3-attachment img')].some(image => image.complete && image.naturalWidth > 0)"), Boolean);
  await browser(0, "screenshot", join(output, "private-room-files-desktop.png"), "--full");
  console.log("Private entry, composer upload, image preview and file cards use real room authorization");

  await browser(0, "click", '.c3-room-link[aria-label="Living room"]');
  for (let start = 0; start < 1020; start += 40) {
    await evaluate(1, `(async () => {
      for (let index = ${start}; index < ${Math.min(start + 40, 1020)}; index++) await ${hook}.session.sendMessage(${JSON.stringify(room.id)}, 'history-' + index);
      return true;
    })()`);
  }
  await browser(0, "click", '.c3-room-link[aria-label="Movie night"]');
  await until("returning loads the latest contiguous history page", () => evaluate(0,
    `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}]?.length`), count => count === 100);
  for (let page = 0; page < 10; page++) {
    const anchor = page === 9 ? await evaluate(0, `(() => {
      const log = document.querySelector('.c3-message-log'); log.scrollTop = 0;
      const message = log.querySelector('[data-message-id]');
      return { id: message.dataset.messageId, offset: message.getBoundingClientRect().top - log.getBoundingClientRect().top };
    })()`) : null;
    await browser(0, "find", "role", "button", "click", "--name", "Earlier messages", "--exact");
    await until("older page advances the reading window", () => evaluate(0,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}]?.[0]?.seq`), seq => seq === Math.max(1, 923 - (page + 1) * 100));
    if (anchor) {
      await until("full-window pagination preserves the visible message", () => evaluate(0, `(() => {
        const log = document.querySelector('.c3-message-log');
        const message = [...log.querySelectorAll('[data-message-id]')].find(element => element.dataset.messageId === ${JSON.stringify(anchor.id)});
        return message.getBoundingClientRect().top - log.getBoundingClientRect().top;
      })()`), offset => Math.abs(offset - anchor.offset) <= 2);
    }
  }
  assert.equal(await evaluate(0, `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}].length`), 1000);
  assert.equal(await evaluate(0, `${hook}.snapshot().historyByRoom[${JSON.stringify(room.id)}].atLatest`), false);
  await browser(0, "screenshot", join(output, "room-history-desktop.png"), "--full");
  await browser(0, "set", "viewport", "390", "844");
  assert.equal((await sample(0)).overflow, false);
  await browser(0, "screenshot", join(output, "room-history-mobile.png"), "--full");
  await browser(0, "set", "viewport", "1280", "900");
  await action(1, `sendMessage(${JSON.stringify(room.id)}, 'Latest response')`);
  assert.equal(await evaluate(0, `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}][0].seq`), 1);
  await browser(0, "find", "role", "button", "click", "--name", "Latest messages", "--exact");
  await until("reader can return to current conversation", () => evaluate(0,
    `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}]?.at(-1)?.text`), text => text === "Latest response");
  console.log("Room history retains old messages, advances a bounded reading window and returns to latest without live interruptions");

  await browser(0, "find", "role", "button", "click", "--name", "Room settings", "--exact");
  await browser(0, "find", "label", "Hide from users without access", "check");
  await browser(0, "click", ".c3-room-form button[type=submit]");
  await until("unadmitted user loses hidden directory entry", () => view(2), value => !value.state.channel.rooms.some(value => value.id === room.id));
  await browser(0, "find", "role", "button", "click", "--name", "Room settings", "--exact");
  await browser(0, "find", "role", "button", "click", "--name", "Create room invitation", "--exact");
  const invite = await until("room invitation is ready", () => evaluate(0, "document.querySelector('.c3-invite-copy input')?.value"), value => !!value);
  const invitedSession = (await view(2)).sessionId;
  await browser(2, "open", invite);
  await until("open page enters hidden room from room invitation", () => view(2), value => value.connection === "connected" && value.state.channel.rooms.some(value => value.id === room.id && value.authorized));
  assert.equal((await view(2)).sessionId, invitedSession, "invitation navigation must retain the live endpoint");
  await evaluate(2, "localStorage.removeItem('piik.channel.prototype.credential')");
  await browser(2, "reload");
  await until("fresh user enters hidden room from room invitation", () => view(2), value => value.connection === "connected" && value.state.channel.rooms.some(value => value.id === room.id && value.authorized));
  await browser(0, "press", "Escape");

  await capturedScreen(1, room.id);
  const member = (await view(1)).self.id;
  await action(0, `revokeRoomAccess(${JSON.stringify(room.id)}, ${JSON.stringify(member)})`);
  await until("revocation retires capture and history", async () => ({ view: await view(1), probe: await sample(1),
    history: await evaluate(1, `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}]`) }),
    value => !value.view.state.channel.rooms.some(value => value.id === room.id) && !value.history && value.probe.captures.every(track => track.state === "ended"));
  console.log("Hidden-room invitation admits a new user; revocation clears private history and capture");
  await browser(0, "set", "viewport", "390", "844");
  await browser(0, "find", "role", "button", "click", "--name", "Room settings", "--exact");
  assert.equal((await sample(0)).overflow, false);
  await browser(0, "screenshot", join(output, "private-room-settings-mobile.png"), "--full");
  await browser(0, "press", "Escape");
}

// The scenario below is bound to the prototype's real session API, never a
// parallel test implementation of room state, routing or signaling.
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "piik-channel-acceptance-"));
try {
  for (const index of active) {
    const script = join(temporary, `${index}.js`);
    await writeFile(script, captureProbe(String.fromCharCode(65 + index)));
    await browser(index, "--args", "--no-sandbox,--autoplay-policy=no-user-gesture-required", "--init-script", script,
      "open", `${origin}/__channel-preview#${index === 0 ? "owner" : "invite"}=${encodeURIComponent(index === 0 ? ownerKey : inviteKey)}`);
  }
  const initial = [];
  for (const index of active) {
    await until(`browser ${index} authenticates`, () => evaluate(index,
      `${hook} ? ${hook}.snapshot().connection : 'no hook'`), value => value === "connected");
    await action(index, `renameSelf(${JSON.stringify(String.fromCharCode(65 + index))})`);
    initial.push(await view(index));
  }
  const roomId = initial[0].state.channel.rooms[0].id;
  assert.equal(initial[0].self.id, initial[0].state.channel.ownerId);
  if (roomsOnly) {
    await roomsAndFiles();
    console.log(`Room and file Browser acceptance passed; evidence: ${output}`);
  } else if (lifecycleOnly) {
    await lifecycle(initial, roomId);
    console.log(`Focused lifecycle acceptance passed; evidence: ${output}`);
  } else {
  console.log("Five independent Browser sessions authenticated");

  let secondPublisher = 1;
  let secondPublication = await publishScreen(1, roomId);
  const primaryPublication = await publishScreen(2, roomId);
  for (const index of [0, 3, 4]) await action(index, `watch(${JSON.stringify(secondPublication)})`);
  await action(4, `watch(${JSON.stringify(primaryPublication)})`);
  await Promise.all([playing(3, secondPublication), playing(4, secondPublication), playing(4, primaryPublication)]);
  assert(!(await view(3)).streams.includes(primaryPublication), "selective watcher D must not receive C's screen");
  await browser(4, "screenshot", join(output, "desktop-two-sources.png"), "--full");
  await evaluate(4, "(() => { window.__focusPlayers = [...document.querySelectorAll('video')]; return true; })()");
  const subscriptionsBeforeFocus = (await view(4)).state.subscriptions;
  await browser(4, "click", `[data-publication-id="${primaryPublication}"] button[aria-label^="Focus"]`);
  assert.equal(await evaluate(4, "document.querySelectorAll('.c3-monitor-grid.is-focused').length"), 1);
  assert.equal(await evaluate(4, "window.__focusPlayers.every(video => video.isConnected)"), true);
  assert.deepEqual((await view(4)).state.subscriptions, subscriptionsBeforeFocus);
  await browser(4, "find", "role", "button", "click", "--name", "Grid view", "--exact");
  await progressing(4, primaryPublication);
  console.log("Two simultaneous sources; D receives only B; E decodes both");

  const initialRoutes = await Promise.all([0, 3, 4].map(index => view(index)));
  const leaf = [0, 3, 4][initialRoutes.findIndex(value => !value.state.pairs.some(pair => pair.outgoing.includes(secondPublication)))];
  assert(leaf !== undefined, "distribution must have a leaf viewer");
  await action(leaf, `unwatch(${JSON.stringify(secondPublication)})`);
  await until("leaf stops watching", () => view(leaf), value => !value.state.subscriptions.includes(secondPublication));
  await action(leaf, `watch(${JSON.stringify(secondPublication)})`);
  await progressing(leaf, secondPublication);

  for (const index of [0, 1, 4]) await action(index,
    `joinVoice(${JSON.stringify(roomId)}, false, await navigator.mediaDevices.getUserMedia({audio:true}))`);
  await until("real voice audio energy", () => evaluate(4, "window.__channelProbe.sample()"),
    sample => sample.inbound.some(row => row.kind === "audio" && row.samples > 0 && row.energy > 0));
  const voicePairs = (await view(4)).state.pairs.map(pair => pair.id).sort();
  await action(4, `setDeafened(${JSON.stringify(roomId)}, true)`);
  await until("deafen mutes local voice sinks", () => evaluate(4,
    "[...document.querySelectorAll('audio')].filter(audio => audio.srcObject).map(audio => audio.muted)"), values => values.length > 0 && values.every(Boolean));
  assert.deepEqual((await view(4)).state.pairs.map(pair => pair.id).sort(), voicePairs, "local deafen must retain routing transports");
  await action(4, `setDeafened(${JSON.stringify(roomId)}, false)`);
  console.log("Real voice samples arrive alongside picture sharing");

  for (const index of [1, 0, 3]) await action(index, `watch(${JSON.stringify(primaryPublication)})`);
  await Promise.all([0, 1, 3, 4].map(index => playing(index, primaryPublication)));
  const routed = await Promise.all(sessions.map((_, index) => view(index)));
  const relay = routed.findIndex((state, index) => index !== 2 && state.state.pairs.some(pair => pair.outgoing.includes(primaryPublication)));
  assert(relay >= 0, "source fanout two must produce an actual peer relay for four viewers");
  const sourceCopies = routed[2].state.pairs.filter(pair => pair.outgoing.includes(primaryPublication)).length;
  assert(sourceCopies <= 2, `source fanout exceeded: ${sourceCopies}`);
  if (relay !== secondPublisher) {
    await action(secondPublisher, `stopScreen(${JSON.stringify(secondPublication)})`);
    secondPublisher = relay;
    secondPublication = await publishScreen(relay, roomId);
    const watcher = relay === 4 ? 0 : 4;
    await action(watcher, `watch(${JSON.stringify(secondPublication)})`);
    await playing(watcher, secondPublication);
  }
  await action(secondPublisher, `stopScreen(${JSON.stringify(secondPublication)})`);
  await progressing(relay, primaryPublication);
  const relayView = await view(relay);
  assert(relayView.state.pairs.some(pair => pair.outgoing.includes(primaryPublication)), "own source retirement must retain another source's forwarding");
  console.log(`Browser ${relay} stopped its own source and keeps receiving/forwarding C`);

  const downstream = relayView.state.pairs.find(pair => pair.outgoing.includes(primaryPublication)).peerId;
  const downstreamIndex = routed.findIndex(value => value.sessionId === downstream);
  assert(downstreamIndex >= 0);
  const transitPairs = relayView.state.pairs.filter(pair => pair.incoming.includes(primaryPublication) || pair.outgoing.includes(primaryPublication)).map(pair => pair.id).sort();
  await action(relay, `unwatch(${JSON.stringify(primaryPublication)})`);
  const transit = await until("relay stops local consumption", () => view(relay), value => !value.state.subscriptions.includes(primaryPublication));
  assert.deepEqual(transit.state.pairs.filter(pair => pair.incoming.includes(primaryPublication) || pair.outgoing.includes(primaryPublication)).map(pair => pair.id).sort(), transitPairs);
  await until("transit has no local player", () => picture(relay, primaryPublication), value => value.frames === 0);
  await progressing(downstreamIndex, primaryPublication);
  await action(relay, `watch(${JSON.stringify(primaryPublication)})`);
  await progressing(relay, primaryPublication);
  console.log("Unwatch stops the relay's local player and preserves its downstream frames and pair IDs");

  await browser(4, "click", `.c3-room-link[aria-label=${JSON.stringify(initial[0].state.channel.rooms[1].name)}]`);
  await progressing(4, primaryPublication);
  assert((await view(4)).state.subscriptions.includes(primaryPublication));
  await action(4, `browse(${JSON.stringify(roomId)})`);
  const beforeReconnect = (await view(4)).sessionId;
  await evaluate(4, "window.__channelProbe.sockets.filter(socket => socket.readyState === WebSocket.OPEN && new URL(socket.url).pathname === '/prototype/channel').forEach(socket => socket.close())");
  await action(4, "reconnect()");
  await until("same endpoint reconnects", () => view(4), value => value.connection === "connected" && value.sessionId === beforeReconnect);
  await progressing(4, primaryPublication);
  console.log("Room browsing and signaling reconnect preserve current media");

  await browser(relay, "close");
  await progressing(downstreamIndex, primaryPublication);
  const repaired = await until("relay exit is removed from recovered route", () => view(downstreamIndex), value =>
    value.state.pairs.some(pair => pair.incoming.includes(primaryPublication) && pair.peerId !== routed[relay].sessionId));
  assert(repaired.streams.includes(primaryPublication));
  console.log("Relay exit recovers its downstream subscription");

  const layoutIndex = relay === 4 ? 0 : 4;
  await browser(layoutIndex, "set", "viewport", "390", "844");
  for (const lang of ["zh", "en"]) for (const theme of ["light", "dark"]) {
    await evaluate(layoutIndex, `(async () => {
      (await import('/src/client/ui/copy.ts')).setCopy({lang:${JSON.stringify(lang)},vis:false});
      (await import('/src/client/ui/theme.ts')).applyTheme(${JSON.stringify(theme)});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`);
    const layout = await evaluate(layoutIndex, `({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      lang: document.documentElement.lang, theme: document.documentElement.dataset.theme })`);
    assert(layout.lang.startsWith(lang), `language did not update: ${JSON.stringify(layout)}`);
    assert.equal(layout.theme, theme);
    assert(layout.scroll <= layout.width, `${lang}/${theme} page overflows at 390px: ${JSON.stringify(layout)}`);
    await browser(layoutIndex, "screenshot", join(output, `${lang}-${theme}-390.png`), "--full");
  }
  await writeFile(join(output, "result.json"), JSON.stringify({ scenarios: ["two sources", "selective watching", "voice", "fanout relay",
    "independent source stop", "transit without local watching", "room browsing", "signaling reconnect", "relay recovery", "bilingual themes at 390px"],
    sourceCopies, relay, downstreamIndex }, null, 2));
  console.log(`Browser acceptance passed; evidence: ${output}`);
  }
} catch (error) {
  const evidence = await Promise.all(active.map(index => evaluate(index,
    "window.__channelProbe?.sample() ?? { text: document.body.innerText.slice(-1800) }").catch(failure => ({ error: String(failure) }))));
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), evidence }, null, 2));
  throw error;
} finally {
  await Promise.allSettled(active.map(index => browser(index, "close")));
  await Promise.allSettled([...active.map(index => `${index}.js`), "picture.png", "notes.txt"].map(name => unlink(join(temporary, name))));
  await rmdir(temporary);
}
