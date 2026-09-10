import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { CreateRoomResponse } from "../src/shared/protocol";
import {
  CdpConnection, cleanupRun, createPage, evaluate, fetchJsonBefore, launchChrome,
  reservePort, waitForSample, waitForVersion, withDeadline, type PageHandle,
} from "./browser-gate-harness";
import type { snapshot } from "./embedded-sfu-page";
import { readClientEndpoint } from "./client-gate-endpoint";
import { SOURCE_TITLE, sourceServer, startSourceBrowser, waitForCaptureWindow } from "./client-native-host-gate";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "embedded-media");
type Snapshot = ReturnType<typeof snapshot>;

const AUDIO_PROBE = `(() => {
  const peers = [], BrowserPeer = RTCPeerConnection;
  window.RTCPeerConnection = class extends BrowserPeer {
    constructor(...args) { super(...args); peers.push(this); }
  };
  window.__piikGateAudioEnergy = async () => {
    const trackId = document.querySelector('video')?.srcObject?.getAudioTracks()[0]?.id;
    const diagnostic = window.__piikGateAudioStats = { hasAudioTrack: !!trackId, peerCount: peers.length, inbound: [] };
    if (!trackId) return 0;
    for (const peer of peers) {
      if (peer.connectionState !== 'connected') continue;
      const report = await peer.getStats();
      for (const row of report.values()) {
        if (row.type === 'inbound-rtp' && row.kind === 'audio') diagnostic.inbound.push({
          trackMatches: row.trackIdentifier === trackId, energy: row.totalAudioEnergy ?? null,
          sampleDuration: row.totalSamplesDuration ?? null, receivedSamples: row.totalSamplesReceived ?? null,
        });
        if (row.type === 'inbound-rtp' && row.kind === 'audio' && row.trackIdentifier === trackId &&
            Number.isFinite(row.totalAudioEnergy) && row.totalAudioEnergy > 0) return row.totalAudioEnergy;
      }
    }
    return 0;
  };
})()`;

async function udpPort(requested = 0): Promise<number> {
  const socket = createSocket("udp4");
  return await new Promise((resolvePort, reject) => {
    socket.once("error", reject);
    socket.bind(requested, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolvePort(port));
    });
  });
}

