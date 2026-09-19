import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CdpConnection, cleanupRun, createPage, evaluate, fetchJsonBefore, launchChrome, reservePort,
  waitForSample, waitForVersion, type PageHandle,
} from "./browser-gate-harness";
import { readAppEndpoint } from "./app-gate-endpoint";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build/go-check");
// A documentation-only LAN address: it makes the room server publish a LAN
// invitation the gate rewrites to its loopback origins, exactly as the packaged
// App does on a real network.
const LAN_ADDRESS = "192.0.2.1";

const initialAudio = process.env.PIIK_CLIENT_GATE_AUDIO !== "false";
const probe = String.raw`(() => {
  localStorage.setItem('piik:ui-lang', 'en');
  localStorage.setItem('piik:ui-mode', 'text');
  const pcs = [], requests = [], sockets = [], errors = [];
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const codecPreferences = RTCRtpTransceiver.prototype.setCodecPreferences;
  RTCRtpTransceiver.prototype.setCodecPreferences = function(value) {
    try { return codecPreferences.call(this,value); }
    catch (error) { errors.push(String(error)); throw error; }
  };
  const PC = RTCPeerConnection, WS = WebSocket;
  window.RTCPeerConnection = class extends PC { constructor(...args) { super(...args); pcs.push(this); } };
  window.WebSocket = class extends WS {
    constructor(...args) { super(...args); if (String(args[0]).includes('/control')) {
      sockets.push(this);
    } }
    send(raw) { if (this.url.includes('/control')) { const value = JSON.parse(raw); requests.push(value.type); } super.send(raw); }
  };
  let audio = ${initialAudio}, captures = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    captures++;
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const context = canvas.getContext('2d'); let frame = 0;
    const draw = () => { context.fillStyle = '#14242a'; context.fillRect(0,0,1920,1080);
      context.fillStyle = '#68dab3'; context.fillRect((frame++ * 17)%1800,100,120,400);
      context.fillStyle = '#ffffff'; context.font = '80px sans-serif'; context.fillText(String(frame),100,700); };
    draw(); const timer = setInterval(draw, 1000/30);
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0]; const stop = track.stop.bind(track);
    track.stop = () => { clearInterval(timer); stop(); };
    if (audio) {
      const ac = new AudioContext(), osc = ac.createOscillator(), dest = ac.createMediaStreamDestination();
      osc.frequency.value = 440; osc.connect(dest); osc.start(); await ac.resume();
      const sound = dest.stream.getAudioTracks()[0], stopSound = sound.stop.bind(sound);
      let soundStopped=false;
      sound.stop = () => { if (soundStopped) return; soundStopped=true; osc.stop(); void ac.close(); stopSound(); };
      stream.addTrack(sound);
    }
    return stream;
  };
  window.fanoutGate = {
    audio(value) { audio = value; },
    breakIngress() { const pc = pcs.find((p) => p.connectionState === 'connected' && p.getSenders().some((s) => s.track?.kind === 'video'));
      pc?.close(); },
    async sample() {
      let outbound = 0, encoded = 0, received = 0;
      const videoStats=[], feedback=[];
      for (const pc of pcs) { if (pc.connectionState === 'closed') continue;
        const stats = await pc.getStats(); stats.forEach((s) => {
          if (s.type==='remote-inbound-rtp') feedback.push({kind:s.kind,lost:s.packetsLost,fraction:s.fractionLost,rtt:s.roundTripTime,reports:s.reportsReceived});
          if (s.type==='candidate-pair' && s.nominated) feedback.push({rtt:s.currentRoundTripTime,bwe:s.availableOutgoingBitrate,sent:s.bytesSent,received:s.bytesReceived});
          if (s.type === 'outbound-rtp' && s.kind === 'video' && s.framesEncoded > 0) { outbound++; encoded += s.framesEncoded;
            const source=stats.get(s.mediaSourceId);
            videoStats.push({width:s.frameWidth,height:s.frameHeight,fps:s.framesPerSecond,reason:s.qualityLimitationReason,
              sourceFps:source?.framesPerSecond,target:s.targetBitrate,encoder:s.encoderImplementation}); }
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            received += s.framesDecoded || 0;
            feedback.push({inbound:true,fps:s.framesPerSecond,receivedFrames:s.framesReceived,decodedFrames:s.framesDecoded,
              dropped:s.framesDropped,lost:s.packetsLost,received:s.packetsReceived,nack:s.nackCount,pli:s.pliCount,
              decodeTime:s.totalDecodeTime,buffer:s.jitterBufferDelay,bufferEmitted:s.jitterBufferEmittedCount});
          }
        }); }
      const video = document.querySelector('video');
      return { outbound, encoded, received, captures, videoStats, feedback, width: video?.videoWidth || 0,
        requests, errors, peers: pcs.map((p) => ({state:p.connectionState, tracks:p.getSenders().map((s)=>s.track?.kind)})),
        frames: video?.getVideoPlaybackQuality().totalVideoFrames || 0,
        sharing: Boolean(document.querySelector('button[aria-label="Stop sharing"]')),
        captureLive: Boolean(video?.srcObject?.getVideoTracks()[0]?.readyState === 'live'),
        capturesEnabled: video?.srcObject?.getVideoTracks()[0]?.enabled,
        receiveRequests: requests.filter((r) => r === 'receive-offer').length,
        edgeRequests: requests.filter((r) => r === 'prepare-edge').length,
        controlOpen: sockets.some((s) => s.readyState === WS.OPEN),
        codecSelected: [...document.querySelectorAll('button.lr-chip.is-selected')].map((b) => b.textContent),
        audio: video?.srcObject?.getAudioTracks().length || 0,
        buttons: [...document.querySelectorAll('.lr-host-share-slot button')].map((b) => b.getAttribute('aria-label')) };
    }
  };
})()`;

