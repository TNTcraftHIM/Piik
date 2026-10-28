// Local prototype acceptance: agent-browser drives real UI/session and WebRTC.
// Only OS capture is substituted with moving canvas and oscillator tracks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeRoom } from "./browser-native-acceptance.mjs";
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
const sessionPrefix = `channel-acceptance-${randomUUID()}`;
const sessions = ["a", "b", "c", "d", "e"].map(name => `${sessionPrefix}-${name}`);
const lifecycleOnly = process.argv.includes("--lifecycle");
const roomsOnly = process.argv.includes("--rooms");
const hostsOnly = process.argv.includes("--hosts");
const baseOnly = process.argv.includes("--base");
const nativeOnly = process.argv.includes("--native");
const active = baseOnly ? [0, 1, 2, 3] : lifecycleOnly || roomsOnly || hostsOnly || nativeOnly ? [0, 1, 2] : [0, 1, 2, 3, 4];
async function browser(index, ...args) {
  // Omitting launch options on later commands selects a different Browser context.
  const { stdout } = await run(executable, ["--session", sessions[index], "--json",
    "--args", "--no-sandbox,--autoplay-policy=no-user-gesture-required",
    "--init-script", join(temporary, `${index}.js`), ...args], {
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
    const peers = [], sockets = [], captures = [], contexts = [], protocol = [], channels = [], warnings = [];
    const conversationWS = Object.create(null);
    const warn = console.warn.bind(console);
    console.warn = (...args) => { warnings.push(args.map(value => String(value))); if (warnings.length > 20) warnings.shift(); warn(...args); };
    const blockedPeers = new Set(), pairPeers = new Map(), flowPublications = new Map(), senders = [], channelOwners = new Map();
    let videoStall = null;
    let blockedOffers = 0;
    const record = (direction, data) => {
      const event = JSON.parse(data);
      const command = event.input?.action?.command;
      const type = command?.type ?? ((event.output?.reply?.result?.type ?? event.result?.type) === 'history' ? 'history' : event.type);
      const room = command?.roomId ?? event.roomId;
      if (room && (type === 'chat' || type === 'history')) {
        const counts = conversationWS[room] ??= { sent: { chat: 0, history: 0 }, received: { chat: 0, history: 0 } };
        counts[direction][type]++;
      }
      for (const pair of event.state?.pairs ?? []) {
        pairPeers.set(pair.id, pair.peerId);
        for (const flow of [...pair.incoming, ...pair.outgoing]) flowPublications.set(flow.id, flow.publicationId);
      }
      protocol.push({ direction, type:event.type, room:event.roomId, request:event.requestId,
        action:event.input?.action?.type, revision:event.input?.revision ?? event.output?.revision,
        binding:event.bindingId ?? event.input?.bindingId ?? event.output?.bindingId,
        result:event.result?.type ?? event.output?.reply?.result?.type, code:event.code,
        pair:event.pairId, ready:event.ready, state:event.state && typeof event.state === 'string' ? event.state : undefined });
      if (protocol.length > 64) protocol.shift();
      return event;
    };
    const NativePC = window.RTCPeerConnection, NativeWS = window.WebSocket;
    const recordChannel = (pc, channel) => {
      channels.push(channel);
      const owned = channelOwners.get(pc) ?? []; owned.push(channel); channelOwners.set(pc, owned);
      return channel;
    };
    window.RTCPeerConnection = class extends NativePC {
      constructor(...args) { super(...args); peers.push(this); this.addEventListener('datachannel', event => recordChannel(this, event.channel)); }
      createDataChannel(...args) { return recordChannel(this, super.createDataChannel(...args)); }
      addTrack(track, ...streams) {
        const sender = super.addTrack(track, ...streams);
        senders.push({ pc: this, sender, streams: streams.map(stream => stream.id) });
        return sender;
      }
    };
    window.WebSocket = class extends NativeWS {
      constructor(...args) { super(...args); sockets.push(this); this.addEventListener('message', message => {
        const event = record('received', message.data);
        if (event.type === 'signal' && blockedPeers.has(event.fromSessionId)) {
          if (event.payload?.description?.type === 'offer') blockedOffers++;
          message.stopImmediatePropagation();
        }
      }); }
      send(data) { const event = record('sent', data);
        if (event.type === 'signal' && blockedPeers.has(pairPeers.get(event.pairId))) return;
        const fault = videoStall;
        const binding = fault && event.type === 'signal' && event.payload?.description && pairPeers.get(event.pairId) === fault.peerId
          && event.payload.tracks?.find(track => flowPublications.get(track.flowId) === fault.publicationId);
        if (binding) {
          if (!fault.pending) {
            const output = senders.find(output => output.pc.localDescription?.sdp === event.payload.description.sdp
              && output.streams.includes(binding.streamId) && output.sender.track?.kind === 'video');
            fault.pending = (async () => {
              if (!output || event.payload.description.type !== 'offer') throw new Error('Video stall requires its initial sender offer');
              const parameters = output.sender.getParameters();
              if (!parameters.encodings?.length) throw new Error('Video sender has no controllable encoding');
              parameters.encodings.forEach(encoding => { encoding.active = false; });
              await output.sender.setParameters(parameters);
              Object.assign(fault, { output, pairId: event.pairId, flowId: binding.flowId, startedAt: Date.now() });
            })();
          }
          // Install the real sender fault before its original offer can reach the receiver.
          void fault.pending.then(() => super.send(data)).catch(error => { fault.error = String(error); });
          return;
        }
        return super.send(data);
      }
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
      blockPeer(sessionId) { blockedPeers.add(sessionId); },
      unblockPeer(sessionId) { blockedPeers.delete(sessionId); },
      stallVideo(publicationId, peerId) { videoStall = { publicationId, peerId }; },
      async restoreVideo() {
        const fault = videoStall; videoStall = null;
        await fault?.pending?.catch(() => {});
        if (!fault?.output?.sender.track || fault.output.pc.connectionState === 'closed') return;
        const parameters = fault.output.sender.getParameters();
        parameters.encodings.forEach(encoding => { encoding.active = true; });
        await fault.output.sender.setParameters(parameters);
      },
      closeDataChannels() { for (const channel of channels) channel.close(); },
      async sample() {
        const inbound = [], outbound = [];
        for (const pc of peers) if (pc.connectionState === 'connected') {
          for (const stat of (await pc.getStats()).values()) {
            if (stat.type === 'inbound-rtp') inbound.push({ kind: stat.kind, bytes: stat.bytesReceived,
              frames: stat.framesDecoded, samples: stat.totalSamplesReceived, energy: stat.totalAudioEnergy });
            if (stat.type === 'outbound-rtp') outbound.push({ kind: stat.kind, bytes: stat.bytesSent, frames: stat.framesEncoded });
          }
        }
        const fault = videoStall, stalled = fault?.output;
        let stalledBytes = 0;
        if (stalled?.sender.track) for (const report of (await stalled.sender.getStats()).values()) {
          if (report.type === 'outbound-rtp' && report.kind === 'video') stalledBytes += report.bytesSent ?? 0;
        }
        return { inbound, outbound, protocol, conversationWS, warnings, blockedOffers,
          videoStall: fault && { publicationId: fault.publicationId, peerId: fault.peerId, pairId: fault.pairId,
            flowId: fault.flowId, startedAt: fault.startedAt, error: fault.error, bytes: stalledBytes,
            connected: stalled?.pc.connectionState === 'connected',
            roomOpen: stalled && channelOwners.get(stalled.pc)?.some(channel => channel.label === 'piik-room' && channel.readyState === 'open'),
            active: stalled?.sender.getParameters().encodings.map(encoding => encoding.active) },
          connections: peers.map(pc => pc.connectionState),
          channels: channels.map(channel => ({ label: channel.label, state: channel.readyState })),
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
      subscriptions: value.state.subscriptions, pairs: value.state.pairs, voice: value.state.voice, files: value.state.files },
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
  const current = await until("captured screen is admitted", () => view(index), value => value.state.publications.some(publication =>
    publication.sessionId === value.sessionId && publication.roomId === roomId && publication.kind === "screen"));
  return current.state.publications.find(publication => publication.sessionId === current.sessionId && publication.roomId === roomId && publication.kind === "screen").id;
}
const sample = index => evaluate(index, "window.__channelProbe.sample()");
async function voiceProgressing(index, publicationId) {
  let previous = null;
  return until(`browser ${index} receives advancing voice ${publicationId}`, () => evaluate(index, `(async () => {
    const current = () => ${hook}.snapshot().streams.get(${JSON.stringify(publicationId)});
    const track = current()?.getAudioTracks().find(track => track.readyState === 'live');
    if (!track) return null;
    const pc = window.__channelProbe.peers.find(pc => pc.connectionState === 'connected'
      && pc.getReceivers().some(receiver => receiver.track === track));
    const receiver = pc?.getReceivers().find(receiver => receiver.track === track);
    if (!receiver) return null;
    const stats = await receiver.getStats();
    if (pc.connectionState !== 'connected' || !current()?.getAudioTracks().includes(track)) return null;
    return { trackId: track.id, reports: [...stats.values()]
      .filter(report => report.type === 'inbound-rtp' && report.kind === 'audio' && report.isRemote !== true)
      .map(report => ({ id: report.id, samples: report.totalSamplesReceived, energy: report.totalAudioEnergy })) };
  })()`), current => {
    const advancing = current && previous?.trackId === current.trackId && current.reports.some(report => {
      const before = previous.reports.find(before => before.id === report.id);
      return before && Number.isFinite(report.samples) && Number.isFinite(report.energy)
        && report.samples > before.samples && report.energy > before.energy;
    });
    previous = current;
    return advancing;
  });
}
async function assertNoError(index, flow) {
  const current = await view(index);
  if (current.error === null) return;
  assert.fail(`${flow} left an unexpected error in browser ${index}: ${JSON.stringify({
    error: current.error, protocol: (await sample(index)).protocol,
  })}`);
}
const dropSignaling = index => evaluate(index,
  "window.__channelProbe.sockets.filter(socket => socket.readyState === WebSocket.OPEN && new URL(socket.url).pathname === '/prototype/channel').forEach(socket => socket.close())");

async function senderAllocationFailure() {
  const result = await evaluate(0, `(async () => {
    const { ChannelTransport } = await import('/src/client/channel/transport.ts');
    const deadline = Date.now() + 25000;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async (label, sample) => {
      while (Date.now() < deadline) { if (await sample()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(label);
    };
    const context = new AudioContext(), oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start(); await context.resume();
    const audio = destination.stream.getAudioTracks()[0];
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const paint = canvas.getContext('2d'); let frame = 0;
    const timer = setInterval(() => { paint.fillStyle = 'hsl(' + (++frame * 13 % 360) + ' 80% 50%)'; paint.fillRect(0, 0, 160, 90); }, 50);
    const video = canvas.captureStream(20).getVideoTracks()[0], secondVideo = video.clone();
    const failures = [], errors = [], received = [], consumers = [], inputs = new Map();
    const warn = console.warn;
    console.warn = (...args) => { if (args[0] === 'Channel media sender attach failed') errors.push(args[2]?.name); warn(...args); };
    let left, right;
    const options = (polite, send) => ({ polite, iceServers: [], send, connected() {}, base() {},
      failed() { failures.push('pair'); }, outgoingFailed(id) { failures.push(id); },
      receive(id, stream) {
        inputs.set(id, stream);
        const element = document.createElement(stream.getVideoTracks().length ? 'video' : 'audio');
        element.muted = true; element.autoplay = true; element.srcObject = stream;
        element.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0'; document.body.append(element);
        consumers.push(element); void element.play().catch(() => {});
      }, data(kind, data) { received.push(data); },
    });
    const stats = async () => {
      const values = [];
      for (const [side, pc] of [['sender', left.pc], ['receiver', right.pc]]) {
        for (const report of (await pc.getStats()).values()) {
          if (report.type === (side === 'sender' ? 'outbound-rtp' : 'inbound-rtp') && (report.kind ?? report.mediaType) === 'audio') {
            values.push({ side, id: report.id, packets: report.packetsSent ?? report.packetsReceived ?? 0 });
          }
        }
      }
      return values;
    };
    const advancing = (before, after) => ['sender', 'receiver'].every(side => before.some(old => old.side === side &&
      after.some(next => next.side === side && next.id === old.id && next.packets > old.packets)));
    const videoSample = async id => {
      const track = inputs.get(id)?.getVideoTracks()[0];
      const receiver = right.pc.getReceivers().find(receiver => receiver.track === track);
      if (!receiver) return null;
      const report = [...(await receiver.getStats()).values()].find(report => report.type === 'inbound-rtp' && report.kind === 'video');
      return report ? { id: report.id, frames: report.framesDecoded ?? 0 } : null;
    };
    const voice = { kind: 'voice', stream: new MediaStream([audio]) };
    try {
      left = new ChannelTransport(options(false, signal => right.signal(signal)));
      right = new ChannelTransport(options(true, signal => left.signal(signal)));
      left.setRooms(['allocation-check']); right.setRooms(['allocation-check']);
      left.setOutgoing(new Map([['voice', voice]]));
      await wait('voice and base channels did not establish', async () => inputs.has('voice') && left.isBaseReady() && right.isBaseReady() && (await stats()).every(value => value.packets > 0) && (await stats()).length >= 2);
      const before = await stats();
      left.setOutgoing(new Map([['voice', voice], ['failed-screen', { kind: 'screen', stream: new MediaStream([video, audio]) }]]));
      check(errors.length === 1 && errors[0] === 'InvalidAccessError', 'Chrome must reject the duplicate audio track itself');
      check(failures.length === 1 && failures[0] === 'failed-screen', 'only the failed flow reports allocation failure');
      check(left.pc.getSenders().filter(sender => sender.track).length === 1 && left.pc.getSenders().some(sender => sender.track === audio), 'partial video sender was not rolled back');
      check([audio, video, secondVideo].every(track => track.readyState === 'live'), 'allocation failure stopped a source track');
      const failed = { kind: 'screen', stream: new MediaStream([video]) };
      for (let repeat = 0; repeat < 3; repeat++) left.setOutgoing(new Map([['voice', voice], ['failed-screen', failed]]));
      check(errors.length === 1 && left.pc.getSenders().filter(sender => sender.track).length === 1, 'same failed lease was allocated again');
      const good = { kind: 'screen', stream: new MediaStream([secondVideo]) };
      left.setOutgoing(new Map([['voice', voice], ['failed-screen', failed], ['good-screen', good]]));
      await wait('a later legal screen did not receive media', async () => (await videoSample('good-screen'))?.frames > 1);
      left.setOutgoing(new Map([['voice', voice], ['good-screen', good]]));
      left.setOutgoing(new Map([['voice', voice], ['good-screen', good], ['new-screen', failed]]));
      await wait('a new lease could not allocate the retired flow source', async () => (await videoSample('new-screen'))?.frames > 0);
      const pictureBefore = await videoSample('new-screen');
      await wait('new lease picture did not advance on its own receiver', async () => {
        const next = await videoSample('new-screen'); return next?.id === pictureBefore.id && next.frames > pictureBefore.frames;
      });
      await left.sendData('control', 'after-allocation-failure');
      await wait('voice or base stopped after a flow allocation failure', async () => received.includes('after-allocation-failure') && advancing(before, await stats()));
      check(failures.length === 1 && left.pc.connectionState === 'connected' && right.pc.connectionState === 'connected', 'flow allocation failed the shared pair');
      return { passed: true, error: errors[0], failures, before, after: await stats(), baseMessage: true, retiredLeaseReallocated: true };
    } finally {
      left?.close(); right?.close(); console.warn = warn; clearInterval(timer);
      for (const element of consumers) { element.pause(); element.srcObject = null; element.remove(); }
      for (const track of [audio, video, secondVideo]) track.stop(); oscillator.stop(); oscillator.disconnect(); await context.close();
    }
  })()`);
  await writeFile(join(output, 'sender-allocation-result.json'), JSON.stringify(result, null, 2));
  return result;
}

async function roomBase(initial, serverRoom) {
  const source = await capturedScreen(1, serverRoom);
  await action(2, `watch(${JSON.stringify(source)})`);
  await playing(2, source);
  const originalPair = (await view(2)).state.pairs.find(pair => pair.incoming.some(flow => flow.publicationId === source)).id;
  const room = await action(1, "createRoom({name:'Connected room',access:'public',hidden:false})");
  for (const index of [1, 2]) await browser(index, "click", '.c3-room-link[aria-label="Connected room"]');
  await until("base reuses the existing screen connection", () => view(2), value =>
    value.state.pairs.some(pair => pair.id === originalPair && pair.rooms.includes(room)));
  await until("room DataChannel opens", () => sample(2), value => value.channels.some(channel => channel.state === "open"));

  // Prevent this pair's real SDP/ICE exchange. Other peer negotiations still run.
  // This is a controlled unreachable edge, not a model of a particular NAT.
  await evaluate(1, `window.__channelProbe.blockPeer(${JSON.stringify(initial[3].sessionId)})`);
  await evaluate(3, `window.__channelProbe.blockPeer(${JSON.stringify(initial[1].sessionId)})`);
  await browser(3, "click", '.c3-room-link[aria-label="Connected room"]');
  await until("D reaches its room through C after B-D fails", () => view(3), value =>
    value.state.pairs.some(pair => pair.peerId === initial[2].sessionId && pair.rooms.includes(room)), 35_000);
  await action(1, `joinVoice(${JSON.stringify(room)}, true)`);
  await action(3, `joinVoice(${JSON.stringify(room)})`);
  await until("voice crosses the base transit", () => sample(1), value =>
    value.inbound.some(report => report.kind === "audio" && report.samples > 0 && report.energy > 0));
  const dVoice = (await view(3)).state.publications.find(value => value.sessionId === initial[3].sessionId && value.kind === "voice").id;
  const cTransit = await view(2);
  assert(cTransit.state.pairs.some(pair => pair.incoming.some(flow => flow.publicationId === dVoice)));
  assert(cTransit.state.pairs.some(pair => pair.outgoing.some(flow => flow.publicationId === dVoice)));
  assert(!cTransit.state.subscriptions.includes(dVoice), "transit does not join voice or play it locally");
  assert(await evaluate(2, "[...document.querySelectorAll('audio')].filter(audio => audio.srcObject).every(audio => audio.hidden && audio.muted)"),
    "transit decoder consumers must remain silent and absent from local playback");
  await progressing(2, source);

  const basePicture = await capturedScreen(3, room);
  await action(1, `watch(${JSON.stringify(basePicture)})`);
  await playing(1, basePicture);
  assert((await view(1)).state.pairs.some(pair => pair.peerId === initial[2].sessionId && pair.incoming.some(flow => flow.publicationId === basePicture)),
    "picture startup uses the reachable base transit despite a blocked direct path");
  assert(!(await view(2)).state.subscriptions.includes(basePicture), "picture transit does not require local viewing");

  await action(1, `setMuted(${JSON.stringify(room)}, false)`);
  await until("reverse voice crosses the same base edges", () => sample(3), value =>
    value.inbound.some(report => report.kind === "audio" && report.samples > 0 && report.energy > 0));
  const voicePairIds = (await view(1)).state.pairs.map(pair => pair.id).sort();
  await action(1, `setDeafened(${JSON.stringify(room)}, true)`);
  await until("deafen only mutes local voice", () => evaluate(1,
    "[...document.querySelectorAll('audio')].filter(audio => audio.srcObject).map(audio => audio.muted)"), value => value.length > 0 && value.every(Boolean));
  assert.deepEqual((await view(1)).state.pairs.map(pair => pair.id).sort(), voicePairIds);
  await action(1, `setDeafened(${JSON.stringify(room)}, false)`);
  await browser(2, "click", '.c3-room-link[aria-label="Living room"]');
  assert((await view(2)).state.pairs.some(pair => pair.rooms.includes(room)), "leaving the view preserves necessary transit");
  await progressing(2, source);

  await browser(0, "click", '.c3-room-link[aria-label="Connected room"]');
  await until("A becomes an available base branch", () => view(0), value => value.state.pairs.some(pair => pair.rooms.includes(room)));
  await action(0, `watch(${JSON.stringify(source)})`);
  await playing(0, source);
  const survivingPair = (await view(0)).state.pairs.find(pair => pair.incoming.some(flow => flow.publicationId === source)).id;

  // The media edge must time out independently of its connected room/voice transport.
  const stalledPicture = await capturedScreen(1, room);
  let mediaPrepare;
  try {
    await action(0, `watch(${JSON.stringify(stalledPicture)})`);
    await playing(0, stalledPicture); // A is a real, already-supplied alternative parent.
    await evaluate(1, `window.__channelProbe.unblockPeer(${JSON.stringify(initial[3].sessionId)})`);
    await evaluate(3, `window.__channelProbe.unblockPeer(${JSON.stringify(initial[1].sessionId)})`);
    await evaluate(2, `window.__channelProbe.stallVideo(${JSON.stringify(stalledPicture)}, ${JSON.stringify(initial[3].sessionId)})`);
    await action(3, `watch(${JSON.stringify(stalledPicture)})`);
    const blocked = await until("C disables only the new picture sender to D", () => sample(2), value =>
      value.videoStall?.flowId || value.videoStall?.error);
    const fault = blocked.videoStall;
    assert.equal(fault.error, undefined);
    assert(fault.connected && fault.roomOpen && fault.active.length > 0 && fault.active.every(active => active === false),
      "the stalled video shares an already-connected PC and open room DataChannel");
    assert.equal(fault.bytes, 0, "the disabled video sender emitted no RTP before its first proof");
    const waiting = await view(3);
    assert(waiting.state.pairs.some(pair => pair.id === fault.pairId && pair.rooms.includes(room)
      && pair.incoming.some(flow => flow.id === fault.flowId && flow.publicationId === stalledPicture)),
      "the unproved picture starts on the existing C-D base pair");
    assert.equal((await picture(3, stalledPicture)).frames, 0);
    const voiceIds = waiting.state.publications.filter(publication => publication.kind === "voice" && publication.roomId === room).map(publication => publication.id);
    const bVoice = waiting.state.publications.find(publication => publication.kind === "voice" && publication.roomId === room
      && publication.sessionId === initial[1].sessionId).id;
    const voiceFlows = pair => [...pair.incoming, ...pair.outgoing].filter(flow => voiceIds.includes(flow.publicationId)).map(flow => flow.id).sort();
    const originalBase = waiting.state.pairs.find(pair => pair.id === fault.pairId);
    const repaired = await until("unproved video retires its flow and uses another supplied parent", () => view(3), value =>
      !value.state.pairs.some(pair => pair.incoming.some(flow => flow.id === fault.flowId))
      && value.state.pairs.some(pair => pair.peerId !== initial[2].sessionId
        && pair.incoming.some(flow => flow.publicationId === stalledPicture)), 35_000);
    const elapsedMs = Date.now() - fault.startedAt;
    await progressing(3, stalledPicture);
    const retainedBase = repaired.state.pairs.find(pair => pair.id === fault.pairId && pair.rooms.includes(room));
    assert(retainedBase,
      "a media prepare timeout preserves the original room/voice pair");
    assert.deepEqual(voiceFlows(retainedBase), voiceFlows(originalBase), "video timeout does not replace the shared pair's voice flows");
    await voiceProgressing(1, dVoice);
    await voiceProgressing(3, bVoice);
    const replacement = repaired.state.pairs.flatMap(pair => pair.incoming.filter(flow => flow.publicationId === stalledPicture)
      .map(flow => ({ pairId: pair.id, peerId: pair.peerId, flowId: flow.id })));
    mediaPrepare = { retiredFlow: fault.flowId, retainedBasePair: fault.pairId, replacement,
      elapsedMs, blockedVideoBytes: fault.bytes, bidirectionalVoice: true };
    await writeFile(join(output, "base-media-prepare.json"), JSON.stringify({ passed: true, ...mediaPrepare }, null, 2));
  } finally {
    try { await evaluate(2, "window.__channelProbe.restoreVideo()"); }
    finally {
      await action(1, `stopScreen(${JSON.stringify(stalledPicture)})`);
      await evaluate(1, `window.__channelProbe.blockPeer(${JSON.stringify(initial[3].sessionId)})`);
      await evaluate(3, `window.__channelProbe.blockPeer(${JSON.stringify(initial[1].sessionId)})`);
    }
  }
  await evaluate(2, "window.__channelProbe.closeDataChannels()");
  await until("D repairs through A after its transit DataChannel closes", () => view(3), value =>
    value.state.pairs.some(pair => pair.rooms.includes(room) && pair.peerId === initial[0].sessionId), 30_000);
  await voiceProgressing(1, dVoice);
  await progressing(0, source);
  await progressing(2, source);
  assert((await view(2)).state.pairs.some(pair => pair.id === originalPair && pair.incoming.some(flow => flow.publicationId === source)), "a failed DataChannel must not close the same pair's healthy picture");
  assert((await view(0)).state.pairs.some(pair => pair.id === survivingPair && pair.incoming.some(flow => flow.publicationId === source)), "base repair preserves unrelated screen transport");
  await progressing(1, basePicture);
  await browser(2, "close");
  await until("picture repairs through the surviving base branch", () => view(1), value =>
    value.state.pairs.some(pair => pair.peerId === initial[0].sessionId && pair.incoming.some(flow => flow.publicationId === basePicture)), 30_000);
  await progressing(1, basePicture);
  await action(3, `stopScreen(${JSON.stringify(basePicture)})`);

  for (const index of [1, 3]) await action(index, `leaveVoice(${JSON.stringify(room)})`);
  await until("last voice stops without closing base connections", () => view(3), value =>
    !value.state.voice.some(member => member.roomId === room) && value.state.pairs.some(pair => pair.rooms.includes(room)));
  for (const index of [0, 3]) await browser(index, "click", '.c3-room-link[aria-label="Living room"]');
  await until("last room demand releases only base leases", () => view(0), value =>
    !value.state.pairs.some(pair => pair.rooms.includes(room)) && value.state.pairs.some(pair => pair.id === survivingPair && pair.incoming.some(flow => flow.publicationId === source)));
  await progressing(0, source);
  await action(1, `stopScreen(${JSON.stringify(source)})`);
  await until("last physical lease closes the pair", () => view(0), value => !value.state.pairs.some(pair => pair.id === survivingPair));
  for (const index of [0, 1, 3]) await assertNoError(index, "room base lifecycle");
  await writeFile(join(output, "base-result.json"), JSON.stringify({ passed: true, mediaPrepare,
    scenarios: ["room entry without capture", "media/base transport reuse", "unreachable direct edge",
      "picture startup through non-viewing base transit", "picture recovery after transit departure",
      "bidirectional voice through a non-listener", "deafen keeps routes", "view change preserves transit",
      "connected video without RTP times out without retiring base or voice", "failed DataChannel repairs voice without closing healthy RTP", "retired transit leaves independently",
      "repair preserves another room's picture", "voice stop keeps base", "last lease retirement"] }, null, 2));
  console.log("Room DataChannels, bidirectional voice transit and shared media leases passed real Browser acceptance");
}

async function roomOwner(initial, serverRoom) {
  const serverBefore = (await sample(0)).conversationWS[serverRoom];
  await action(0, `sendMessage(${JSON.stringify(serverRoom)}, 'Server room through WebSocket')`);
  await action(0, `loadLatestHistory(${JSON.stringify(serverRoom)})`);
  const serverWS = (await sample(0)).conversationWS[serverRoom];
  assert(serverWS.sent.chat > (serverBefore?.sent.chat ?? 0) && serverWS.sent.history > (serverBefore?.sent.history ?? 0),
    "default server room chat and history keep their WebSocket path");
  const room = await action(1, "createRoom({name:'Browser-owned room',access:'private',hidden:true,password:'browser-room-password'})");
  const invite = await action(1, `createRoomInvite(${JSON.stringify(room)})`);
  await action(2, "close()");
  await evaluate(2, "localStorage.removeItem('piik.channel.prototype.credential')");
  await browser(2, "open", invite);
  await browser(2, "reload");
  await until("fresh user joins the Browser-owned private room", () => view(2), value => value.connection === "connected" &&
    value.state.channel.rooms.some(entry => entry.id === room && entry.authorized));
  await action(1, `browse(${JSON.stringify(room)})`);
  await action(2, `sendMessage(${JSON.stringify(room)}, 'Confirmed on B')`);
  await until("owner receives confirmed room history", () => evaluate(1,
    `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), value => value?.some(message => message.text === "Confirmed on B"));
  await action(2, `loadLatestHistory(${JSON.stringify(room)})`);
  const initialHostedWS = await Promise.all([1, 2].map(async index => (await sample(index)).conversationWS[room] ?? null));
  assert.deepEqual(initialHostedWS, [null, null], "Browser room chat and history never traverse the domain WebSocket");

  await evaluate(1, `(() => {
    const conversation = ${hook}.session.conversation, receive = conversation.receive;
    conversation.receive = async function(...args) {
      try { return await receive.apply(this, args); }
      catch (error) { window.__channelProbe.conversationRejected = String(error); throw error; }
    };
    window.__channelProbe.restoreConversation = () => { conversation.receive = receive; };
    return true;
  })()`);
  const forgedText = "Ordinary-user fake live reply must be rejected";
  let rejectedReply;
  try {
    await evaluate(2, `(async () => {
      const session = ${hook}.session, value = ${hook}.snapshot();
      const entry = value.state.channel.rooms.find(room => room.id === ${JSON.stringify(room)});
      const { runtime, signer } = await session.conversation.identity;
      if (value.sessionId === entry.delivery.hostSessionId) throw new Error('Expected ordinary participant');
      const packet = JSON.parse(signer.sign(value.sessionId, JSON.stringify({
        roomId: entry.id, bindingId: entry.delivery.bindingId, sender: value.sessionId,
        recipient: entry.delivery.hostSessionId, requestId: crypto.randomUUID(),
        record: { type: 'live_message', message: { id: crypto.randomUUID(), seq: 2,
          userId: entry.creatorId, text: ${JSON.stringify(forgedText)}, time: Date.now(), attachments: [] } }
      })));
      await session.conversation.deliver(packet, runtime);
      return true;
    })()`);
    rejectedReply = await until("room owner rejects a participant-signed fake reply", () => evaluate(1,
      "window.__channelProbe.conversationRejected"), value => value?.includes("invalid_conversation_sender"));
    assert.equal(await evaluate(1, `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}].some(message => message.text === ${JSON.stringify(forgedText)})`), false);
    await action(2, `sendMessage(${JSON.stringify(room)}, 'Chat after rejected fake reply')`);
    await until("normal chat continues after rejecting the fake reply", () => evaluate(1,
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), value => value?.some(message => message.text === "Chat after rejected fake reply"));
  } finally { await evaluate(1, "window.__channelProbe.restoreConversation()"); }

  const stored = await evaluate(1, `(async () => {
    const databases = await indexedDB.databases();
    for (const database of databases) {
      if (!database.name?.startsWith('piik.channel.rooms.')) continue;
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(database.name);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const tx = db.transaction(['rooms','messages']);
        const policy = tx.objectStore('rooms').get(${JSON.stringify(room)});
        const messages = tx.objectStore('messages').getAll(IDBKeyRange.bound([${JSON.stringify(room)}], [${JSON.stringify(room)}, Infinity]));
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        if (policy.result) return { policy: JSON.parse(policy.result.policy), messages: messages.result };
      } finally { db.close(); }
    }
    return null;
  })()`);
  assert(stored?.messages.some(message => message.text === "Confirmed on B"));
  assert.equal(stored.policy.creatorId, initial[1].self.id);
  const db = new DatabaseSync(process.env.CHANNEL_DATA_FILE, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM message WHERE room_id=?").get(room).count, 0);
    const checkpoint = db.prepare("SELECT body FROM checkpoint WHERE id=1").get().body;
    assert(!checkpoint.includes(stored.policy.passwordHash), "domain must not retain Browser room password hashes");
    assert(!checkpoint.includes("Confirmed on B"), "domain must not checkpoint Browser room history");
  } finally { db.close(); }

  const serverPicture = await capturedScreen(0, serverRoom);
  await browser(2, "click", '.c3-room-link[aria-label="Living room"]');
  await action(2, `watch(${JSON.stringify(serverPicture)})`);
  await playing(2, serverPicture);
  const viewerSession = (await view(2)).sessionId;
  const sharedPair = (await view(0)).state.pairs.find(pair => pair.peerId === viewerSession).id;
  const roomPicture = await capturedScreen(2, room);
  for (const index of [0, 1]) {
    await browser(index, "click", '.c3-room-link[aria-label="Browser-owned room"]');
    await action(index, `watch(${JSON.stringify(roomPicture)})`);
    await playing(index, roomPicture);
  }
  assert.equal((await view(0)).state.pairs.find(pair => pair.peerId === viewerSession).id, sharedPair);
  await action(1, `joinVoice(${JSON.stringify(room)})`);
  await action(2, `joinVoice(${JSON.stringify(room)})`);
  await until("Browser room voice reaches a remote participant", () => sample(2), value => value.inbound.some(row => row.kind === "audio" && row.samples > 0));
  const ownerSession = (await view(1)).sessionId;
  await dropSignaling(1);
  await action(1, "reconnect()");
  await until("same Browser room owner resumes", () => view(1), value => value.connection === "connected" && value.sessionId === ownerSession &&
    value.state.publications.some(publication => publication.id === roomPicture));
  await progressing(0, roomPicture);

  await action(1, "close()");
  await until("stopped owner pauses its room", () => view(2), value => !value.state.publications.some(publication => publication.roomId === room), 25_000);
  assert((await view(2)).state.channel.rooms.some(entry => entry.id === room && entry.authorized && !entry.available),
    "a paused private room remains visible to an already admitted participant");
  assert((await sample(0)).captures.some(track => track.kind === "video" && track.state === "live"));
  assert.equal((await view(0)).state.pairs.find(pair => pair.peerId === viewerSession).id, sharedPair);
  await progressing(2, serverPicture);
  await browser(1, "open", `${origin}/__channel-preview`);
  await until("reopened owner restores the saved room", () => view(1), value => value.connection === "connected" &&
    value.state.channel.rooms.some(entry => entry.id === room && entry.authorized && entry.available !== false));
  await action(1, `browse(${JSON.stringify(room)})`);
  await until("reopened owner reads its own retained history", () => evaluate(1,
    `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}]`), value => value?.some(message => message.text === "Confirmed on B"));
  assert(!(await view(1)).state.publications.some(publication => publication.roomId === room));
  assert(!(await view(1)).state.voice.some(member => member.roomId === room));
  await progressing(2, serverPicture);
  await browser(2, "click", '.c3-room-link[aria-label="Browser-owned room"]');
  for (let start = 0; start < 100; start += 20) {
    await evaluate(2, `(async () => {
      for (let index = ${start}; index < ${start + 20}; index++) {
        await ${hook}.session.sendMessage(${JSON.stringify(room)}, String.fromCharCode(1).repeat(2000));
      }
      return true;
    })()`);
  }
  await action(2, `loadLatestHistory(${JSON.stringify(room)})`);
  const page = await evaluate(2, `${hook}.snapshot().messagesByRoom[${JSON.stringify(room)}].map(message => message.text.length)`);
  assert.deepEqual(page, Array(100).fill(2000), "a full valid history page arrives as individual signed DataChannel records and one end marker");
  const hostedWS = await Promise.all([0, 1, 2].map(async index => (await sample(index)).conversationWS[room] ?? null));
  assert.deepEqual(hostedWS, [null, null, null], "hosted chat and history stay off WebSocket throughout owner recovery and paging");
  await browser(1, "click", '.c3-room-link[aria-label="Browser-owned room"]');
  for (const index of [0, 1, 2]) await assertNoError(index, "normal Browser room lifecycle");
  await browser(1, "screenshot", join(output, "browser-owned-room.png"), "--full");
  await writeFile(join(output, "room-owner-result.json"), JSON.stringify({ passed: true,
    scenarios: ["private invitation initial admission", "owner IndexedDB history", "no room data in domain SQLite",
      "cross-room shared transport", "room voice", "owner signaling resume", "scoped shutdown", "retained paused directory",
      "owner reopen without capture revival", "maximum valid history page", "participant-signed fake reply rejected", "normal chat after rejected reply"],
    conversationTransport: { serverRoomWS: serverWS, hostedRoomWS: hostedWS, rejectedReply },
    domainMessageCopies: 0, maximumHistoryPage: { messages: 100, charactersPerMessage: 2000, transport: "signed DataChannel records" } }, null, 2));
  console.log("Browser owns policy/history and room activities; domain only retains its directory; unrelated media survives owner shutdown");
}

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
  assert.equal(await evaluate(1, "!!document.querySelector('.c3-composer input[type=file]')"), true,
    "Browser rooms use their real peer endpoint for files");
  const png = join(temporary, "picture.png"), text = join(temporary, "notes.txt");
  await writeFile(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=", "base64"));
  await writeFile(text, "A file shared through the actual composer.");
  await browser(1, "upload", '.c3-composer input[type="file"]', png, text);
  await until("two draft files", () => evaluate(1, "document.querySelectorAll('.c3-draft-files > div').length"), count => count === 2);
  await browser(1, "click", ".c3-composer button[type=submit]");
  await until("attachment metadata arrives in chat", () => evaluate(0, "document.querySelector('.c3-message-log').textContent"), text => text.includes("picture.png") && text.includes("notes.txt"));
  await browser(0, "find", "role", "button", "click", "--name", "View image", "--exact");
  await until("PNG preview decodes", () => evaluate(0, "[...document.querySelectorAll('.c3-attachment img')].some(image => image.complete && image.naturalWidth > 0)"), Boolean);
  for (const index of [0, 1]) await assertNoError(index, "normal room entry, chat and file flow");
  await browser(0, "screenshot", join(output, "peer-room-files-desktop.png"), "--full");
  for (const index of [0, 1]) await browser(index, "click", '.c3-room-link[aria-label="Living room"]');
  assert.equal(await evaluate(1, "!!document.querySelector('.c3-composer input[type=file]')"), false,
    "a Server room without a peer endpoint does not advertise file delivery");
  console.log("Private Browser room owns chat and sends file bytes over its actual peer path");

  await browser(1, "click", '.c3-room-link[aria-label="Movie night"]');
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
      `${hook}.snapshot().messagesByRoom[${JSON.stringify(room.id)}]?.[0]?.seq`), seq => seq === Math.max(1, 922 - (page + 1) * 100));
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
    await browser(index, "open", `${origin}/__channel-preview#${index === 0 ? "owner" : "invite"}=${encodeURIComponent(index === 0 ? ownerKey : inviteKey)}`);
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
  if (nativeOnly) {
    await nativeRoom({ initial, serverRoom: roomId, browser, action, view, evaluate, until, sample,
      capturedScreen, playing, progressing, assertNoError, hook, output });
    console.log(`Native room acceptance passed; evidence: ${output}`);
  } else if (baseOnly) {
    await senderAllocationFailure();
    await roomBase(initial, roomId);
    console.log(`Room base acceptance passed; evidence: ${output}`);
  } else if (hostsOnly) {
    await roomOwner(initial, roomId);
    console.log(`Browser room-owner acceptance passed; evidence: ${output}`);
  } else if (roomsOnly) {
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
  const leaf = [0, 3, 4][initialRoutes.findIndex(value => !value.state.pairs.some(pair => pair.outgoing.some(flow => flow.publicationId === secondPublication)))];
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
  const relay = routed.findIndex((state, index) => index !== 2 && state.state.pairs.some(pair => pair.outgoing.some(flow => flow.publicationId === primaryPublication)));
  assert(relay >= 0, "source fanout two must produce an actual peer relay for four viewers");
  const sourceCopies = routed[2].state.pairs.filter(pair => pair.outgoing.some(flow => flow.publicationId === primaryPublication)).length;
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
  assert(relayView.state.pairs.some(pair => pair.outgoing.some(flow => flow.publicationId === primaryPublication)), "own source retirement must retain another source's forwarding");
  console.log(`Browser ${relay} stopped its own source and keeps receiving/forwarding C`);

  const downstream = relayView.state.pairs.find(pair => pair.outgoing.some(flow => flow.publicationId === primaryPublication)).peerId;
  const downstreamIndex = routed.findIndex(value => value.sessionId === downstream);
  assert(downstreamIndex >= 0);
  const transitPairs = relayView.state.pairs.filter(pair => pair.incoming.some(flow => flow.publicationId === primaryPublication) || pair.outgoing.some(flow => flow.publicationId === primaryPublication)).map(pair => pair.id).sort();
  await action(relay, `unwatch(${JSON.stringify(primaryPublication)})`);
  const transit = await until("relay stops local consumption", () => view(relay), value => !value.state.subscriptions.includes(primaryPublication));
  assert.deepEqual(transit.state.pairs.filter(pair => pair.incoming.some(flow => flow.publicationId === primaryPublication) || pair.outgoing.some(flow => flow.publicationId === primaryPublication)).map(pair => pair.id).sort(), transitPairs);
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
    value.state.pairs.some(pair => pair.incoming.some(flow => flow.publicationId === primaryPublication) && pair.peerId !== routed[relay].sessionId));
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
  const evidence = await Promise.all(active.map(async index => ({
    url: await browser(index, "get", "url").catch(failure => ({ error: String(failure) })),
    errors: await browser(index, "errors").catch(failure => ({ error: String(failure) })),
    console: await browser(index, "console").catch(failure => ({ error: String(failure) })),
    view: await view(index).catch(failure => ({ error: String(failure) })),
    probe: await evaluate(index, "window.__channelProbe?.sample() ?? { text: document.body.innerText.slice(-1800) }")
      .catch(failure => ({ error: String(failure) })),
  })));
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), evidence }, null, 2));
  throw error;
} finally {
  await Promise.allSettled(active.map(index => browser(index, "close")));
  await Promise.allSettled([...active.map(index => `${index}.js`), "picture.png", "notes.txt"].map(name => unlink(join(temporary, name))));
  await rmdir(temporary);
}