async function main(): Promise<void> {
  if (process.env.PIIK_EMBEDDED_SFU_GATE !== "true") {
    throw new Error("PIIK_EMBEDDED_SFU_GATE=true is required; this is an explicit local Browser media gate");
  }
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const nativeArm = process.env.PIIK_EMBEDDED_SFU_NATIVE === "true";
  const twoRooms = process.env.PIIK_EMBEDDED_SFU_TWO_ROOMS === "true";
  if (twoRooms && !nativeArm) throw new Error("Two-room arm requires Native publication");
  const codec = process.env.PIIK_EMBEDDED_SFU_CODEC?.trim() || "vp8";
  if (codec !== "vp8" && codec !== "h264") throw new Error("SFU gate codec must be vp8 or h264");
  const captureBinary = process.env.PIIK_CAPTURE_PROCESS?.trim();
  if (nativeArm && (process.platform !== "win32" || !captureBinary)) {
    throw new Error("Native arm requires Windows and PIIK_CAPTURE_PROCESS");
  }
  await mkdir(BUILD_ROOT, { recursive: true });
  const binary = join(BUILD_ROOT, `piik-server${process.platform === "win32" ? ".exe" : ""}`);
  const clientBinary = join(BUILD_ROOT, "piik-app.exe");
  for (const command of nativeArm ? ["piik-server", "piik-app"] : ["piik-server"]) {
    const build = spawnSync(process.env.PIIK_GO?.trim() || "go", [
      "build", "-p", "1", "-trimpath", "-o", command === "piik-server" ? binary : clientBinary, `./cmd/${command}`,
    ], { cwd: ROOT, env: { ...process.env, GOMAXPROCS: "2" }, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    if (build.error || build.status !== 0) throw build.error ?? new Error(build.stderr || `${command} build failed`);
  }
  const [serverPort, vitePort, debugPort, mediaPort] = await Promise.all([
    reservePort(), reservePort(), reservePort(), udpPort(),
  ]);
  const origin = `http://127.0.0.1:${vitePort}`;
  const backend = `http://127.0.0.1:${serverPort}`;
  const profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  const sourceProfile = nativeArm ? await mkdtemp(join(tmpdir(), "piik-client-media-")) : null;
  const [sourcePort, sourceDebugPort] = nativeArm ? [await reservePort(), await reservePort()] : [0, 0];
  const result = { passed: false, arm: `${nativeArm ? "native" : "browser"}-${codec}-simulcast${twoRooms ? "-two-rooms" : ""}`, stage: "start",
    startedAt: new Date().toISOString(), finishedAt: "", processes: [] as Array<{ role: string; pid: number | null }>,
    high: null as { frames: number; width: number; height: number } | null,
    low: null as { frames: number; width: number; height: number } | null,
    audioEnergy: { high: 0, low: 0 },
    audioDiagnostics: null as unknown,
    secondRoom: twoRooms ? { connected: false, framesAfterFirstStopped: 0, audioBefore: 0, audioAfter: 0, stopped: false } : null,
    host: null as Snapshot | null, viewer: null as Snapshot | null,
    publicationRetired: false, nativeShareStopped: !nativeArm, udpReleased: false, cleanup: false, error: null as string | null };
  let server: ChildProcessWithoutNullStreams | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let vite: ViteDevServer | null = null;
  let cdp: CdpConnection | null = null;
  let host: PageHandle | null = null;
  let viewer: PageHandle | null = null;
  let secondHost: PageHandle | null = null;
  let secondViewer: PageHandle | null = null;
  let serverError = "";
  let client: ChildProcessWithoutNullStreams | null = null;
  let clientPort = 0;
  let sourceChrome: ChildProcessWithoutNullStreams | null = null;
  let sourceCdp: CdpConnection | null = null;
  let sourceHTTP: Awaited<ReturnType<typeof sourceServer>> | null = null;
  const call = async <T>(page: PageHandle, expression: string, timeout = 25_000): Promise<T> => {
    const value = await evaluate<{ value?: T; error?: string }>(cdp!, page,
      `import('/scripts/embedded-sfu-page.ts').then(async (gate) => { try { return { value: await (${expression}) }; } catch (error) { return { error: String(error?.message || error) }; } })`,
      Date.now() + timeout);
    if (value.error) throw new Error(value.error);
    return value.value as T;
  };
  const until = async (page: PageHandle, accept: (value: Snapshot) => boolean) => {
    let last: Snapshot | null = null;
    try {
      await waitForSample(() => call<Snapshot>(page, "gate.snapshot()", 3_000),
        (value) => { last = value; return !!value.error || accept(value); }, 25_000);
    } catch { throw new Error(`Browser stage timed out: ${JSON.stringify(last)}`); }
    if (last!.error) throw new Error(last!.error);
    return last!;
  };
  const processStarted = (role: string, child: ChildProcessWithoutNullStreams) => {
    const entry = { role, pid: child.pid ?? null };
    result.processes.push(entry);
    process.stderr.write(`${JSON.stringify({ ...entry, startedAt: new Date().toISOString() })}\n`);
  };
  try {
    server = spawn(binary, [], { cwd: ROOT, stdio: "pipe", windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        PIIK_ENV: "development", LISTEN_HOST: "127.0.0.1", PORT: String(serverPort),
        PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: origin,
        SFU_LISTEN_HOST: "127.0.0.1", SFU_UDP_PORT: String(mediaPort), SFU_PUBLIC_IP: "127.0.0.1" },
    });
    processStarted("server", server);
    server.stdout.resume();
    server.stderr.on("data", (data: Buffer) => { serverError = (serverError + data.toString()).slice(-2000); });
    await waitForSample((deadline) => fetchJsonBefore<{ status: string }>(`${backend}/healthz`, deadline),
      () => true, 15_000);
    vite = await createViteServer({ root: ROOT, configFile: false, appType: "custom", logLevel: "silent",
      server: { host: "127.0.0.1", port: vitePort, strictPort: true, watch: null,
        proxy: { "/api": { target: backend }, "/signal": { target: backend, ws: true } } },
      plugins: [{ name: "embedded-sfu-gate", configureServer(instance) {
        instance.middlewares.use((request, response, next) => {
          if (request.url !== "/embedded-sfu-gate") return next();
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end("<!doctype html><html><head><title>Embedded SFU acceptance</title></head><body></body></html>");
        });
      } }],
    });
    await vite.listen();
    if (nativeArm) {
      result.stage = "native-client-start";
      client = spawn(clientBinary, ["--site", origin, "--capture-process", captureBinary!,
        "--config", join(profile, "client.json")], { cwd: ROOT, stdio: "pipe", windowsHide: true,
        env: { ...process.env, GOMAXPROCS: "2", PIIK_CLIENT_GATE_NO_BROWSER: "true" } });
      processStarted("client", client);
      client.stderr.resume();
      clientPort = (await readClientEndpoint(client, { timeoutMs: 15_000, ignoreNonEndpointLines: true })).port;
      client.stdout.resume();
      result.stage = "native-source-window";
      sourceHTTP = await sourceServer(sourcePort);
      ({ child: sourceChrome, cdp: sourceCdp } = await startSourceBrowser(chromePath, sourceProfile!, sourceDebugPort, sourcePort));
      processStarted("source-browser", sourceChrome);
      await waitForCaptureWindow(captureBinary!);
      const targets = await sourceCdp.call<{ targetInfos: Array<{ targetId: string; url: string }> }>(
        "Target.getTargets", {}, undefined, Date.now() + 5_000);
      const target = targets.targetInfos.find((entry) => entry.url === `http://127.0.0.1:${sourcePort}/`);
      if (!target) throw new Error("Gate source page is unavailable");
      const attached = await sourceCdp.call<{ sessionId: string }>("Target.attachToTarget",
        { targetId: target.targetId, flatten: true }, undefined, Date.now() + 5_000);
      const audioState = await evaluate<string>(sourceCdp, attached, `(async () => {
        const audio = new AudioContext(), tone = audio.createOscillator(), gain = audio.createGain();
        gain.gain.value = 0.01; tone.connect(gain).connect(audio.destination); tone.start();
        window.__gateAudio = audio; await audio.resume(); return audio.state;
      })()`, Date.now() + 5_000);
      if (audioState !== "running") throw new Error("Native source tone did not start");
    }
    chrome = launchChrome(chromePath, debugPort, profile, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-features=WebRtcHideLocalIpsWithMdns",
    ]);
    processStarted("decoder-browser", chrome);
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    if (nativeArm) await cdp.call("Browser.setPermission", {
      permission: { name: "local-network-access" }, setting: "granted", origin,
    }, undefined, Date.now() + 5_000);
    result.stage = "gate-page";
    const gatePage = await fetch(`${origin}/embedded-sfu-gate`, { signal: AbortSignal.timeout(5_000) });
    if (!gatePage.ok || !(await gatePage.text()).includes("Embedded SFU acceptance")) {
      throw new Error("Local SFU gate page is unavailable");
    }
    host = await createPage(cdp, `${origin}/embedded-sfu-gate`);
    viewer = await createPage(cdp, `${origin}/embedded-sfu-gate`, AUDIO_PROBE);
    result.stage = "authenticate";
    const room = await call<CreateRoomResponse>(host, nativeArm
      ? `gate.startHost(${JSON.stringify({ title: SOURCE_TITLE, port: clientPort })}, ${JSON.stringify(codec)})`
      : `gate.startHost(undefined, ${JSON.stringify(codec)})`);
    await until(host, (value) => value.authenticated);
    await call(viewer, `gate.startViewer(${JSON.stringify(room)})`);
    result.stage = "simulcast-first-frame";
    result.viewer = await until(viewer, (value) => value.committed && value.audioKbps > 0);
    if (twoRooms) {
      result.stage = "second-native-room";
      secondHost = await createPage(cdp, `${origin}/embedded-sfu-gate`);
      secondViewer = await createPage(cdp, `${origin}/embedded-sfu-gate`, AUDIO_PROBE);
      const secondRoom = await call<CreateRoomResponse>(secondHost,
        `gate.startHost(${JSON.stringify({ title: SOURCE_TITLE, port: clientPort })}, ${JSON.stringify(codec)})`);
      if (secondRoom.roomId === room.roomId) throw new Error("Native sessions did not create independent rooms");
      await until(secondHost, (value) => value.authenticated);
      await call(secondViewer, `gate.startViewer(${JSON.stringify(secondRoom)})`);
      await until(secondViewer, (value) => value.committed && value.audioKbps > 0);
      await call(secondViewer, "gate.waitForFrames(1280, 720)");
      await waitForSample(() => call<number>(secondViewer!, "gate.audioEnergy()", 3_000),
        (energy) => { result.secondRoom!.audioBefore = energy; return energy > 0; }, 5_000);
      const second = await call<Snapshot>(secondHost, "gate.snapshot()");
      result.secondRoom!.connected = second.published && second.simulcast && second.nativeShareStarted;
    }
    result.stage = "simulcast-first-frame";
    await cdp.call("Page.bringToFront", {}, viewer.sessionId, Date.now() + 3_000);
    result.host = await call(host, "gate.snapshot()");
    result.high = await call(viewer, nativeArm ? "gate.waitForFrames(1280, 720, 300)" : "gate.waitForFrames(1280, 720)", nativeArm ? 32_000 : 25_000);
    result.stage = "decoded-audio-energy";
    await waitForSample(() => call<number>(viewer!, "gate.audioEnergy()", 3_000),
      (energy) => { result.audioEnergy.high = energy; return energy > 0; }, 5_000);
    result.host = await call(host, "gate.snapshot()");
    result.stage = "live-profile";
    if (!await call<boolean>(host, "gate.lowerProfile()")) {
      result.host = await call(host, "gate.snapshot()");
      throw new Error("Live profile update failed");
    }
    result.low = await call(viewer, "gate.waitForFrames(854, 480)");
    await waitForSample(() => call<number>(viewer!, "gate.audioEnergy()", 3_000),
      (energy) => { result.audioEnergy.low = energy; return energy > result.audioEnergy.high; }, 5_000);
    result.stage = "publication-retirement";
    await call(host, "gate.stopSharing()");
    await until(host, (value) => value.publicationRetired);
    await until(viewer, (value) => value.sharingStopped);
    result.publicationRetired = true;
    if (secondHost && secondViewer) {
      result.stage = "second-room-isolation";
      if (!await call<boolean>(host, "gate.stop()")) throw new Error("First Native session did not stop");
      if (!(await call<Snapshot>(host, "gate.snapshot()")).nativeShareStopped) throw new Error("First Native capture did not stop");
      result.secondRoom!.audioBefore = await call<number>(secondViewer, "gate.audioEnergy()");
      await cdp.call("Page.bringToFront", {}, secondViewer.sessionId, Date.now() + 3_000);
      const continued = await call<{ frames: number }>(secondViewer, "gate.waitForFrames(1280, 720, 30)");
      result.secondRoom!.framesAfterFirstStopped = continued.frames;
      await waitForSample(() => call<number>(secondViewer!, "gate.audioEnergy()", 3_000),
        (energy) => { result.secondRoom!.audioAfter = energy; return energy > result.secondRoom!.audioBefore; }, 5_000);
      if ((await call<Snapshot>(secondHost, "gate.snapshot()")).error) throw new Error("First session retirement affected second Native Host");
      await call(secondHost, "gate.stopSharing()");
      await until(secondHost, (value) => value.publicationRetired);
      await until(secondViewer, (value) => value.sharingStopped);
      if (!await call<boolean>(secondHost, "gate.stop()")) throw new Error("Second Native session did not stop");
      result.secondRoom!.stopped = (await call<Snapshot>(secondHost, "gate.snapshot()")).nativeShareStopped;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (viewer && cdp && result.stage === "decoded-audio-energy") result.audioDiagnostics = await evaluate(
      cdp, viewer, "window.__piikGateAudioStats ?? null", Date.now() + 3_000).catch(() => null);
    if (server?.exitCode !== null && serverError) result.error += `; server: ${serverError}`;
  } finally {
    const pagesStopped = await Promise.all([host, viewer, secondHost, secondViewer].map((page) =>
      page && cdp ? call<boolean>(page, "gate.stop()", 5_000).catch(() => false) : true));
    if (host && cdp && nativeArm) {
      result.nativeShareStopped = await call<Snapshot>(host, "gate.snapshot()", 3_000)
        .then((value) => value.nativeShareStopped, () => false);
    }
    const viteClosed = vite
      ? await withDeadline(() => vite!.close(), Date.now() + 5_000).then(() => true, () => false)
      : true;
    const cleanup = await cleanupRun({ cdp, native: client, chrome, server, profile,
      ports: [serverPort, vitePort, debugPort, ...(clientPort ? [clientPort] : [])] });
    const sourceCleanup = sourceProfile ? await cleanupRun({ cdp: sourceCdp, native: null,
      chrome: sourceChrome, server: sourceHTTP, profile: sourceProfile, ports: [sourcePort, sourceDebugPort] }) : null;
    result.udpReleased = await withDeadline(() => udpPort(mediaPort), Date.now() + 3_000)
      .then(() => true, () => false);
    result.cleanup = viteClosed && result.udpReleased && pagesStopped.every(Boolean) &&
      Object.values(cleanup).every(Boolean) && (!sourceCleanup || Object.values(sourceCleanup).every(Boolean));
  }
  result.finishedAt = new Date().toISOString();
  result.passed = !result.error && result.host?.published === true && result.host.simulcast &&
    result.viewer?.decoded === true && result.viewer.committed && result.viewer.peerFailures > 0 &&
    result.viewer.audioKbps > 0 && result.audioEnergy.high > 0 && result.audioEnergy.low > result.audioEnergy.high &&
    result.high !== null && result.low !== null &&
    result.publicationRetired && result.cleanup && result.nativeShareStopped &&
    (!result.secondRoom || result.secondRoom.connected && result.secondRoom.framesAfterFirstStopped >= 30 &&
      result.secondRoom.audioBefore > 0 && result.secondRoom.audioAfter > result.secondRoom.audioBefore && result.secondRoom.stopped) &&
    (!nativeArm || result.host.nativeShareStarted && result.host.nativeFramesPerSecond > 0 && result.host.nativeBitrateKbps > 0 && result.host.nativeEncodingCount === 2);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

await main();
