// Normal Host/Viewer acceptance: real signaling, permissions, capture and WebRTC.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { RoomVoiceState } from "../src/shared/protocol";
import { CdpConnection, cleanupRun, evaluate, fetchJsonBefore, launchChrome,
  reservePort, waitForSample, waitForVersion, type PageHandle } from "./browser-gate-harness";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = join(ROOT, "build", "voice-integration");
const runFile = promisify(execFile);
const redact = (value: string) => value.replace(/#v=[A-Za-z0-9_-]+/g, "#v=[redacted]");
type Page = PageHandle & { targetId: string; session: string };
type Sample = { voice: RoomVoiceState | null; peerId: string | null; inviteUrl: string | null; authentications: number;
  energy: number; samples: number; bytes: number; playing: number; mutedPlayback: number; enabled: boolean; liveMicrophones: number; text: string; controls: string[] };

// Observe the normal browser boundary; no alternate session or control protocol.
const probe = (name: string) => `(() => {
  localStorage.setItem('piik:ui-lang','en'); localStorage.setItem('piik:ui-mode','text');
  localStorage.setItem('piik:display-name:v1',${JSON.stringify(name)});
  const peers=[], sockets=[], captures=[], NativePC=RTCPeerConnection, NativeWS=WebSocket;
  const gate=window.__roomVoiceGate={peers,sockets,captures,voice:null,peerId:null,inviteUrl:null,wire:[],authentications:0};
  const record=(direction,m)=>{
    if(!m.type.startsWith('room-voice-')&&!['route-diagnostic-snapshot','peer-state'].includes(m.type))return;
    const summary={...m};
    if(m.description)summary.description={revision:m.description.revision,type:m.description.sdp.type,tracks:m.description.tracks,
      media:m.description.sdp.sdp.split('\\r\\n').filter(line=>/^m=|^a=mid:|^a=(sendrecv|sendonly|recvonly|inactive)/.test(line))};
    if(m.candidate)summary.candidate=m.candidate.candidate.split(' ').slice(0,8).join(' ');
    gate.wire.push({direction,time:Date.now(),...summary});if(gate.wire.length>120)gate.wire.shift();
  };
  window.RTCPeerConnection=class extends NativePC { constructor(...a){super(...a);const index=peers.length;peers.push(this);
    this.addEventListener('iceconnectionstatechange',async()=>{
      const state={type:'peer-state',index,ice:this.iceConnectionState,connection:this.connectionState,
        gathering:this.iceGatheringState,signaling:this.signalingState};
      try{const stats=await this.getStats();state.stats=[...stats.values()].filter(row=>['transport','candidate-pair','local-candidate','remote-candidate'].includes(row.type))
        .map(row=>Object.fromEntries(['id','type','state','iceState','dtlsState','selectedCandidatePairId','localCandidateId','remoteCandidateId','candidateType','address','port','protocol','nominated','requestsSent','responsesReceived','requestsReceived','responsesSent'].filter(key=>key in row).map(key=>[key,row[key]])));}catch{}
      record('browser',state);
    });
  }};
  window.WebSocket=class extends NativeWS { constructor(...a){super(...a);sockets.push(this);
    this.addEventListener('message',event=>{try{const m=JSON.parse(event.data);
      record('receive',m);if(m.type==='room-voice-state')gate.voice=m;
      if(m.type==='authenticated'){gate.peerId=m.peerId;gate.authentications++;gate.voice=null;}
    }catch{}});
  }send(data){try{record('send',JSON.parse(data));}catch{}return super.send(data);}};
  const originalFetch=window.fetch;
  window.fetch=async(...a)=>{const response=await originalFetch(...a);
    if(String(a[0]).endsWith('/api/rooms')&&a[1]?.method==='POST') {
      const created=await response.clone().json();gate.inviteUrl=created.inviteUrl;
    }return response;
  };
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async(...a)=>{const stream=await gum(...a);captures.push(stream);return stream;};
  gate.sample=async()=>{
    const audio=[...document.querySelectorAll('audio')].filter(node=>node.srcObject);
    const ids=new Set(audio.flatMap(node=>node.srcObject.getAudioTracks().map(track=>track.id)));
    let energy=0, samples=0, bytes=0;
    for(const peer of peers)if(peer.connectionState==='connected')for(const row of (await peer.getStats()).values())
      if(row.type==='inbound-rtp'&&row.kind==='audio'&&ids.has(row.trackIdentifier)){
        energy+=row.totalAudioEnergy||0;samples+=row.totalSamplesReceived||0;bytes+=row.bytesReceived||0;
      }
    return {voice:gate.voice,peerId:gate.peerId,inviteUrl:gate.inviteUrl,authentications:gate.authentications,energy,samples,bytes,wire:gate.wire,
      playing:audio.length,mutedPlayback:audio.filter(node=>node.muted).length,enabled:audio.every(node=>node.srcObject.getAudioTracks().every(t=>t.enabled)),
      tracks:audio.flatMap(node=>node.srcObject.getAudioTracks().map(t=>({readyState:t.readyState,muted:t.muted,currentTime:node.currentTime}))),
      connections:peers.map(p=>({state:p.connectionState,signaling:p.signalingState,senders:p.getSenders().map(s=>s.track&&({kind:s.track.kind,readyState:s.track.readyState,enabled:s.track.enabled,muted:s.track.muted}))})),
      liveMicrophones:captures.flatMap(s=>s.getAudioTracks()).filter(t=>t.readyState==='live').length,
      text:document.body.innerText.slice(-1200),controls:[...document.querySelectorAll('button[aria-label]')].map(node=>node.getAttribute('aria-label'))};
  };
})()`;

function audioFixture(): Buffer {
  const rate = 48000, samples = rate * 2, data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const time = i / rate, pulse = .4 + .6 * Math.sin(2 * Math.PI * 3.3 * time) ** 2;
    const pitch = 180 * time + 13 * Math.sin(time * 5);
    data.writeInt16LE(Math.round(2400 * pulse * (Math.sin(2 * Math.PI * pitch) + .4 * Math.sin(4 * Math.PI * pitch))), 44 + i * 2);
  }
  return data;
}

