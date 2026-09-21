import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  launchChrome,
  reservePort,
  type PageHandle,
  waitForVersion,
  withDeadline,
} from "./browser-gate-harness";
import {
  decodeAppEndpoint,
  type AppEndpoint as Endpoint,
} from "./app-gate-endpoint";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "go-check");
export const SOURCE_TITLE = "Piik Native Gate Source";

type GateMode = "local" | "cross-nat" | "one-link";
type VideoCodec = "h264" | "vp8";

const CODEC_PROBE = `(() => {
  const peers = [], BrowserPeer = RTCPeerConnection;
  const sockets = [], BrowserSocket = WebSocket;
  window.WebSocket = class extends BrowserSocket {
    constructor(...args) { super(...args); sockets.push(this); }
  };
  window.__piikGatePublicSignal = () => sockets.some((socket) => {
    const url = new URL(socket.url);
    return socket.readyState === WebSocket.OPEN && url.protocol === 'wss:' &&
      url.host === location.host && url.pathname === '/signal';
  });
  window.RTCPeerConnection = class extends BrowserPeer {
    constructor(...args) { super(...args); peers.push(this); }
  };
  window.__piikGateVideoCodec = async () => {
    const trackId = document.querySelector('video')?.srcObject?.getVideoTracks()[0]?.id;
    if (!trackId) return null;
    for (const peer of peers) {
      if (peer.connectionState !== 'connected') continue;
      const report = await peer.getStats();
      for (const row of report.values()) {
        if (row.type !== 'inbound-rtp' || row.kind !== 'video' ||
            row.trackIdentifier !== trackId || !(row.framesDecoded > 0)) continue;
        const mime = report.get(row.codecId)?.mimeType?.toLowerCase();
        if (mime === 'video/h264' || mime === 'video/vp8') return mime.slice(6);
      }
    }
    return null;
  };
})()`;

interface GateResult {
  passed: boolean;
  requestedCodec: VideoCodec | "auto";
  actualCodec: VideoCodec | null;
  codecPreserved: boolean;
  hostNativeActive: boolean;
  hostInvite: boolean;
  preSharePreferenceEnabled: boolean;
  qualityControlsEnabled: boolean;
  livePresetChanges: number;
  liveQualityChanged: boolean;
  pausedQualityChanged: boolean;
  backgroundProfileRecovery: boolean | null;
  mediaObjectPreserved: boolean;
  nativeSourceChanged: boolean;
  nativeQualityEvidence: boolean;
  viewerConnected: boolean;
  viewerFrames: number;
  viewerWidth: number;
  viewerHeight: number;
  remoteViewerConnected: boolean;
  remoteViewerPackets: number;
  remoteLocalCandidateType: string;
  remoteRemoteCandidateType: string;
  remoteNatPath: boolean;
  remotePeerExited: boolean | null;
  reverseSignalTunnelClosed: boolean | null;
  sourceFailureEndedShare: boolean | null;
  replacementViewerConnected: boolean | null;
  replacementViewerFrames: number | null;
  appCrashEndedShare: boolean | null;
  mode: GateMode;
  viewerLocation: "local-browser" | "public-url-browser" | "remote-peer";
  publicViewerPage: boolean;
  publicViewerSignal: boolean;
  cleanup: Awaited<ReturnType<typeof cleanupRun>>;
  error: string | null;
  stage?: string;
}

interface RemoteGateOptions {
  host: string;
  user: string;
  key: string;
  signalPort: number;
  bindAddress: string | null;
}

interface RemoteGateResult {
  passed: boolean;
  packets: number;
  localCandidateType: string;
  remoteCandidateType: string;
  error: string | null;
}

function run(
  command: string,
  args: string[],
  cwd = ROOT,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || command + " failed");
  }
  return result.stdout.trim();
}

async function waitForChild(
  child: ChildProcessWithoutNullStreams | ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return withDeadline(
    () => new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    }),
    Date.now() + timeoutMs,
  );
}

async function stopChild(child: ChildProcessWithoutNullStreams | ChildProcess | null): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill();
  try {
    await waitForChild(child, 5_000);
  } catch {
    if (process.platform === "win32" && child.pid !== undefined) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
      try {
        await waitForChild(child, 2_000);
      } catch {
        // The process state below is the final cleanup check.
      }
    }
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function selectNativeSource(
  cdp: CdpConnection,
  page: PageHandle,
  kind: "window" | "display",
  title?: string,
): Promise<void> {
  await evaluate<void>(
    cdp,
    page,
    `document.querySelector('button[data-source-tab="${kind}"]')?.click()`,
    Date.now() + 5_000,
  );
  const selector = kind === "display"
    ? "button[data-native-source^='display:']"
    : "button[data-native-source]";
  const predicate = title
    ? `(button) => button.textContent?.includes(${JSON.stringify(title)})`
    : "() => true";
  await waitForValue(
    (deadline) => evaluate<boolean>(
      cdp,
      page,
      `([...document.querySelectorAll(${JSON.stringify(selector)})].some(${predicate}))`,
      deadline,
    ),
    Boolean,
    15_000,
  );
  await evaluate<void>(
    cdp,
    page,
    `([...document.querySelectorAll(${JSON.stringify(selector)})].find(${predicate}))?.click()`,
    Date.now() + 5_000,
  );
}

async function clickHostControl(
  cdp: CdpConnection,
  page: PageHandle,
  buttonExpression: string,
): Promise<void> {
  await cdp.call("Page.bringToFront", {}, page.sessionId, Date.now() + 5_000);
  const point = await evaluate<{ x: number; y: number }>(
    cdp,
    page,
    `new Promise((resolve) => {
      const button = ${buttonExpression};
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true')
        throw new Error('Host control is unavailable');
      button.scrollIntoView({block: 'center'});
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = button.getBoundingClientRect();
        resolve({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});
      }));
    })`,
    Date.now() + 5_000,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.call("Input.dispatchMouseEvent", {
      type, ...point, button: "left", clickCount: 1,
    }, page.sessionId, Date.now() + 5_000);
  }
}

