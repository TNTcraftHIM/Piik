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

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "embedded-media");
type Snapshot = ReturnType<typeof snapshot>;

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
  if (process.env.SCREENER_EMBEDDED_SFU_GATE !== "true") {
    throw new Error("SCREENER_EMBEDDED_SFU_GATE=true is required; this is an explicit local Browser media gate");
  }
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");
  await mkdir(BUILD_ROOT, { recursive: true });
  const binary = join(BUILD_ROOT, `screener-server${process.platform === "win32" ? ".exe" : ""}`);
  const build = spawnSync(process.env.SCREENER_GO?.trim() || "go", [
    "build", "-trimpath", "-o", binary, "./cmd/screener-server",
  ], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (build.error || build.status !== 0) throw build.error ?? new Error(build.stderr || "Server build failed");
  const [serverPort, vitePort, debugPort, mediaPort] = await Promise.all([
    reservePort(), reservePort(), reservePort(), udpPort(),
  ]);
  const origin = `http://127.0.0.1:${vitePort}`;
  const backend = `http://127.0.0.1:${serverPort}`;
  const profile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  const result = { passed: false, arm: "browser-vp8-simulcast", stage: "start",
    high: null as { frames: number; width: number; height: number } | null,
    low: null as { frames: number; width: number; height: number } | null,
    host: null as Snapshot | null, viewer: null as Snapshot | null,
    publicationRetired: false, udpReleased: false, cleanup: false, error: null as string | null };
  let server: ChildProcessWithoutNullStreams | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let vite: ViteDevServer | null = null;
  let cdp: CdpConnection | null = null;
  let host: PageHandle | null = null;
  let viewer: PageHandle | null = null;
  let serverError = "";
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
  try {
    server = spawn(binary, [], { cwd: ROOT, stdio: "pipe", windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        SCREENER_ENV: "development", LISTEN_HOST: "127.0.0.1", PORT: String(serverPort),
        PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: origin,
        SFU_LISTEN_HOST: "127.0.0.1", SFU_UDP_PORT: String(mediaPort), SFU_PUBLIC_IP: "127.0.0.1" },
    });
    server.stdout.resume();
    server.stderr.on("data", (data: Buffer) => { serverError = (serverError + data.toString()).slice(-2000); });
    await waitForSample((deadline) => fetchJsonBefore<{ status: string }>(`${backend}/healthz`, deadline),
      () => true, 15_000);
    vite = await createViteServer({ root: ROOT, configFile: false, appType: "custom", logLevel: "silent",
      server: { host: "127.0.0.1", port: vitePort, strictPort: true,
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
    chrome = launchChrome(chromePath, debugPort, profile, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-features=WebRtcHideLocalIpsWithMdns",
    ]);
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    host = await createPage(cdp, `${origin}/embedded-sfu-gate`);
    viewer = await createPage(cdp, `${origin}/embedded-sfu-gate`);
    result.stage = "authenticate";
    const room = await call<CreateRoomResponse>(host, "gate.startHost()");
    await until(host, (value) => value.authenticated);
    await call(viewer, `gate.startViewer(${JSON.stringify(room)})`);
    result.stage = "simulcast-first-frame";
    result.viewer = await until(viewer, (value) => value.committed && value.audioKbps > 0);
    result.host = await call(host, "gate.snapshot()");
    result.high = await call(viewer, "gate.waitForFrames(1280, 720)");
    result.stage = "live-profile";
    if (!await call<boolean>(host, "gate.lowerProfile()")) {
      result.host = await call(host, "gate.snapshot()");
      throw new Error("Live profile update failed");
    }
    result.low = await call(viewer, "gate.waitForFrames(854, 480)");
    result.stage = "publication-retirement";
    await call(host, "gate.stopSharing()");
    await until(host, (value) => value.publicationRetired);
    await until(viewer, (value) => value.sharingStopped);
    result.publicationRetired = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (server?.exitCode !== null && serverError) result.error += `; server: ${serverError}`;
  } finally {
    const pagesStopped = await Promise.all([host, viewer].map((page) =>
      page && cdp ? call<boolean>(page, "gate.stop()", 5_000).catch(() => false) : true));
    const viteClosed = vite
      ? await withDeadline(() => vite!.close(), Date.now() + 5_000).then(() => true, () => false)
      : true;
    const cleanup = await cleanupRun({ cdp, native: null, chrome, server, profile,
      ports: [serverPort, vitePort, debugPort] });
    result.udpReleased = await withDeadline(() => udpPort(mediaPort), Date.now() + 3_000)
      .then(() => true, () => false);
    result.cleanup = viteClosed && result.udpReleased && pagesStopped.every(Boolean) &&
      Object.values(cleanup).every(Boolean);
  }
  result.passed = !result.error && result.host?.published === true && result.host.simulcast &&
    result.viewer?.decoded === true && result.viewer.committed && result.viewer.peerFailures > 0 &&
    result.viewer.audioKbps > 0 && result.high !== null && result.low !== null &&
    result.publicationRetired && result.cleanup;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

await main();
