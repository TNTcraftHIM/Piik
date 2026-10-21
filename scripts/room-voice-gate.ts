// Normal Host/Viewer acceptance: room activation, capture and real WebRTC.
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
  energy: number; samples: number; bytes: number; playing: number; mutedPlayback: number; enabled: boolean; liveMicrophones: number; videoFrames: number; text: string; controls: string[] };

// Observe the normal browser boundary; no alternate session or control protocol.
const probe = (name: string) => `(() => {
  localStorage.setItem('piik:ui-lang','en'); localStorage.setItem('piik:ui-mode','text');
  localStorage.setItem('piik:display-name:v1',${JSON.stringify(name)});
  const peers=[], sockets=[], captures=[], NativePC=RTCPeerConnection, NativeWS=WebSocket;
  const gate=window.__roomVoiceGate={peers,sockets,captures,voice:null,peerId:null,inviteUrl:null,wire:[],authentications:0};
  const record=(direction,m)=>{
    if(!m.type.startsWith('room-voice-')&&!['room-interaction','route-diagnostic-snapshot','peer-state'].includes(m.type))return;
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
      videoFrames:[...document.querySelectorAll('video')].reduce((sum,node)=>sum+(node.getVideoPlaybackQuality?.().totalVideoFrames||0),0),
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
  const legacyRoot = process.env.PIIK_ROOM_VOICE_LEGACY_WEB;
  const legacyPort = legacyRoot ? await reservePort() : null;
  const legacyOrigin = legacyPort ? `http://127.0.0.1:${legacyPort}` : null;
  const legacyRevision = legacyRoot ? (await runFile("git", ["-C", legacyRoot, "rev-parse", "HEAD"], { windowsHide: true })).stdout.trim() : null;
  const profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  await mkdir(OUTPUT, { recursive: true });
  const audio = join(OUTPUT, "microphone.wav");
  await writeFile(audio, audioFixture());
  let server: ChildProcessWithoutNullStreams | null = null, chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null, vite: ViteDevServer | null = null, legacyVite: ViteDevServer | null = null;
  let serverLog = "";
  const pages: Page[] = [];
  const result = { arm, legacyRevision, passed: false, stage: "start", checks: [] as string[], error: null as string | null,
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
        PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: [origin, legacyOrigin].filter(Boolean).join(","), SFU_LISTEN_HOST: "127.0.0.1",
        SFU_UDP_PORT: String(mediaPort), SFU_PUBLIC_IP: "127.0.0.1", SFU_ONLY: String(sfuOnly),
        ENDPOINT_MEDIA_COPY_CAPACITY: "1" } });
    server.stdout.resume();
    server.stderr.on("data", (data: Buffer) => { serverLog = (serverLog + data.toString()).slice(-12000); });
    await waitForSample(deadline => fetchJsonBefore(`${backend}/healthz`, deadline), () => true, 15_000);
    vite = await createViteServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: vitePort, watch: null,
      strictPort: true, proxy: { "/api": { target: backend }, "/healthz": { target: backend }, "/signal": { target: backend, ws: true } } } });
    await vite.listen();
    if (legacyRoot && legacyPort) {
      legacyVite = await createViteServer({ root: legacyRoot, logLevel: "error", optimizeDeps: { entries: ["index.html"] }, server: { host: "127.0.0.1", port: legacyPort,
        watch: null, strictPort: true, proxy: { "/api": { target: backend }, "/healthz": { target: backend }, "/signal": { target: backend, ws: true } } } });
      await legacyVite.listen();
    }
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
    const viewer = await page(created.inviteUrl!, "Voice Viewer");
    await until(viewer, state => !!state.voice, "Viewer authenticates before sharing");
    await openVoice(viewer);
    if (await evaluate<boolean>(cdp, viewer,
      `!document.querySelector('button[aria-label="Join voice"]')?.matches(':disabled,[aria-disabled="true"]')`, Date.now() + 3000)) throw new Error("Viewer can join before Host opens room voice");
    await button(host, "Open room voice");
    await until(viewer, state => !!state.voice?.enabled, "Host opens room voice");
    await button(viewer, "Join voice");
    await until(viewer, state => !!state.voice?.members.find(member => member.peerId === state.peerId)?.joined, "Viewer joins without approval");
    if ((await sample(host)).liveMicrophones || (await sample(viewer)).liveMicrophones) throw new Error("Joining started a microphone");
    await button(host, "Turn on microphone");
    await button(viewer, "Turn on microphone");
    await until(host, state => state.energy > 0 && state.voice?.publications.length === 2, "Host receives Viewer");
    const initial = await until(viewer, state => state.energy > 0 && state.voice?.publications.length === 2, "Viewer receives Host");
    if (!initial.voice?.connections.some(connection => connection.transport === (sfuOnly ? "sfu" : "peer"))) throw new Error("Wrong transport");
    check("Host opens voice, Viewer joins freely, explicit microphones carry bidirectional audio");
    let leaf: Page | null = null;
    if (!sfuOnly) {
      leaf = await page(created.inviteUrl!, "Voice Listener");
      await until(leaf, state => !!state.voice, "third normal Viewer authenticates");
      await openVoice(leaf);
      await button(leaf, "Join voice");
      const relay = await sample(viewer);
      await until(leaf, state => state.playing === 2 && state.energy > 0 && !!state.voice?.connections.some(connection =>
        connection.parentPeerId === relay.peerId && !connection.pending && connection.receive.length === 2), "two speakers through normal Viewer relay");
      check("two simultaneous publications decoded by a third Viewer through shared relay graph");
    }
    let legacyViewer: Page | null = null;
    if (legacyOrigin) {
      const invitation = new URL(created.inviteUrl!);
      legacyViewer = await page(`${legacyOrigin}${invitation.pathname}${invitation.hash}`, "Older Viewer");
      await until(legacyViewer, state => state.authentications === 1 && state.controls.includes("Interact"), "older Viewer joins before picture sharing");
    }
    result.stage = "voice-only topology";
    for (const [index, participant] of [host, viewer].entries()) {
      await button(participant, "Hide interaction window");
      await button(participant, "Show connection topology");
      await waitForSample(() => evaluate<boolean>(cdp!, participant, `(() => {
        const state=window.__roomVoiceGate.voice, tree=document.getElementById('room-topology');
        const expected=state?.members.filter(member=>member.peerId!==state.hostPeerId&&member.connected&&member.joined&&member.upstream.kind!=='none').length;
        return expected>0&&tree?.querySelectorAll('.lr-route-edge:not(.is-pending)').length>=expected;
      })()`, Date.now() + 3000), Boolean, 5000);
      await ui(participant, "screenshot", join(OUTPUT, `${arm}-voice-topology-${index}.png`), "--full");
      await button(participant, "Hide connection topology");
      await openVoice(participant);
    }
    check("Host and Viewer topology display connected voice routes before picture sharing");
    await button(host, "Interact with Voice Viewer");
    await button(host, "Toss poop");
    await waitForSample(() => evaluate<boolean>(cdp!, viewer,
      `window.__roomVoiceGate.wire.some(message=>message.direction==='receive'&&message.type==='room-interaction'&&message.payload.kind==='reaction'&&message.payload.reaction==='poop'&&message.payload.targetPeerId===window.__roomVoiceGate.peerId)`,
      Date.now() + 3000), Boolean, 5000);
    await ui(viewer, "screenshot", join(OUTPUT, `${arm}-voice-reaction.png`));
    check("voice participant picker sends a correctly targeted reaction to the other normal page");
    await button(host, "Back to voice");
    await button(host, "Microphone settings");
    await button(host, "Back to voice");
    const beforeMute = await sample(host);
    const oldPublication = beforeMute.voice!.publications.find(publication => publication.peerId === beforeMute.peerId)!.id;
    const voiceConnections = beforeMute.voice!.connections.filter(connection => !connection.pending).map(connection => connection.connectionId).sort();
    await button(host, "Turn off microphone");
    await until(host, state => state.liveMicrophones === 0 && state.voice?.publications.length === 1 &&
      !!state.voice.members.find(member => member.peerId === state.peerId)?.joined, "microphone off retains voice membership");
    await until(viewer, state => state.playing === 0 && state.voice?.publications.length === 1, "retired microphone removed from playback");
    await button(host, "Turn on microphone");
    await until(host, state => state.liveMicrophones === 1 && state.voice?.publications.length === 2, "microphone restarts within joined channel");
    const restarted = await until(viewer, state => state.playing === 1 && state.energy > 0 && state.voice?.publications.length === 2,
      "replacement microphone produces decoded audio");
    await until(viewer, state => state.samples > restarted.samples, "replacement microphone continues producing samples");
    const afterMute = await sample(host);
    if (afterMute.voice!.publications.find(publication => publication.peerId === afterMute.peerId)!.id === oldPublication ||
      JSON.stringify(afterMute.voice!.connections.filter(connection => !connection.pending).map(connection => connection.connectionId).sort()) !== JSON.stringify(voiceConnections)) {
      throw new Error("Microphone restart reused retired publication or replaced the room route");
    }
    if (leaf) await until(leaf, state => state.playing === 2 && state.voice?.publications.length === 2, "relay receives replacement microphone exactly once");
    check("microphone restart replaces its publication without leaving voice, duplicating playback or replacing the route");
    await memberButton(viewer, "Voice Host", "Mute for me");
    const muted = await sample(viewer);
    await until(viewer, state => state.enabled && state.samples > muted.samples, "local mute retains received media");
    if (leaf) {
      const before = await sample(leaf);
      await until(leaf, state => state.playing === 2 && state.samples > before.samples, "relay continues after local playback mute");
    }
    check("local mute retains enabled incoming track and media progress");
    await button(viewer, "Pause listening");
    const deafened = await until(viewer, state => state.liveMicrophones === 1 && state.playing > 0 &&
      state.mutedPlayback === state.playing && state.voice?.publications.length === 2, "pause listening preserves microphone");
    await until(viewer, state => state.enabled && state.samples > deafened.samples, "deafen retains incoming media");
    if (leaf) {
      const before = await sample(leaf);
      await until(leaf, state => state.playing === 2 && state.samples > before.samples, "relay still forwards both speakers while not listening");
    }
    await button(viewer, "Resume listening");
    const listening = await sample(viewer);
    if (listening.liveMicrophones !== 1 || listening.mutedPlayback !== listening.playing) throw new Error("Resuming listening changed microphone or per-person mute");
    await memberButton(viewer, "Voice Host", "Unmute for me");
    await until(viewer, state => state.mutedPlayback === 0, "individual mute remains independent of deafen");
    if (leaf) await until(leaf, state => state.playing === 2, "relay listeners regain both speakers");
    check("local listening, microphone and per-person mute remain independent and preserve forwarding");
    await button(host, "Microphone settings");
    await ui(host, "focus", 'input[aria-label="Microphone volume"]');
    await ui(host, "press", "End");
    await button(host, "Back to voice");
    check("one room microphone setting surface supplies device, gain and speech processing");
    const beforeVideo = await sample(viewer);
    await button(host, "Hide interaction window");
    await button(host, "Start sharing");
    await ui(host, "find", "role", "tab", "click", "--name", "Camera", "--exact");
    await ui(host, "click", 'button[aria-label^="Share camera:"]');
    await until(host, state => state.text.includes("Stop sharing"), "camera sharing starts alongside voice");
    await until(viewer, state => state.samples > beforeVideo.samples && state.voice?.publications.length === 2, "voice survives video start");
    if (legacyViewer) await until(legacyViewer, state => state.videoFrames > 0 && state.voice === null && state.authentications === 1,
      "older Viewer receives picture without unsupported voice events");
    await button(host, "Stop sharing");
    const stopped = await sample(viewer);
    await until(viewer, state => state.samples > stopped.samples && state.voice?.publications.length === 2, "voice survives video stop");
    await button(host, "Start sharing");
    await ui(host, "find", "role", "tab", "click", "--name", "Camera", "--exact");
    await ui(host, "click", 'button[aria-label^="Share camera:"]');
    await until(host, state => state.text.includes("Stop sharing"), "camera sharing restarts");
    await until(viewer, state => state.videoFrames > 0, "Viewer decodes picture alongside room voice");
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
    await button(host, "Close room voice");
    for (const participant of [host, viewer, ...(leaf ? [leaf] : [])]) {
      await until(participant, state => !state.voice?.enabled && !state.liveMicrophones && !state.playing && !state.voice?.connections.length,
        "Host closes room voice and retires every participant's capture and playback");
    }
    const closedVoice = await sample(viewer);
    await until(viewer, state => state.videoFrames > closedVoice.videoFrames, "picture continues after channel close");
    if (legacyViewer) {
      const legacyBefore = await sample(legacyViewer);
      await until(legacyViewer, state => state.videoFrames > legacyBefore.videoFrames && state.voice === null && state.authentications === 1,
        "older Viewer retains picture after voice closes");
      check("older Web keeps picture sharing across voice activation and retirement without unsupported messages");
    }
    await button(host, "Open room voice");
    await until(viewer, state => !!state.voice?.enabled, "Host reopens room voice");
    if ((await sample(viewer)).liveMicrophones || (await sample(viewer)).voice?.members.find(member => member.peerId === (beforeVideo.peerId))?.joined) {
      throw new Error("Reopening restored Viewer membership or microphone automatically");
    }
    await button(viewer, "Join voice");
    await until(viewer, state => !!state.voice?.members.find(member => member.peerId === state.peerId)?.joined, "Viewer explicitly rejoins");
    await button(host, "Turn on microphone");
    await button(viewer, "Turn on microphone");
    await until(viewer, state => state.liveMicrophones === 1 && state.voice?.publications.length === 2, "explicit microphone restart");
    const restartedVoice = await sample(viewer);
    await until(viewer, state => state.samples > restartedVoice.samples && state.videoFrames > restartedVoice.videoFrames, "voice activates on an existing picture route");
    check("closing voice preserves picture; reopening adds voice to the existing picture route");
    for (const participant of [viewer, host]) {
      await evaluate(cdp, participant, `(() => {
        const connection=window.__roomVoiceGate.peers.find(peer=>peer.connectionState==='connected'&&peer.getTransceivers().length&&
          peer.getTransceivers().every(transceiver=>transceiver.receiver.track.kind==='audio'));
        if(!connection)throw new Error('No independent voice transport');
        connection.close();connection.dispatchEvent(new Event('connectionstatechange'));
      })()`, Date.now() + 5000);
      const failedVoice = await sample(viewer);
      await until(viewer, state => state.videoFrames > failedVoice.videoFrames, "voice transport failure leaves picture progressing");
      await until(viewer, state => state.energy > 0 && state.playing > 0 && !!state.voice?.connections.some(connection => !connection.pending), "voice transport recovers through room route owner");
    }
    check("independent voice transport failure retains healthy picture and uses ordinary room recovery");
    const beforeDisconnect = await sample(viewer);
    await evaluate(cdp, viewer, "window.__roomVoiceGate.sockets.at(-1).close()", Date.now() + 5000);
    await until(viewer, state => !state.liveMicrophones, "session loss stops capture");
    await until(viewer, state => state.authentications > beforeDisconnect.authentications &&
      !!state.voice?.members.find(member => member.peerId === state.peerId)?.connected, "normal signaling reconnect");
    if ((await sample(viewer)).liveMicrophones) throw new Error("Reconnect restored microphone automatically");
    check("closing room voice retires all audio; reopening and reconnect never restart microphones");
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
    if (legacyVite) await legacyVite.close();
    if (vite) await vite.close();
    const cleanup = await cleanupRun({ cdp, native: null, chrome, server, profile, ports: [serverPort, vitePort, debugPort, ...(legacyPort ? [legacyPort] : [])] });
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