async function udpPort(): Promise<number> {
  const socket = createSocket("udp4");
  return new Promise((accept, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => accept(port)); });
  });
}

async function main(): Promise<void> {
  if (process.env.PIIK_ROOM_VOICE_GATE !== "true") throw new Error("Set PIIK_ROOM_VOICE_GATE=true for this local acceptance gate");
  const executable = process.env.PIIK_SERVER_EXE || join(OUTPUT, `piik-server${process.platform === "win32" ? ".exe" : ""}`);
  const chromePath = process.env.CHROME_PATH;
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const agentBrowser = process.env.AGENT_BROWSER_PATH || (process.platform === "win32"
    ? join(process.env.APPDATA!, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
  const sfuOnly = process.env.PIIK_ROOM_VOICE_SFU === "true";
  const arm = sfuOnly ? "sfu" : "peer";
  const serverPort = Number(process.env.PIIK_ROOM_VOICE_PORT || (sfuOnly ? 19162 : 19161));
  const [vitePort, debugPort, mediaPort] = await Promise.all([reservePort(), reservePort(), udpPort()]);
  const origin = `http://127.0.0.1:${vitePort}`, backend = `http://127.0.0.1:${serverPort}`;
  const profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  await mkdir(OUTPUT, { recursive: true });
  const audio = join(OUTPUT, "microphone.wav");
  await writeFile(audio, audioFixture());
  let server: ChildProcessWithoutNullStreams | null = null, chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null, vite: ViteDevServer | null = null;
  let serverLog = "";
  const pages: Page[] = [];
  const result = { arm, passed: false, stage: "start", checks: [] as string[], error: null as string | null,
    diagnostics: [] as unknown[], cleanup: null as unknown };
  const ui = async (page: Page, ...args: string[]) => {
    if (args[0] === "click") await waitForSample(() => evaluate<boolean>(cdp!, page,
      `!!document.querySelector(${JSON.stringify(args[1])})`, Date.now() + 3000), Boolean, 15_000);
    const response = await runFile(agentBrowser, ["--session", page.session, "--cdp", String(debugPort), ...args],
      { cwd: ROOT, timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return response.stdout;
  };
  const sample = (page: Page) => evaluate<Sample>(cdp!, page, "window.__roomVoiceGate.sample()", Date.now() + 4000);
  const until = async (page: Page, accept: (state: Sample) => boolean, label: string) => {
    result.stage = label;
    let last: Sample | null = null;
    try { await waitForSample(() => sample(page), value => { last = value; return accept(value); }, 25_000, 200); }
    catch { const failed = last as Sample | null; throw new Error(`${label}: ${JSON.stringify(failed && {
      revision: failed.voice?.revision, connections: failed.voice?.connections.length, unavailable: failed.voice?.unavailable.length,
      energy: failed.energy, samples: failed.samples, bytes: failed.bytes, liveMicrophones: failed.liveMicrophones, text: failed.text,
    })}`); }
    return last!;
  };
  const button = (page: Page, name: string) => ui(page, "find", "role", "button", "click", "--name", name, "--exact");
  const memberButton = async (page: Page, name: string, action: string) => {
    let index = -1;
    await waitForSample(() => evaluate<number>(cdp!, page,
      `[...document.querySelectorAll('.lr-voice-member')].findIndex(node=>node.querySelector('b')?.textContent.includes(${JSON.stringify(name)})&&node.querySelector('button[aria-label=${JSON.stringify(action)}]'))`,
      Date.now() + 3000), value => { index = value; return value >= 0; }, 5000);
    const selector = `.lr-voice-member:nth-child(${index + 1}) button[aria-label=${JSON.stringify(action)}]`;
    await ui(page, "scrollintoview", selector);
    return ui(page, "click", selector);
  };
  const openVoice = async (page: Page) => {
    await button(page, "Interact");
    await waitForSample(() => evaluate<boolean>(cdp!, page,
      `!!document.querySelector('[role="tab"][id$="-voice-tab"]')`, Date.now() + 3000), Boolean, 5000);
    await ui(page, "find", "role", "tab", "click", "--name", "Voice", "--exact");
  };
  const check = (label: string) => { result.checks.push(label); process.stdout.write(`${arm}: ${label}\n`); };
  try {
    server = spawn(executable, [], { cwd: ROOT, stdio: "pipe", windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PIIK_ENV: "development",
        LISTEN_HOST: "127.0.0.1", PORT: String(serverPort), PIIK_LOG_DIR: join(OUTPUT, `${arm}-logs`),
        ROOM_DATABASE_PATH: join(profile, "rooms.sqlite"), PIIK_DEBUG: "route",
        PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: origin, SFU_LISTEN_HOST: "127.0.0.1",
        SFU_UDP_PORT: String(mediaPort), SFU_PUBLIC_IP: "127.0.0.1", SFU_ONLY: String(sfuOnly),
        ENDPOINT_MEDIA_COPY_CAPACITY: "1" } });
    server.stdout.resume();
    server.stderr.on("data", (data: Buffer) => { serverLog = (serverLog + data.toString()).slice(-12000); });
    await waitForSample(deadline => fetchJsonBefore(`${backend}/healthz`, deadline), () => true, 15_000);
    vite = await createViteServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: vitePort, watch: null,
      strictPort: true, proxy: { "/api": { target: backend }, "/healthz": { target: backend }, "/signal": { target: backend, ws: true } } } });
    await vite.listen();
    chrome = await launchChrome(chromePath, debugPort, profile, ["--headless=new", "--no-first-run",
      "--window-size=1280,900",
      // Chromium excludes loopback ICE by default; this gate's SFU binds only localhost.
      // https://chromium.googlesource.com/chromium/src/+/HEAD/content/public/common/content_switches.cc
      "--allow-loopback-in-peer-connection",
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-audio-capture=${audio}`]);
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    const page = async (url: string, name: string): Promise<Page> => {
      const { browserContextId } = await cdp!.call<{ browserContextId: string }>("Target.createBrowserContext", {}, undefined, Date.now() + 5000);
      const { targetId } = await cdp!.call<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId }, undefined, Date.now() + 5000);
      const { sessionId } = await cdp!.call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, Date.now() + 5000);
      const current = { targetId, sessionId, session: `piik-voice-${arm}-${process.pid}-${pages.length}` };
      pages.push(current);
      await cdp!.call("Page.enable", {}, sessionId, Date.now() + 5000);
      await cdp!.call("Page.addScriptToEvaluateOnNewDocument", { source: probe(name) }, sessionId, Date.now() + 5000);
      await cdp!.call("Page.navigate", { url }, sessionId, Date.now() + 5000);
      await ui(current, "--pin-tab", "tab", targetId);
      return current;
    };
    const host = await page(origin, "Voice Host");
    await until(host, state => state.text.includes("Create room"), "idle Host");
    if ((await sample(host)).inviteUrl) throw new Error("Page visit allocated a room");
    await ui(host, "screenshot", join(OUTPUT, `${arm}-idle-room.png`), "--full");
    await button(host, "Create room");
    const created = await until(host, state => !!state.inviteUrl && !!state.voice, "create idle room");
    if (created.liveMicrophones) throw new Error("Room creation started a microphone");
    await openVoice(host);
    await button(host, "Join voice");
    await until(host, state => !!state.voice?.members.find(member => member.peerId === state.peerId)?.speak, "Host joins voice");
    const viewer = await page(created.inviteUrl!, "Voice Viewer");
    await until(viewer, state => !!state.voice, "Viewer authenticates before sharing");
    await openVoice(viewer);
    await button(viewer, "Request voice");
    await until(host, state => !!state.voice?.members.some(member => member.peerId !== state.peerId && member.requested), "Viewer request");
    await memberButton(host, "Voice Viewer", "Allow speaking");
    await until(viewer, state => !!state.voice?.members.find(member => member.peerId === state.peerId)?.speak, "Host approval");
    await button(host, "Turn on microphone");
    await button(viewer, "Turn on microphone");
    await until(host, state => state.energy > 0 && state.voice?.publications.length === 2, "Host receives Viewer");
    const initial = await until(viewer, state => state.energy > 0 && state.voice?.publications.length === 2, "Viewer receives Host");
    if (!initial.voice?.connections.some(connection => connection.transport === (sfuOnly ? "sfu" : "peer"))) throw new Error("Wrong transport");
    check("idle room, explicit permission, real bidirectional microphone audio");
    let leaf: Page | null = null;
    if (!sfuOnly) {
      leaf = await page(created.inviteUrl!, "Voice Listener");
      await until(leaf, state => !!state.voice, "third normal Viewer authenticates");
      await openVoice(leaf);
      await button(leaf, "Request voice");
      await memberButton(host, "Voice Listener", "Allow listening");
      const relay = await sample(viewer);
      await until(leaf, state => state.playing === 2 && state.energy > 0 && !!state.voice?.connections.some(connection =>
        connection.parentPeerId === relay.peerId && !connection.pending && connection.receive.length === 2), "two speakers through normal Viewer relay");
      check("two simultaneous publications decoded by a third Viewer through shared relay graph");
    }
    await memberButton(viewer, "Voice Host", "Mute for me");
    const muted = await sample(viewer);
    await until(viewer, state => state.enabled && state.samples > muted.samples, "local mute retains received media");
    if (leaf) {
      const before = await sample(leaf);
      await until(leaf, state => state.playing === 2 && state.samples > before.samples, "relay continues after local playback mute");
    }
    check("local mute retains enabled incoming track and media progress");
    await button(viewer, "Deafen");
    const deafened = await until(viewer, state => !state.liveMicrophones && state.playing > 0 &&
      state.mutedPlayback === state.playing && state.voice?.publications.length === 1, "deafen stops microphone and local playback");
    await until(viewer, state => state.enabled && state.samples > deafened.samples, "deafen retains incoming media");
    if (leaf) {
      const before = await sample(leaf);
      await until(leaf, state => state.playing === 1 && state.samples > before.samples, "deafened relay still forwards Host voice");
    }
    await button(viewer, "Undeafen");
    const listening = await sample(viewer);
    if (listening.liveMicrophones || listening.mutedPlayback !== listening.playing) throw new Error("Undeafen changed microphone or per-person mute");
    await memberButton(viewer, "Voice Host", "Unmute for me");
    await until(viewer, state => state.mutedPlayback === 0, "individual mute remains independent of deafen");
    await button(viewer, "Turn on microphone");
    await until(viewer, state => state.liveMicrophones === 1 && state.voice?.publications.length === 2, "explicit microphone restart after deafen");
    if (leaf) await until(leaf, state => state.playing === 2, "relay listeners regain both speakers");
    check("deafen stops own capture, preserves forwarding and individual mute, and never reopens microphone");
    const beforeVideo = await sample(viewer);
    await button(host, "Hide interaction window");
    await button(host, "Start sharing");
    await ui(host, "find", "role", "tab", "click", "--name", "Camera", "--exact");
    await ui(host, "click", 'button[aria-label^="Share camera:"]');
    await until(host, state => state.text.includes("Stop sharing"), "camera sharing starts alongside voice");
    await until(viewer, state => state.samples > beforeVideo.samples && state.voice?.publications.length === 2, "voice survives video start");
    await button(host, "Stop sharing");
    const stopped = await sample(viewer);
    await until(viewer, state => state.samples > stopped.samples && state.voice?.publications.length === 2, "voice survives video stop");
    await button(host, "Start sharing");
    await ui(host, "find", "role", "tab", "click", "--name", "Camera", "--exact");
    await ui(host, "click", 'button[aria-label^="Share camera:"]');
    await until(host, state => state.text.includes("Stop sharing"), "camera sharing restarts");
    await button(host, "Stop sharing");
    await button(host, "Interact");
    check("camera share start/stop/restart preserves room microphones and voice");
    for (const width of [320, 390, 1280]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 840, deviceScaleFactor: 1, mobile: width < 500 }, host.sessionId, Date.now() + 5000);
      await ui(host, "screenshot", join(OUTPUT, `${arm}-voice-${width}.png`));
    }
    check("mobile and desktop voice screenshots");
    await button(host, "Open in always-on-top window");
    await waitForSample(() => evaluate<boolean>(cdp!, host,
      "!!documentPictureInPicture.window?.document.querySelector('.lr-room-voice')", Date.now() + 3000), Boolean, 5000);
    const detached = await sample(viewer);
    await until(viewer, state => state.samples > detached.samples, "detached panel preserves voice");
    const { targetInfos } = await cdp.call<{ targetInfos: { targetId: string; title: string }[] }>("Target.getTargets", {}, undefined, Date.now() + 5000);
    const popup = targetInfos.find(target => target.title === "Interactions · Piik");
    if (!popup) throw new Error("Detached interaction window target missing");
    await ui(host, "--pin-tab", "tab", popup.targetId);
    await ui(host, "screenshot", join(OUTPUT, `${arm}-voice-detached.png`));
    await ui(host, "--pin-tab", "tab", host.targetId);
    await evaluate(cdp, host, "documentPictureInPicture.window.close()", Date.now() + 5000);
    await until(host, state => state.controls.includes("Turn off microphone"), "panel returns from detached window");
    check("actual detached shared voice window preserves capture and audio");
    await memberButton(host, "Voice Viewer", "Mute participant");
    await until(viewer, state => !state.liveMicrophones && !state.voice?.members.find(member => member.peerId === state.peerId)?.publicationId, "revoke stops exact microphone");
    check("authority revoke stops actual capture");
    await memberButton(host, "Voice Viewer", "Allow speaking");
    await until(viewer, state => !!state.voice?.members.find(member => member.peerId === state.peerId)?.speak, "permission restored");
    if ((await sample(viewer)).liveMicrophones) throw new Error("Permission restored microphone automatically");
    await button(viewer, "Turn on microphone");
    await until(viewer, state => state.liveMicrophones === 1 && state.voice?.publications.length === 2, "explicit microphone restart");
    const beforeDisconnect = await sample(viewer);
    await evaluate(cdp, viewer, "window.__roomVoiceGate.sockets.at(-1).close()", Date.now() + 5000);
    await until(viewer, state => !state.liveMicrophones, "session loss stops capture");
    await until(viewer, state => state.authentications > beforeDisconnect.authentications &&
      !!state.voice?.members.find(member => member.peerId === state.peerId)?.connected, "normal signaling reconnect");
    if ((await sample(viewer)).liveMicrophones) throw new Error("Reconnect restored microphone automatically");
    check("exact signaling disconnect/rejoin retires capture without restoring source");
    result.passed = true;
  } catch (error) {
    result.error = redact(error instanceof Error ? error.message : String(error));
    if (pages[0]) try {
      await evaluate(cdp!, pages[0], `window.__roomVoiceGate.sockets.at(-1).send(JSON.stringify({type:'request-route-diagnostic'}))`, Date.now() + 3000);
      await new Promise(resolveWait => setTimeout(resolveWait, 150));
    } catch { /* disconnected sessions cannot request diagnostics */ }
    for (const [index, page] of pages.entries()) try {
      result.diagnostics.push(await sample(page));
      await ui(page, "screenshot", join(OUTPUT, `${arm}-failure-${index}.png`));
    } catch { /* page may have closed */ }
    process.stderr.write(`${result.error}\n${redact(serverLog)}\n`);
  } finally {
    for (const page of pages) try { await ui(page, "close"); } catch { /* cleanupRun owns remaining Chrome */ }
    if (vite) await vite.close();
    const cleanup = await cleanupRun({ cdp, native: null, chrome, server, profile, ports: [serverPort, vitePort, debugPort] });
    result.cleanup = cleanup;
    if (!Object.values(cleanup).every(Boolean)) {
      result.passed = false;
      result.error ??= "Gate resource cleanup failed";
    }
    await writeFile(join(OUTPUT, `${arm}-server.log`), redact(serverLog));
    await writeFile(join(OUTPUT, `${arm}-report.json`), `${redact(JSON.stringify(result, null, 2))}\n`);
  }
  if (!result.passed) process.exitCode = 1;
}

await main();