async function readVideoCodec(cdp: CdpConnection, page: PageHandle): Promise<VideoCodec> {
  const codec = await waitForValue(
    (deadline) => evaluate<VideoCodec | null>(cdp, page, "window.__piikGateVideoCodec()", deadline),
    (value) => value === "vp8" || value === "h264",
    5_000,
  );
  if (codec === null) throw new Error("No decoded video codec was observed");
  return codec;
}

async function assertVideoCodec(cdp: CdpConnection, page: PageHandle, expected: VideoCodec): Promise<void> {
  const codec = await readVideoCodec(cdp, page);
  if (codec !== expected) throw new Error(`Native codec changed from ${expected} to ${codec}`);
}

function remoteOptions(): RemoteGateOptions {
  const host = process.env.PIIK_REMOTE_HOST?.trim();
  const user = process.env.PIIK_REMOTE_USER?.trim() || "root";
  const key = process.env.PIIK_REMOTE_SSH_KEY?.trim();
  const signalPortText = process.env.PIIK_REMOTE_SIGNAL_PORT?.trim() || "49721";
  const signalPort = Number(signalPortText);
  if (!host || !key || !Number.isInteger(signalPort) || signalPort < 1024 || signalPort > 65_535) {
    throw new Error(
      "PIIK_REMOTE_HOST, PIIK_REMOTE_SSH_KEY, and a valid PIIK_REMOTE_SIGNAL_PORT are required",
    );
  }
  return {
    host,
    user,
    key,
    signalPort,
    bindAddress: process.env.PIIK_REMOTE_BIND_ADDRESS?.trim() || null,
  };
}

function remoteTransportOptions(options: RemoteGateOptions): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    ...(options.bindAddress
      ? ["-o", `BindAddress=${options.bindAddress}`]
      : []),
    "-i", options.key,
  ];
}

async function runRemotePeerGate(
  binary: string,
  options: RemoteGateOptions,
  signalUrl: string,
  roomId: string,
  viewerGrant: string,
  origin: string,
): Promise<RemoteGateResult> {
  const ssh = process.env.PIIK_SSH?.trim() || "ssh";
  const scp = process.env.PIIK_SCP?.trim() || "scp";
  const destination = `${options.user}@${options.host}`;
  const remotePath = `/tmp/piik-peer-gate-${randomBytes(8).toString("hex")}`;
  const transportOptions = remoteTransportOptions(options);
  try {
    run(scp, [...transportOptions, binary, `${destination}:${remotePath}`], ROOT, process.env, 30_000);
    run(ssh, [...transportOptions, destination, "chmod", "700", remotePath], ROOT, process.env, 15_000);
    const remote = spawn(
      ssh,
      [
        ...transportOptions,
        "-T",
        destination,
        remotePath,
        "--config",
        "-",
      ],
      { stdio: "pipe", windowsHide: true },
    );
    let stdout = "";
    remote.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-16_384);
    });
    remote.stderr.resume();
    remote.stdin.end(JSON.stringify({
      signalUrl,
      origin,
      roomId,
      viewerGrant,
      timeoutSeconds: 45,
      minPackets: 30,
    }));
    let exitCode: number | null;
    try {
      exitCode = await waitForChild(remote, 60_000);
    } catch {
      await stopChild(remote);
      return {
        passed: false,
        packets: 0,
        localCandidateType: "",
        remoteCandidateType: "",
        error: "remote peer gate timed out",
      };
    }
    const line = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1);
    let parsed: Partial<RemoteGateResult> = {};
    if (line) {
      try {
        parsed = JSON.parse(line) as Partial<RemoteGateResult>;
      } catch {
        parsed = {};
      }
    }
    return {
      passed: parsed.passed === true && exitCode === 0,
      packets: typeof parsed.packets === "number" ? parsed.packets : 0,
      localCandidateType: typeof parsed.localCandidateType === "string"
        ? parsed.localCandidateType
        : "",
      remoteCandidateType: typeof parsed.remoteCandidateType === "string"
        ? parsed.remoteCandidateType
        : "",
      error: typeof parsed.error === "string"
        ? parsed.error
        : exitCode === 0 ? null : "remote peer gate failed",
    };
  } finally {
    try {
      run(ssh, [...transportOptions, destination, "rm", "-f", remotePath], ROOT, process.env, 10_000);
    } catch {
      // The temporary binary is harmless if an already-closed SSH session
      // prevents cleanup; the gate never places it in the repository.
    }
  }
}

