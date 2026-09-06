import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AccessToken } from "livekit-server-sdk";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  launchChrome,
  reservePort,
  type PageHandle,
  waitForVersion,
} from "./browser-gate-harness";
import {
  closeSourceBrowser,
  powershell,
  SOURCE_TITLE,
  sourceServer,
  startSourceBrowser,
  waitForCaptureWindow,
} from "./client-native-host-gate";
import {
  readClientEndpoint,
} from "./client-gate-endpoint";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "client-check");

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `${command} failed`);
  }
}

async function reserveUDPPort(): Promise<number> {
  const socket = createSocket("udp4");
  return await new Promise<number>((resolvePort, rejectPort) => {
    socket.once("error", rejectPort);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHTTP(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The isolated service is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`service did not become ready: ${url}`);
}

async function issueToken(
  apiKey: string,
  apiSecret: string,
  room: string,
  identity: string,
  publish: boolean,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { identity, ttl: 300 });
  token.addGrant({
    roomJoin: true,
    room,
    canPublish: publish,
    canSubscribe: !publish,
    canPublishData: false,
  });
  return await token.toJwt();
}

async function stopProcess(process: ChildProcessWithoutNullStreams | null): Promise<boolean> {
  if (!process || process.exitCode !== null || process.signalCode !== null) return true;
  process.kill();
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The native SFU gate currently requires Windows");
  }
  if (process.env.SCREENER_CLIENT_NATIVE_SFU_GATE !== "true") {
    throw new Error("SCREENER_CLIENT_NATIVE_SFU_GATE=true is required");
  }
  const chromePath = process.env.CHROME_PATH?.trim();
  const livekitPath = process.env.SCREENER_LIVEKIT_SERVER?.trim();
  if (!chromePath || !livekitPath) {
    throw new Error("CHROME_PATH and SCREENER_LIVEKIT_SERVER are required");
  }
  const go = process.env.SCREENER_GO?.trim() || "go";
  const sourcePort = await reservePort();
  const sourceDebugPort = await reservePort();
  const vitePort = await reservePort();
  const debugPort = await reservePort();
  const livekitPort = await reservePort();
  const livekitTCPPort = await reservePort();
  const livekitUDPPort = await reserveUDPPort();
  const profile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  const sourceProfile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  const configPath = join(profile, "client.json");
  const captureBinary = join(BUILD_ROOT, "screener-client-capture.exe");
  const clientBinary = join(BUILD_ROOT, "screener-client.exe");
  const origin = `http://127.0.0.1:${vitePort}`;
  const livekitURL = `ws://127.0.0.1:${livekitPort}`;
  const apiKey = `gate${randomBytes(8).toString("hex")}`;
  const apiSecret = randomBytes(32).toString("base64url");
  const room = `native-sfu-${randomBytes(8).toString("hex")}`;
  const result = {
    passed: false,
    hostPublished: false,
    viewerFrames: 0,
    viewerWidth: 0,
    viewerHeight: 0,
    profileUpdated: false,
    cleanup: false,
    error: null as string | null,
    stage: "setup",
  };
  let vite: ViteDevServer | null = null;
  let livekit: ChildProcessWithoutNullStreams | null = null;
  let client: ChildProcessWithoutNullStreams | null = null;
  let source: { close(): Promise<void> } | null = null;
  let sourceChrome: ChildProcessWithoutNullStreams | null = null;
  let sourceCdp: CdpConnection | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let hostPage: PageHandle | null = null;
  let viewerPage: PageHandle | null = null;
  let clientPort = 0;
  try {
    result.stage = "build";
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build:client"]);
    run(powershell(), [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(ROOT, "native", "capture", "windows", "build.ps1"),
      "-OutputDirectory", BUILD_ROOT,
    ]);
    run(go, ["build", "-trimpath", "-o", clientBinary, "./cmd/screener-client"],
      ROOT);

    result.stage = "livekit";
    livekit = spawn(livekitPath, [
      "--bind", "127.0.0.1",
      "--node-ip", "127.0.0.1",
      "--port", String(livekitPort),
      "--udp-port", String(livekitUDPPort),
      "--rtc.tcp_port", String(livekitTCPPort),
      "--rtc.enable_loopback_candidate",
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, LIVEKIT_KEYS: `${apiKey}: ${apiSecret}` },
    });
    livekit.stdout.resume();
    livekit.stderr.resume();
    await waitForHTTP(`http://127.0.0.1:${livekitPort}`, 10_000);

    result.stage = "vite";
    vite = await createViteServer({
      root: ROOT,
      appType: "custom",
      logLevel: "silent",
      server: { host: "127.0.0.1", port: vitePort, strictPort: true },
      plugins: [{
        name: "native-sfu-gate-page",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split("?", 1)[0] !== "/native-sfu-gate") {
              next();
              return;
            }
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end("<!doctype html><html><body></body></html>");
          });
        },
      }],
    });
    await vite.listen();

    result.stage = "source";
    source = await sourceServer(sourcePort);
    ({ child: sourceChrome, cdp: sourceCdp } = await startSourceBrowser(
      chromePath,
      sourceProfile,
      sourceDebugPort,
      sourcePort,
    ));
    await waitForCaptureWindow(captureBinary);

    result.stage = "client";
    client = spawn(clientBinary, [
      "--site", origin,
      "--capture-process", captureBinary,
      "--config", configPath,
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, SCREENER_CLIENT_GATE_NO_BROWSER: "true" },
    });
    client.stderr.resume();
    clientPort = (await readClientEndpoint(client, {
      ignoreNonEndpointLines: true,
    })).port;

    result.stage = "browser";
    chrome = launchChrome(chromePath, debugPort, profile, [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-logging",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ]);
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    hostPage = await createPage(cdp, `${origin}/native-sfu-gate`, undefined, true);
    viewerPage = await createPage(cdp, `${origin}/native-sfu-gate`, undefined, true);
    const hostToken = await issueToken(apiKey, apiSecret, room, "host", true);
    const viewerToken = await issueToken(apiKey, apiSecret, room, "viewer", false);

    result.stage = "publish";
    const hostResult = await evaluate<{ audio?: boolean; error?: string }>(
      cdp,
      hostPage,
      `(async () => { try {
        const gate = await import('/scripts/client-native-sfu-page.ts');
        return await gate.startNativeSfuHost(${JSON.stringify({
          url: livekitURL,
          token: hostToken,
          sourceTitle: SOURCE_TITLE,
        })});
      } catch (error) {
        return { error: String(error?.stack || error?.message || error) };
      } })()`,
      Date.now() + 30_000,
    );
    if (hostResult.error) throw new Error(hostResult.error);
    result.hostPublished = true;

    result.stage = "subscribe";
    const viewer = await evaluate<{
      frames?: number;
      width?: number;
      height?: number;
      error?: string;
    }>(
      cdp,
      viewerPage,
      `(async () => { try {
        const gate = await import('/scripts/client-native-sfu-page.ts');
        return await gate.startNativeSfuViewer(${JSON.stringify({
          url: livekitURL,
          token: viewerToken,
        })});
      } catch (error) {
        return { error: String(error?.stack || error?.message || error) };
      } })()`,
      Date.now() + 30_000,
    );
    if (viewer.error) throw new Error(viewer.error);
    result.viewerFrames = viewer.frames ?? 0;
    result.viewerWidth = viewer.width ?? 0;
    result.viewerHeight = viewer.height ?? 0;
    result.stage = "profile-update";
    const updated = await evaluate<boolean>(
      cdp,
      hostPage,
      `(async () => {
        const gate = await import('/scripts/client-native-sfu-page.ts');
        return await gate.updateNativeSfuHost({
          resolution: '480p',
          maxFramerate: 15,
          maxBitrate: 2000000,
          degradationPreference: 'maintain-resolution',
          screenAudioQuality: 'saver',
        });
      })()`,
      Date.now() + 20_000,
    );
    const updatedViewer = await evaluate<{
      frames: number;
      width: number;
      height: number;
    }>(
      cdp,
      viewerPage,
      `import('/scripts/client-native-sfu-page.ts').then((gate) =>
        gate.waitForNativeSfuViewer(854, 480))`,
      Date.now() + 25_000,
    );
    result.profileUpdated = updated && updatedViewer.frames >= 15;
    result.viewerFrames = updatedViewer.frames;
    result.viewerWidth = updatedViewer.width;
    result.viewerHeight = updatedViewer.height;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (cdp && viewerPage) {
      await evaluate(
        cdp,
        viewerPage,
        "import('/scripts/client-native-sfu-page.ts').then((gate) => gate.stopNativeSfuGate())",
        Date.now() + 5_000,
      ).catch(() => undefined);
    }
    if (cdp && hostPage) {
      await evaluate(
        cdp,
        hostPage,
        "import('/scripts/client-native-sfu-page.ts').then((gate) => gate.stopNativeSfuGate())",
        Date.now() + 5_000,
      ).catch(() => undefined);
    }
    await vite?.close().catch(() => undefined);
    if (sourceChrome && sourceCdp) {
      await closeSourceBrowser(sourceChrome, sourceCdp).catch(() => false);
      sourceChrome = null;
      sourceCdp = null;
    }
    await source?.close().catch(() => undefined);
    const livekitStopped = await stopProcess(livekit);
    const cleanup = await cleanupRun({
      cdp,
      native: client,
      chrome,
      server: null,
      profile,
      ports: [
        vitePort,
        debugPort,
        livekitPort,
        livekitTCPPort,
        ...(clientPort ? [clientPort] : []),
      ],
    });
    const sourceCleanup = await cleanupRun({
      cdp: null,
      native: sourceChrome,
      chrome: null,
      server: null,
      profile: sourceProfile,
      ports: [sourcePort, sourceDebugPort],
    });
    result.cleanup = livekitStopped && cleanup.browserExited &&
      cleanup.nativeExited && cleanup.portsClosed && cleanup.profileRemoved &&
      sourceCleanup.profileRemoved && sourceCleanup.portsClosed;
  }
  result.passed = result.error === null && result.hostPublished &&
    result.profileUpdated && result.viewerFrames >= 15 &&
    result.viewerWidth === 854 && result.viewerHeight === 480 && result.cleanup;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

await main();