function build(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", windowsHide: true,
    timeout: 120_000, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || command + " failed");
  }
}

// startRoomServer builds and starts the Piik server the Browser pages and
// both Apps share. PIIK_ENV stays development because production
// requires an HTTPS public origin and STUN; the Web assets are
// embedded either way.
async function startRoomServer(
  port: number,
  workingDirectory: string,
): Promise<ChildProcessWithoutNullStreams> {
  const go = process.env.PIIK_GO?.trim() || "go";
  await mkdir(BUILD_ROOT, { recursive: true });
  // The server embeds the Vite output, so the Web build precedes the Go build.
  build(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build:web"]);
  const binary = join(BUILD_ROOT, "piik-server.exe");
  build(go, ["build", "-trimpath", "-o", binary, "./cmd/piik-server"]);
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://${LAN_ADDRESS}:${port}`];
  const child = spawn(binary, [], {
    // The gate profile has no .env, and the environment is explicit: the
    // configuration this measurement runs against is these five values, never
    // the repository's development file or the operator's shell.
    cwd: workingDirectory, stdio: "pipe", windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PIIK_ENV: "development",
      ROOM_DATABASE_PATH: ":memory:",
      PORT: String(port),
      LISTEN_HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://${LAN_ADDRESS}:${port}`,
      ALLOWED_ORIGINS: origins.join(","),
    },
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    await once(child, "spawn");
    await waitForSample(
      (deadline) => fetchJsonBefore<{ status: string }>(`http://127.0.0.1:${port}/healthz`, deadline),
      (value) => value.status === "ok",
      20000,
    );
    return child;
  } catch (error) {
    await cleanupRun({ server: child, chrome: null, native: null, cdp: null, profile: null, ports: [port] });
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.env.PIIK_CLIENT_BROWSER_FANOUT_GATE !== "true") throw new Error("Browser fanout gate was not enabled");
  const chromePath = process.env.CHROME_PATH;
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  const appPort = await reservePort(), debugPort = await reservePort();
  const origin = `http://localhost:${appPort}`;
  let app: ChildProcessWithoutNullStreams | null = null;
  let relayApp: ChildProcessWithoutNullStreams | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let server: ChildProcessWithoutNullStreams | null = null;
  let nativePort = 0;
  let relayPort = 0;
  const pages: PageHandle[] = [];
  const checks: Record<string, unknown> = {};
  let stage = "startup", error: string | null = null;
  try {
    server = await startRoomServer(appPort, profile);
    app = spawn(process.env.PIIK_CLIENT_EXE || join(BUILD_ROOT, "piik-app.exe"), [
      "--site", origin, "--config", join(profile, "client.json"),
      "--capture-process", join(BUILD_ROOT, "piik-capture.exe"),
    ], { windowsHide: true, stdio: "pipe", env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: "true" } });
    await once(app, "spawn");
    app.stderr.resume();
    nativePort = (await readAppEndpoint(app)).port;
    app.stdout.resume();
    chrome = await launchChrome(chromePath, debugPort, profile, [
      "--headless=new",
      "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ]);
    chrome.stdout.resume(); chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    checks.browser = version.Browser;
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10000);
    await cdp.call("Browser.setPermission", { origin, permission: {name:"loopback-network"}, setting:"granted" }, undefined, Date.now()+5000);
    const host = await createPage(cdp, `${origin}/#piik-client=1`, probe);
    pages.push(host);
    const read = async (page: PageHandle) => {
      const sample = await evaluate<any>(cdp!, page, "fanoutGate.sample()", Date.now()+5000);
      if (page === host) checks.lastHost = sample;
      return sample;
    };
    const click = async (page: PageHandle, selector: string) => {
      await waitForSample((deadline) => evaluate<boolean>(cdp!, page,
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`, deadline), Boolean, 10000);
      await evaluate(cdp!, page, `document.querySelector(${JSON.stringify(selector)}).click()`, Date.now()+5000);
    };
    stage = "share";
    await click(host, 'button[aria-controls="host-advanced-door"]');
    stage = "share-codec";
    await click(host, 'button[aria-label^="H264"]');
    stage = "share-picker";
    await click(host, 'button.lr-tv-big.is-action');
    stage = "share-browser-capture";
    await click(host, 'button[data-source-tab="browser"]');
    await click(host, '.lr-source-option.is-browser');
    stage = "share-ingress";
    await waitForSample(() => read(host), (s) => s.sharing && s.receiveRequests === 1 && s.outbound === 1, 30000);
    let invite = await evaluate<string>(cdp, host, "document.querySelector('.lr-invite-url').value", Date.now()+5000);
    const url = new URL(invite); url.host = `localhost:${appPort}`; invite = url.toString();
    const relayOrigin = `http://127.0.0.1:${appPort}`;
    relayApp = spawn(process.env.PIIK_CLIENT_EXE || join(BUILD_ROOT,"piik-app.exe"), [
      "--site", relayOrigin, "--config", join(profile,"relay-client.json"),
      "--capture-process", join(BUILD_ROOT,"piik-capture.exe"),
    ], { windowsHide:true, stdio:"pipe", env:{...process.env,PIIK_CLIENT_GATE_NO_BROWSER:"true"} });
    await once(relayApp, "spawn");
    relayApp.stderr.resume();
    relayPort = (await readAppEndpoint(relayApp)).port;
    relayApp.stdout.resume();
    const viewers: PageHandle[] = [];
    for (let index=0; index<2; index++) {
      stage = `viewer-${index+1}`;
      const context = await cdp.call<{browserContextId: string}>("Target.createBrowserContext", {}, undefined, Date.now()+5000);
      await cdp.call("Browser.setPermission", { origin:index===0?relayOrigin:origin, permission: {name:"loopback-network"}, setting:"granted", browserContextId: context.browserContextId }, undefined, Date.now()+5000);
      const viewerURL = index===0 ? invite.replace(origin,relayOrigin)+"&piik-client=1" : invite;
      const viewer = await createPage(cdp, viewerURL, probe, true, context.browserContextId);
      viewers.push(viewer);
      pages.push(viewer);
      await waitForSample(() => read(viewer), (s) => s.width > 0 && s.frames >= 30, 30000);
    }
    stage = "shared-encode";
    await waitForSample(() => read(viewers[0]!), (s) => s.width===1920 && s.outbound===0, 30000);
    await waitForSample(() => read(viewers[1]!), (s) => s.width===1920 && s.outbound===0, 30000);
    checks.host = await read(host);
    checks.viewers = await Promise.all(viewers.map(read));
    if ((checks.host as any).outbound !== 1 || !(checks.viewers as any[]).every((v) => v.outbound === 0)) {
      throw new Error("Shared encode count did not match the Native fanout");
    }
    const beforeSteady = await Promise.all(viewers.map(read));
    const steadyStart = Date.now();
    await waitForSample(async () => Date.now()-steadyStart, (elapsed) => elapsed>=5000, 6000);
    const afterSteady = await Promise.all(viewers.map(read));
    checks.viewerFps = afterSteady.map((sample,index) => (sample.received-beforeSteady[index].received)*1000/(Date.now()-steadyStart));
    if (!(checks.viewerFps as number[]).every((fps) => fps>=27)) throw new Error("Viewer delivery did not sustain the 30 fps source");
    stage = "quality";
    await click(host, 'button[aria-label="720p"]');
    await waitForSample(() => read(viewers[0]!), (s) => s.width === 1280, 20000);
    checks.liveQuality = true;
    stage = "pause-resume";
    await click(host, 'button[aria-label="Pause sharing"]');
    await waitForSample(() => read(host), (s) => s.capturesEnabled === false, 5000);
    await click(host, 'button[aria-label="Resume sharing"]');
    const before = await read(viewers[0]!);
    await waitForSample(() => read(viewers[0]!), (s) => s.frames >= before.frames+20, 10000);
    checks.pauseResume = true;
    stage = "source-audio-change";
    await evaluate(cdp, host, `fanoutGate.audio(${!initialAudio})`, Date.now()+5000);
    await click(host, 'button[aria-label="Switch source"]');
    await waitForSample(() => read(host), (s) => s.receiveRequests === 2 && s.captures === 2 && s.sharing, 15000);
    const beforeSource = await read(viewers[1]!);
    await waitForSample(() => read(viewers[1]!), (s) => s.width > 0 && s.frames >= beforeSource.frames+20 && s.audio===Number(!initialAudio), 25000);
    checks.sourceAudioChange = true;
    stage = "app-exit";
    app.stdin.write("\n");
    await waitForSample(() => read(host), (s) => !s.controlOpen && s.sharing && s.captureLive && s.outbound === 2, 25000);
    for (const viewer of viewers) {
      const prior = await read(viewer);
      await waitForSample(() => read(viewer), (s) => s.width > 0 && s.frames >= prior.frames+15, 30000);
    }
    checks.appExitRecovery = true;
    checks.finalHost = await read(host);
    if ((checks.finalHost as any).errors.length > 0) throw new Error("Browser reported an unhandled media error");
    await mkdir(BUILD_ROOT, {recursive:true});
    const screenshot = await cdp.call<{data:string}>("Page.captureScreenshot", {format:"png"}, host.sessionId, Date.now()+5000);
    await writeFile(join(BUILD_ROOT,"browser-fanout.png"), Buffer.from(screenshot.data,"base64"));
    await click(host, 'button[aria-label="Stop sharing"]');
    stage = "done";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (cdp) checks.atFailure = await Promise.all(pages.map((page) =>
      evaluate(cdp!,page,"fanoutGate.sample()",Date.now()+5000).catch(()=>null)));
  } finally {
    const relayCleanup = await cleanupRun({cdp:null,native:relayApp,chrome:null,server:null,profile:null,ports:relayPort?[relayPort]:[]});
    const cleanup = await cleanupRun({cdp, native:app, chrome, server, profile, ports:[appPort,debugPort,...(nativePort?[nativePort]:[])]});
    const result = {passed: error===null && Object.values(cleanup).every(Boolean) && relayCleanup.nativeExited && relayCleanup.portsClosed, stage, checks, error, cleanup};
    await mkdir(BUILD_ROOT,{recursive:true});
    await writeFile(join(BUILD_ROOT,"browser-fanout.json"), JSON.stringify(result,null,2));
    process.stdout.write(JSON.stringify(result)+"\n");
    if (!result.passed) process.exitCode=1;
  }
}

await main();