export function powershell(): string {
  return process.env.PIIK_POWERSHELL?.trim() || join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function sourceHTML(): string {
  return [
    "<!doctype html><title>" + SOURCE_TITLE + "</title>",
    "<style>html,body,canvas{margin:0;width:100%;height:100%;overflow:hidden;background:#102030}</style>",
    "<canvas width=\"1280\" height=\"720\"></canvas><script>",
    "const c=document.querySelector('canvas'),x=c.getContext('2d');let n=0;",
    "function f(){x.fillStyle='hsl('+(n*5%360)+' 70% 45%)';x.fillRect(0,0,1280,720);",
    "x.fillStyle='#fff';x.fillRect((n*19)%1100,160,180,400);x.font='60px sans-serif';x.fillText(n,42,92);n++;requestAnimationFrame(f)}f();",
    "</script>",
  ].join("");
}

export async function sourceServer(port: number): Promise<{ close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(sourceHTML());
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return {
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

export async function startSourceBrowser(
  chromePath: string,
  profile: string,
  debugPort: number,
  sourcePort: number,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  cdp: CdpConnection;
}> {
  const child = await launchChrome(chromePath, debugPort, profile, [
    "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-logging",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--app=http://127.0.0.1:" + sourcePort + "/",
  ]);
  child.stdout.resume();
  child.stderr.resume();
  try {
    const version = await waitForVersion(debugPort, child);
    const cdp = await CdpConnection.connect(
      version.webSocketDebuggerUrl,
      Date.now() + 10_000,
    );
    return { child, cdp };
  } catch (error) {
    await cleanupRun({ chrome: child, cdp: null, native: null, server: null, profile: null, ports: [debugPort] });
    throw error;
  }
}

export async function closeSourceBrowser(
  child: ChildProcessWithoutNullStreams,
  cdp: CdpConnection,
): Promise<boolean> {
  try {
    await cdp.call("Browser.close", {}, undefined, Date.now() + 2_000);
  } catch {}
  cdp.close();
  try {
    await waitForChild(child, 5_000);
    return true;
  } catch {
    return stopChild(child);
  }
}

export async function waitForCaptureWindow(captureBinary: string): Promise<void> {
  await waitForValue(
    async () => JSON.parse(run(captureBinary, ["--list"], ROOT, process.env, 5_000)) as Array<{
      title?: unknown;
    }>,
    (targets) => targets.some((target) =>
      typeof target.title === "string" && target.title.includes(SOURCE_TITLE)
    ),
    10_000,
  );
}

async function waitForValue<T>(
  sample: (deadline: number) => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await withDeadline(() => sample(deadline), deadline);
      if (accept(value)) return value;
    } catch {
      // A transient page or signaling state is retried within the gate bound.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Native Host gate timed out");
}

async function readAppEndpoint(
  child: ChildProcessWithoutNullStreams,
  requirePublicOrigin = false,
): Promise<{
  endpoint: Endpoint;
  password: string;
  publicOrigin: string | null;
}> {
  let buffered = "";
  const lines: string[] = [];
  let endpoint: Endpoint | null = null;
  return withDeadline(
    () => new Promise((resolveEndpoint, rejectEndpoint) => {
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString();
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          lines.push(line);
          try {
            endpoint = decodeAppEndpoint(line);
          } catch {
            // Informational lines are printed after the endpoint.
          }
          const passwordLine = lines.find((entry) => entry.startsWith("Local access password: "));
          const openAccessLine = lines.find((entry) => entry === "Local access: open");
          const publicOriginLine = lines.find((entry) =>
            entry.startsWith("Public invitation origin: ")
          );
          if (endpoint && (passwordLine || openAccessLine) &&
            (!requirePublicOrigin || publicOriginLine)) {
            child.stdout.off("data", onData);
            resolveEndpoint({
              endpoint,
              password: passwordLine
                ? passwordLine.slice("Local access password: ".length)
                : "",
              publicOrigin:
                publicOriginLine?.slice("Public invitation origin: ".length) ?? null,
            });
            return;
          }
        }
      };
      child.stdout.on("data", onData);
      child.once("error", rejectEndpoint);
      child.once("exit", (code) =>
        rejectEndpoint(new Error("App exited before readiness (" + String(code) + ")")),
      );
    }),
    Date.now() + 15_000,
  );
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The native Host gate currently requires Windows");
  }
  if (process.env.PIIK_CLIENT_NATIVE_HOST_GATE !== "true") {
    throw new Error("PIIK_CLIENT_NATIVE_HOST_GATE=true is required");
  }
  const crossNat = process.env.PIIK_CLIENT_CROSS_NAT_GATE === "true";
  const linkMedia = process.env.PIIK_CLIENT_LINK_MEDIA_GATE === "true";
  if (crossNat && linkMedia) {
    throw new Error("Cross-NAT and one-link gate modes are mutually exclusive");
  }
  const mode: GateMode = linkMedia ? "one-link" : crossNat ? "cross-nat" : "local";
  const gateStunUrls = process.env.PIIK_CLIENT_GATE_STUN_URLS?.trim();
  if (mode === "cross-nat" && !gateStunUrls) {
    throw new Error("PIIK_CLIENT_GATE_STUN_URLS is required for the cross-NAT gate");
  }
  const crashGate =
    process.env.PIIK_CLIENT_NATIVE_HOST_CRASH_GATE === "true";
  if (crashGate && mode !== "local") {
    throw new Error("App crash gate requires local mode");
  }
  const sourceKind: "window" | "display" =
    process.env.PIIK_CLIENT_NATIVE_HOST_SOURCE === "display"
      ? "display"
      : "window";
  const requestedCodec = process.env.PIIK_CLIENT_NATIVE_HOST_CODEC?.trim() || "auto";
  if (requestedCodec !== "auto" && requestedCodec !== "h264" && requestedCodec !== "vp8") {
    throw new Error("PIIK_CLIENT_NATIVE_HOST_CODEC must be auto, h264, or vp8");
  }
  const remote = mode === "cross-nat" || mode === "one-link" &&
    Boolean(process.env.PIIK_REMOTE_HOST?.trim() || process.env.PIIK_REMOTE_SSH_KEY?.trim())
      ? remoteOptions() : null;
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const go = process.env.PIIK_GO?.trim() || "go";
  const tunnel = process.env.PIIK_CLOUDFLARED?.trim() || join(
    BUILD_ROOT,
    "cloudflared.exe",
  );
  const profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  const sourceProfile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  await mkdir(BUILD_ROOT, { recursive: true });
  const diagnosticDirectory = await mkdtemp(join(BUILD_ROOT, "native-host-gate-"));
  const sourcePort = await reservePort();
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const sourceDebugPort = await reservePort();
  const appConfig = join(profile, "client.json");
  const captureBuild = BUILD_ROOT;
  const appBinary = join(BUILD_ROOT, "piik-app.exe");
  const captureBinary = join(captureBuild, "piik-capture.exe");
  const remoteBinary = join(BUILD_ROOT, "piik-peer-gate-linux");
  let source: { close(): Promise<void> } | null = null;
  let app: ChildProcessWithoutNullStreams | null = null;
  let sourceChrome: ChildProcessWithoutNullStreams | null = null;
  let sourceCdp: CdpConnection | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let nativePort = 0;
  let remoteTunnel: ChildProcess | null = null;
  let stage = "setup";
  const result: GateResult = {
    passed: false,
    requestedCodec,
    actualCodec: null,
    codecPreserved: false,
    hostNativeActive: false,
    hostInvite: false,
    preSharePreferenceEnabled: false,
    qualityControlsEnabled: false,
    livePresetChanges: 0,
    liveQualityChanged: false,
    pausedQualityChanged: false,
    backgroundProfileRecovery: mode === "local" && sourceKind === "window" ? false : null,
    mediaObjectPreserved: false,
    nativeSourceChanged: false,
    nativeQualityEvidence: false,
    viewerConnected: false,
    viewerFrames: 0,
    viewerWidth: 0,
    viewerHeight: 0,
    remoteViewerConnected: false,
    remoteViewerPackets: 0,
    remoteLocalCandidateType: "",
    remoteRemoteCandidateType: "",
    remoteNatPath: false,
    remotePeerExited: null,
    reverseSignalTunnelClosed: mode === "cross-nat" ? false : null,
    sourceFailureEndedShare: mode === "local" ? false : null,
    replacementViewerConnected: mode === "local" ? false : null,
    replacementViewerFrames: mode === "local" ? 0 : null,
    appCrashEndedShare: crashGate ? false : null,
    mode,
    viewerLocation: remote ? "remote-peer" : mode === "one-link" ? "public-url-browser" : "local-browser",
    publicViewerPage: false,
    publicViewerSignal: false,
    cleanup: {
      browserExited: false,
      nativeExited: false,
      serverClosed: false,
      portsClosed: false,
      profileRemoved: false,
    },
    error: null,
  };
  try {
    stage = "web-build";
    run(process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", "npm run build:web",
    ]);
    stage = "source-server";
    source = await sourceServer(sourcePort);
    stage = "capture-build";
    process.stderr.write(`${JSON.stringify({ stage, status: "started", at: new Date().toISOString() })}\n`);
    run(powershell(), [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(ROOT, "native", "capture", "windows", "build.ps1"),
      "-OutputDirectory", captureBuild,
    ]);
    process.stderr.write(`${JSON.stringify({ stage, status: "finished", at: new Date().toISOString() })}\n`);
    stage = "app-build";
    run(go, [
      "build", "-p", "1", "-trimpath", "-o", appBinary, "./cmd/piik-app",
    ], ROOT, { ...process.env, GOMAXPROCS: "2" });
    if (remote) {
      stage = "remote-peer-build";
      run(
        go,
        ["build", "-trimpath", "-o", remoteBinary, "./cmd/piik-peer-gate"],
        ROOT,
        { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
      );
    }
    stage = "source-browser";
    ({ child: sourceChrome, cdp: sourceCdp } = await startSourceBrowser(
      chromePath,
      sourceProfile,
      sourceDebugPort,
      sourcePort,
    ));
    await waitForCaptureWindow(captureBinary);
    stage = "app-start";
    app = spawn(appBinary, [
      mode === "one-link" ? "--link" : "--local",
      ...(mode === "one-link"
        ? ["--tunnel-process", tunnel]
        : []),
      "--capture-process", captureBinary,
      "--config", appConfig,
      "--port", String(appPort),
      "--debug", "--log-dir", diagnosticDirectory,
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        PIIK_DEBUG: "",
        PIIK_CLIENT_GATE_NO_BROWSER: "true",
        // STUN_URLS reaches only the App's own Pion edge: the in-process
        // room server never reads it, so the cross-NAT arm stays isolated.
        ...(mode === "cross-nat" && gateStunUrls
          ? { STUN_URLS: gateStunUrls }
          : {}),
      },
    });
    app.stderr.resume();
    stage = "app-ready";
    const appInfo = await readAppEndpoint(app, mode === "one-link");
    nativePort = appInfo.endpoint.port;
    if (mode === "cross-nat" && remote) {
      stage = "signaling-tunnel";
      const tunnel = spawn(
        process.env.PIIK_SSH?.trim() || "ssh",
        [
          "-N", "-T",
          ...remoteTransportOptions(remote),
          "-o", "ExitOnForwardFailure=yes",
          "-R", `127.0.0.1:${remote.signalPort}:127.0.0.1:${appPort}`,
          `${remote.user}@${remote.host}`,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      remoteTunnel = tunnel;
      tunnel.on("error", () => undefined);
      await new Promise((resolveTunnel) => setTimeout(resolveTunnel, 300));
      if (tunnel.exitCode !== null) {
        throw new Error("signaling tunnel could not start");
      }
    }
    stage = "local-server-ready";
    await waitForValue(
      async () => {
        const response = await fetch("http://127.0.0.1:" + appPort + "/healthz");
        return response.ok;
      },
      Boolean,
      15_000,
    );
    stage = "host-browser";
    chrome = await launchChrome(chromePath, debugPort, profile, [
      "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-logging",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
    ]);
    chrome.stdout.resume();
    chrome.stderr.resume();
    stage = "host-cdp";
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    const hostBootstrap = new URLSearchParams({
      ...(appInfo.password ? { "client-access": appInfo.password } : {}),
      "piik-client": "1",
    }).toString();
    stage = "host-page";
    const host = await createPage(
      cdp,
      "http://localhost:" + appPort + "/?debug=1#" + hostBootstrap,
      CODEC_PROBE,
      true,
    );
    await waitForValue(
      (deadline) => evaluate<boolean>(
        cdp!,
        host,
        "Boolean(document.querySelector('button.lr-tv-big.is-action'))",
        deadline,
      ),
      Boolean,
      15_000,
    );
    stage = "pre-share-quality-controls";
    await evaluate<void>(
      cdp,
      host,
      `document.querySelector('button[aria-controls="host-advanced-door"]')?.click()`,
      Date.now() + 5_000,
    );
    result.preSharePreferenceEnabled = await waitForValue(
      (deadline) => evaluate<boolean>(
        cdp!,
        host,
        `(() => {
          const preference = document.querySelector('button[name="degradationPreference"][value="maintain-resolution"]');
          return Boolean(preference && !preference.disabled);
        })()`,
        deadline,
      ),
      Boolean,
      5_000,
    );
    stage = "pre-share-codec";
    await clickHostControl(cdp, host, `document.querySelector('.lr-sharing-technical > summary')`);
    await clickHostControl(cdp, host,
      `([...document.querySelectorAll('button.lr-chip')].find((button) =>
        button.textContent?.trim() === ${JSON.stringify(requestedCodec.toUpperCase())}))`,
    );
    await evaluate<void>(
      cdp,
      host,
      `document.querySelector('button[aria-controls="host-advanced-door"]')?.click()`,
      Date.now() + 5_000,
    );
    stage = "host-click";
    await evaluate<void>(
      cdp,
      host,
      "document.querySelector('button.lr-tv-big.is-action')?.click()",
      Date.now() + 5_000,
    );
    await selectNativeSource(
      cdp,
      host,
      sourceKind,
      sourceKind === "window" ? SOURCE_TITLE : undefined,
    );
    stage = "host-native-share";
    let hostState: { invite: string | null; native: boolean };
    try {
      hostState = await waitForValue(
        (deadline) => evaluate<{
          invite: string | null;
          native: boolean;
        }>(
          cdp!,
          host,
          "(async () => ({invite: document.querySelector('.lr-invite-url')?.value || null, " +
            "native: (await window.__piikGateVideoCodec()) !== null, " +
            "body: document.body.innerText.slice(0, 500)}))()",
          deadline,
        ),
        (state) => state.invite !== null && state.native,
        40_000,
      );
    } catch (error) {
      const diagnostic = await evaluate<unknown>(
        cdp!,
        host,
        "({buttons: [...document.querySelectorAll('button')].map((button) => ({label: button.getAttribute('aria-label'), text: button.textContent?.slice(0, 120), disabled: button.disabled})), inputs: [...document.querySelectorAll('input')].map((input) => ({className: input.className, type: input.type, disabled: input.disabled}))})",
        Date.now() + 2_000,
      ).catch(() => null);
      throw new Error("native host stage failed: " +
        (error instanceof Error ? error.message : String(error)) +
        " diagnostic=" + JSON.stringify(diagnostic));
    }
    result.hostNativeActive = hostState.native;
    result.hostInvite = hostState.invite !== null;
    stage = "host-codec";
    const actualCodec = await readVideoCodec(cdp, host);
    result.actualCodec = actualCodec;
    if (requestedCodec !== "auto" && actualCodec !== requestedCodec) {
      throw new Error(`Native ${requestedCodec} selection produced ${actualCodec}`);
    }
    if (!hostState.invite) throw new Error("Host did not publish an invitation");
    const inviteURL = new URL(hostState.invite);
    const roomMatch = /^\/r\/([1-9][0-9]{3})$/.exec(inviteURL.pathname);
    const viewerGrant = new URLSearchParams(inviteURL.hash.slice(1)).get("v");
    if (!roomMatch || !viewerGrant) {
      throw new Error("Host invitation is not a room grant");
    }
    if (remote) {
      stage = "remote-viewer";
      const signalUrl = mode === "one-link"
        ? new URL("/signal", appInfo.publicOrigin!).toString().replace(/^http/, "ws")
        : `ws://127.0.0.1:${remote.signalPort}/signal`;
      const signalOrigin = mode === "one-link"
        ? appInfo.publicOrigin!
        : `http://localhost:${appPort}`;
      const remoteResult = await runRemotePeerGate(
        remoteBinary,
        remote,
        signalUrl,
        roomMatch[1],
        viewerGrant,
        signalOrigin,
      );
      result.remoteViewerConnected = remoteResult.passed;
      result.remoteViewerPackets = remoteResult.packets;
      result.remoteLocalCandidateType = remoteResult.localCandidateType;
      result.remoteRemoteCandidateType = remoteResult.remoteCandidateType;
      result.remoteNatPath = [
        remoteResult.localCandidateType,
        remoteResult.remoteCandidateType,
      ].some((value) => value === "srflx" || value === "prflx");
      result.remotePeerExited = true;
      if (!remoteResult.passed || !result.remoteNatPath) {
        throw new Error(remoteResult.error || "remote peer did not use a reflexive ICE path");
      }
    } else {
      const viewerURL = new URL(hostState.invite);
      if (mode === "local") viewerURL.hostname = "localhost";
      else {
        if (viewerURL.protocol !== "https:" || viewerURL.origin !== appInfo.publicOrigin) {
          throw new Error("One-link invitation does not use the actual public origin");
        }
        stage = "public-page-ready";
        await waitForValue(async (deadline) => {
          const response = await fetch(viewerURL, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
          return response.ok;
        }, Boolean, 20_000);
      }
      stage = "viewer-page";
      const viewer = await createPage(cdp, viewerURL.toString(), CODEC_PROBE, true);
      stage = "viewer-media";
      const viewerState = await waitForValue(
        (deadline) => evaluate<{
          frames: number;
          width: number;
          height: number;
          connected: boolean;
        }>(
          cdp!,
          viewer,
          "(() => { const video = document.querySelector('video'); " +
            "if (!video) return {frames:0,width:0,height:0,connected:false}; " +
            "const q=video.getVideoPlaybackQuality(); return {frames:q.totalVideoFrames," +
            "width:video.videoWidth,height:video.videoHeight,connected:video.videoWidth>0&&video.videoHeight>0}; })()",
          deadline,
        ),
        (state) => state.connected && state.frames >= 30 &&
          state.width === 1920 && state.height === 1080,
        40_000,
      );
      result.viewerConnected = viewerState.connected;
      result.viewerFrames = viewerState.frames;
      result.viewerWidth = viewerState.width;
      result.viewerHeight = viewerState.height;
      await assertVideoCodec(cdp, viewer, actualCodec);
      if (mode === "one-link") {
        result.codecPreserved = true;
        result.publicViewerPage = await evaluate<boolean>(cdp, viewer,
          `location.origin === ${JSON.stringify(appInfo.publicOrigin)} && location.pathname === ${JSON.stringify(viewerURL.pathname)}`,
          Date.now() + 5_000);
        result.publicViewerSignal = await evaluate<boolean>(cdp, viewer,
          "window.__piikGatePublicSignal()", Date.now() + 5_000);
      } else {
      await evaluate<boolean>(
        cdp,
        viewer,
        `(() => {
          const video = document.querySelector('video');
          if (!video) return false;
          window.__piikGateMedia = video.srcObject;
          return window.__piikGateMedia !== null;
        })()`,
        Date.now() + 5_000,
      );
      stage = "native-quality-presets";
      await clickHostControl(cdp, host,
        `document.querySelector('button[aria-controls="host-advanced-door"]')`,
      );
      for (const [index, width, height] of [[0, 1280, 720], [1, 1920, 1080]] as const) {
        await clickHostControl(cdp, host, `document.querySelectorAll('button.lr-tile')[${index}]`);
        await waitForValue(
          (deadline) => evaluate<boolean>(
            cdp!,
            viewer,
            `(() => { const video = document.querySelector('video'); return Boolean(
              video && video.videoWidth === ${width} && video.videoHeight === ${height}
            ); })()`,
            deadline,
          ),
          Boolean,
          20_000,
        );
        await assertVideoCodec(cdp, viewer, actualCodec);
        result.livePresetChanges += 1;
      }
      stage = "native-quality-controls";
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          `Boolean(document.querySelector('button.lr-chip[aria-label="1440p"]'))`,
          deadline,
        ),
        Boolean,
        5_000,
      );
      result.qualityControlsEnabled = await evaluate<boolean>(
        cdp,
        host,
        `(() => {
          const resolution = document.querySelector('button.lr-chip[aria-label="1440p"]');
          const preference = document.querySelector('button[name="degradationPreference"][value="maintain-framerate"]');
          const sliders = [...document.querySelectorAll('.lr-slider input[type="range"]')];
          return Boolean(
            resolution && preference && !resolution.disabled && !preference.disabled &&
            sliders.length === 2 && sliders.every((slider) => !slider.disabled)
          );
        })()`,
        Date.now() + 5_000,
      );
      if (!result.qualityControlsEnabled) {
        throw new Error("Native quality controls remained disabled");
      }
      await evaluate<void>(
        cdp,
        host,
        `document.querySelector('button.lr-chip[aria-label="1440p"]')?.click()`,
        Date.now() + 5_000,
      );
      result.liveQualityChanged = await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          viewer,
          `(() => { const video = document.querySelector('video'); return Boolean(
            video && video.videoWidth === 2560 && video.videoHeight === 1440 &&
            video.getVideoPlaybackQuality().totalVideoFrames >= ${viewerState.frames + 10}
          ); })()`,
          deadline,
        ),
        Boolean,
        20_000,
      );
      if (!result.liveQualityChanged) {
        throw new Error("Native quality change did not reach the Viewer");
      }
      result.viewerWidth = 2560;
      result.viewerHeight = 1440;
      await assertVideoCodec(cdp, viewer, actualCodec);
      const framesBeforePreference = await evaluate<number>(
        cdp,
        viewer,
        `document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0`,
        Date.now() + 5_000,
      );
      await evaluate<void>(
        cdp,
        host,
        `document.querySelector('button[name="degradationPreference"][value="maintain-framerate"]')?.click()`,
        Date.now() + 5_000,
      );
      await waitForValue(
        (deadline) => evaluate<number>(
          cdp!,
          viewer,
          `document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0`,
          deadline,
        ),
        (frames) => frames >= framesBeforePreference + 10,
        15_000,
      );
      stage = "native-pause-ready";
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          `Boolean([...document.querySelectorAll('button')].find((candidate) =>
            /^(Pause sharing|暂停分享)$/.test(candidate.getAttribute('aria-label') || '') &&
            !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true'
          ))`,
          deadline,
        ),
        Boolean,
        10_000,
      );
      await evaluate<void>(
        cdp,
        host,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) =>
            /^(Pause sharing|暂停分享)$/.test(candidate.getAttribute('aria-label') || '')
          );
          button?.click();
        })()`,
        Date.now() + 5_000,
      );
      stage = "native-pause-applied";
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          `Boolean([...document.querySelectorAll('button')].find((candidate) =>
            /^(Resume sharing|恢复分享)$/.test(candidate.getAttribute('aria-label') || '')
          ))`,
          deadline,
        ),
        Boolean,
        5_000,
      );
      await evaluate<void>(
        cdp,
        host,
        `document.querySelector('button.lr-chip[aria-label="480p"]')?.click()`,
        Date.now() + 5_000,
      );
      stage = "native-paused-profile";
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          `(() => {
            const resolution = document.querySelector('button.lr-chip[aria-label="480p"]');
            const resume = [...document.querySelectorAll('button')].find((candidate) =>
              /^(Resume sharing|恢复分享)$/.test(candidate.getAttribute('aria-label') || '')
            );
            return Boolean(
              resolution?.getAttribute('aria-pressed') === 'true' && resume &&
              !resume.disabled && resume.getAttribute('aria-disabled') !== 'true'
            );
          })()`,
          deadline,
        ),
        Boolean,
        10_000,
      );
      const framesBeforeResume = await evaluate<number>(
        cdp,
        viewer,
        `document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0`,
        Date.now() + 5_000,
      );
      await evaluate<void>(
        cdp,
        host,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) =>
            /^(Resume sharing|恢复分享)$/.test(candidate.getAttribute('aria-label') || '')
          );
          button?.click();
        })()`,
        Date.now() + 5_000,
      );
      stage = "native-resumed-profile";
      const resumed = await waitForValue(
        (deadline) => evaluate<{
          frames: number;
          width: number;
          height: number;
          sameMedia: boolean;
        }>(
          cdp!,
          viewer,
          `(() => {
            const video = document.querySelector('video');
            return {
              frames: video?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
              width: video?.videoWidth ?? 0,
              height: video?.videoHeight ?? 0,
              sameMedia: Boolean(video && video.srcObject === window.__piikGateMedia),
            };
          })()`,
          deadline,
        ),
        (value) => value.frames >= framesBeforeResume + 10 &&
          value.width === 854 && value.height === 480,
        20_000,
      );
      result.pausedQualityChanged = resumed.width === 854 && resumed.height === 480;
      result.mediaObjectPreserved = resumed.sameMedia;
      result.viewerWidth = resumed.width;
      result.viewerHeight = resumed.height;
      await assertVideoCodec(cdp, viewer, actualCodec);
      if (sourceKind === "window") {
        stage = "native-background-profile";
        const { targetInfos } = await sourceCdp!.call<{
          targetInfos: Array<{ targetId: string; type: string; url: string }>;
        }>("Target.getTargets", {}, undefined, Date.now() + 5_000);
        const target = targetInfos.find((value) =>
          value.type === "page" && value.url === `http://127.0.0.1:${sourcePort}/`,
        );
        if (!target) throw new Error("Capture source page is missing");
        const { windowId } = await sourceCdp!.call<{ windowId: number }>(
          "Browser.getWindowForTarget", { targetId: target.targetId },
          undefined, Date.now() + 5_000,
        );
        await sourceCdp!.call("Browser.setWindowBounds", {
          windowId, bounds: { windowState: "minimized" },
        }, undefined, Date.now() + 5_000);
        try {
          await evaluate<void>(cdp, host,
            `new Promise((resolve) => {
              document.querySelector('button.lr-chip[aria-label="720p"]')?.click();
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            })`,
            Date.now() + 5_000,
          );
          await waitForValue((deadline) => evaluate<boolean>(cdp!, host,
            `Boolean(document.querySelector('#host-advanced-door .lr-sharing-panel[aria-busy="true"]'))`,
            deadline,
          ), Boolean, 5_000);
        } finally {
          await sourceCdp!.call("Browser.setWindowBounds", {
            windowId, bounds: { windowState: "normal" },
          }, undefined, Date.now() + 5_000);
        }
        stage = "native-background-profile-recovery";
        // A quiet source retains its pending replacement until restoration.
        // Prove its actual delivery before applying the following profile.
        for (const [label, width, height] of [["720p", 1280, 720], ["480p", 854, 480]] as const) {
          const before = await evaluate<number>(cdp, viewer,
            `document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0`,
            Date.now() + 5_000,
          );
          await evaluate<void>(cdp, host,
            `document.querySelector('button.lr-chip[aria-label="${label}"]')?.click()`,
            Date.now() + 5_000,
          );
          await waitForValue((deadline) => evaluate<boolean>(cdp!, viewer,
            `(() => {
              const video = document.querySelector('video');
              return Boolean(video && video.srcObject === window.__piikGateMedia &&
                video.videoWidth === ${width} && video.videoHeight === ${height} &&
                video.getVideoPlaybackQuality().totalVideoFrames >= ${before + 10});
            })()`, deadline,
          ), Boolean, 20_000);
          await waitForValue((deadline) => evaluate<boolean>(cdp!, host,
            `Boolean(document.querySelector('#host-advanced-door .lr-sharing-panel[aria-busy="false"]'))`,
            deadline,
          ), Boolean, 5_000);
        }
        result.backgroundProfileRecovery = true;
      }
      stage = "native-source-picker";
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          `Boolean([...document.querySelectorAll('button')].find((candidate) =>
            /^(Switch source|切换来源)$/.test(candidate.getAttribute('aria-label') || '') &&
            !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true'
          ))`,
          deadline,
        ),
        Boolean,
        10_000,
      );
      await evaluate<void>(
        cdp,
        host,
        `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) =>
            /^(Switch source|切换来源)$/.test(candidate.getAttribute('aria-label') || '')
          );
          button?.click();
        })()`,
        Date.now() + 5_000,
      );
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          `Boolean(document.querySelector('[role="dialog"] button[data-native-source]'))`,
          deadline,
        ),
        Boolean,
        10_000,
      );
      const framesBeforeSourceChange = resumed.frames;
      await selectNativeSource(cdp, host, sourceKind,
        sourceKind === "window" ? SOURCE_TITLE : undefined,
      );
      stage = "native-source-replaced";
      result.nativeSourceChanged = await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          viewer,
          `(() => {
            const video = document.querySelector('video');
            return Boolean(
              video && video.srcObject === window.__piikGateMedia &&
              video.videoWidth === 854 && video.videoHeight === 480 &&
              video.getVideoPlaybackQuality().totalVideoFrames >= ${framesBeforeSourceChange + 10}
            );
          })()`,
          deadline,
        ),
        Boolean,
        20_000,
      );
      stage = "native-quality-evidence";
      await assertVideoCodec(cdp, viewer, actualCodec);
      result.codecPreserved = true;
      result.nativeQualityEvidence = await waitForValue(
        async () => {
          const logPath = join(diagnosticDirectory, "client.log");
          if ((await stat(logPath)).size > 8 * 1024 * 1024) {
            throw new Error("Native Host gate diagnostic log exceeded its bound");
          }
          const diagnostics = await readFile(logPath, "utf8");
          return diagnostics.split(/\r?\n/).some((line) => {
            try {
              const record = JSON.parse(line);
              return record.msg === "piik-route" && record.event === "sender-quality-evidence" &&
                (record.state === "healthy" || record.state === "degraded");
            } catch {
              return false;
            }
          });
        },
        Boolean,
        12_000,
      );

      if (crashGate) {
        stage = "app-crash";
        if (!app || !(await stopChild(app))) {
          throw new Error("App did not terminate for crash gate");
        }
        app = null;
        result.appCrashEndedShare = await waitForValue(
          (deadline) => evaluate<boolean>(
            cdp!,
            host,
            "Boolean(document.querySelector('button.lr-tv-big.is-action'))",
            deadline,
          ),
          Boolean,
          5_000,
        );
      } else if (sourceKind === "window") {
      stage = "source-failure";
      if (!sourceChrome || !sourceCdp ||
          !(await closeSourceBrowser(sourceChrome, sourceCdp))) {
        throw new Error("captured source did not close");
      }
      sourceChrome = null;
      sourceCdp = null;
      stage = "host-source-failure";
      result.sourceFailureEndedShare = await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          "Boolean(document.querySelector('button.lr-tv-big.is-action'))",
          deadline,
        ),
        Boolean,
        20_000,
      );
      stage = "source-restart";
      ({ child: sourceChrome, cdp: sourceCdp } = await startSourceBrowser(
        chromePath,
        sourceProfile,
        sourceDebugPort,
        sourcePort,
      ));
      await waitForCaptureWindow(captureBinary);
      stage = "host-restart";
      await evaluate<void>(
        cdp,
        host,
        "document.querySelector('button.lr-tv-big.is-action')?.click()",
        Date.now() + 5_000,
      );
      await selectNativeSource(
        cdp,
        host,
        sourceKind,
        sourceKind === "window" ? SOURCE_TITLE : undefined,
      );
      await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          host,
          "Boolean(document.querySelector('.lr-tv-overlay[role=\"status\"]'))",
          deadline,
        ),
        Boolean,
        40_000,
      );
      stage = "viewer-replacement-media";
      result.replacementViewerConnected = await waitForValue(
        (deadline) => evaluate<boolean>(
          cdp!,
          viewer,
          `(() => {
            const video = document.querySelector('video');
            return Boolean(video && video.srcObject &&
              video.srcObject !== window.__piikGateMedia &&
              video.videoWidth === 854 && video.videoHeight === 480);
          })()`,
          deadline,
        ),
        Boolean,
        40_000,
      );
      result.replacementViewerFrames = await evaluate<number>(
        cdp,
        viewer,
        `new Promise((resolve) => {
          const video = document.querySelector('video');
          let frames = 0;
          const next = () => video.requestVideoFrameCallback(() => {
            frames += 1;
            if (frames >= 30) resolve(frames); else next();
          });
          next();
        })`,
        Date.now() + 10_000,
      );
      } else {
        // A display remains available while the test Browser is open, so this
        // arm does not claim source-end or same-room reselection evidence.
        result.sourceFailureEndedShare = null;
        result.replacementViewerConnected = null;
        result.replacementViewerFrames = null;
      }
      }
    }
  } catch (error) {
    // App stderr can contain implementation diagnostics or URLs; keep gate
    // output independent of credentials and media-path identifiers.
    result.error = error instanceof Error ? error.message : String(error);
    result.stage = stage;
  } finally {
    if (remoteTunnel) {
      result.reverseSignalTunnelClosed = await stopChild(remoteTunnel);
    }
    if (sourceChrome && sourceCdp) {
      await closeSourceBrowser(sourceChrome, sourceCdp);
      sourceChrome = null;
      sourceCdp = null;
    } else if (sourceChrome && sourceChrome.exitCode === null) {
      sourceChrome.kill();
    }
    result.cleanup = await cleanupRun({
      cdp,
      native: app,
      chrome,
      server: source,
      profile,
      ports: [sourcePort, appPort, debugPort, ...(nativePort ? [nativePort] : [])],
    });
    if (sourceProfile) {
      const sourceCleanup = await cleanupRun({
        cdp: null,
        native: sourceChrome,
        chrome: null,
        server: null,
        profile: sourceProfile,
        ports: [sourceDebugPort],
      });
      result.cleanup.profileRemoved =
        result.cleanup.profileRemoved && sourceCleanup.profileRemoved;
      result.cleanup.portsClosed =
        result.cleanup.portsClosed && sourceCleanup.portsClosed;
    }
  }
  result.passed = result.error === null && result.actualCodec !== null && result.preSharePreferenceEnabled &&
    result.hostNativeActive &&
    result.hostInvite &&
    (remote
      ? result.remoteViewerConnected && result.remoteViewerPackets >= 30 &&
        result.remoteNatPath && result.remotePeerExited === true &&
        (mode !== "cross-nat" || result.reverseSignalTunnelClosed === true)
      : mode === "one-link"
        ? result.publicViewerPage && result.publicViewerSignal && result.viewerConnected &&
          result.viewerFrames >= 30 && result.viewerWidth === 1920 && result.viewerHeight === 1080 && result.codecPreserved
        : result.viewerConnected && result.viewerFrames >= 30 &&
        result.qualityControlsEnabled && result.liveQualityChanged &&
        result.backgroundProfileRecovery !== false &&
        result.livePresetChanges === 2 &&
        result.codecPreserved &&
        result.pausedQualityChanged && result.mediaObjectPreserved &&
        result.nativeSourceChanged &&
        result.viewerWidth === 854 && result.viewerHeight === 480 &&
        result.nativeQualityEvidence &&
        (crashGate
          ? result.appCrashEndedShare === true
          : sourceKind === "display" ||
            (result.sourceFailureEndedShare === true &&
              result.replacementViewerConnected === true &&
              (result.replacementViewerFrames ?? 0) >= 30))) &&
    result.cleanup.browserExited && result.cleanup.nativeExited &&
    result.cleanup.serverClosed && result.cleanup.portsClosed &&
    result.cleanup.profileRemoved;
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
