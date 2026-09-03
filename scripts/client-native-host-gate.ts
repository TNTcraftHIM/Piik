import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  reservePort,
  type PageHandle,
  waitForVersion,
  withDeadline,
} from "./browser-gate-harness";
import {
  decodeClientEndpoint,
  type ClientEndpoint as Endpoint,
} from "./client-gate-endpoint";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "client-check");
export const SOURCE_TITLE = "Screener Native Gate Source";

type GateMode = "local" | "cross-nat" | "one-link";

interface GateResult {
  passed: boolean;
  hostNativeActive: boolean;
  hostInvite: boolean;
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
  mode: GateMode;
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
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
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

function remoteOptions(): RemoteGateOptions {
  const host = process.env.SCREENER_REMOTE_HOST?.trim();
  const user = process.env.SCREENER_REMOTE_USER?.trim() || "root";
  const key = process.env.SCREENER_REMOTE_SSH_KEY?.trim();
  const signalPortText = process.env.SCREENER_REMOTE_SIGNAL_PORT?.trim() || "49721";
  const signalPort = Number(signalPortText);
  if (!host || !key || !Number.isInteger(signalPort) || signalPort < 1024 || signalPort > 65_535) {
    throw new Error(
      "SCREENER_REMOTE_HOST, SCREENER_REMOTE_SSH_KEY, and a valid SCREENER_REMOTE_SIGNAL_PORT are required",
    );
  }
  return {
    host,
    user,
    key,
    signalPort,
    bindAddress: process.env.SCREENER_REMOTE_BIND_ADDRESS?.trim() || null,
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
  const ssh = process.env.SCREENER_SSH?.trim() || "ssh";
  const scp = process.env.SCREENER_SCP?.trim() || "scp";
  const destination = `${options.user}@${options.host}`;
  const remotePath = `/tmp/screener-peer-gate-${randomBytes(8).toString("hex")}`;
  const transportOptions = remoteTransportOptions(options);
  try {
    run(scp, [...transportOptions, binary, `${destination}:${remotePath}`]);
    run(ssh, [...transportOptions, destination, "chmod", "700", remotePath]);
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
      run(ssh, [...transportOptions, destination, "rm", "-f", remotePath]);
    } catch {
      // The temporary binary is harmless if an already-closed SSH session
      // prevents cleanup; the gate never places it in the repository.
    }
  }
}

export function powershell(): string {
  return process.env.SCREENER_POWERSHELL?.trim() || join(
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
  const child = spawn(chromePath, [
    "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-logging",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--app=http://127.0.0.1:" + sourcePort + "/",
  ], { stdio: "pipe", windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();
  const version = await waitForVersion(debugPort, child);
  const cdp = await CdpConnection.connect(
    version.webSocketDebuggerUrl,
    Date.now() + 10_000,
  );
  return { child, cdp };
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
    async () => JSON.parse(run(captureBinary, ["--list"])) as Array<{
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

async function readClientEndpoint(
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
            endpoint = decodeClientEndpoint(line);
          } catch {
            // Informational lines are printed after the endpoint.
          }
          const passwordLine = lines.find((entry) => entry.startsWith("Local access password: "));
          const publicOriginLine = lines.find((entry) =>
            entry.startsWith("Public invitation origin: ")
          );
          if (endpoint && passwordLine && (!requirePublicOrigin || publicOriginLine)) {
            child.stdout.off("data", onData);
            resolveEndpoint({
              endpoint,
              password: passwordLine.slice("Local access password: ".length),
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
        rejectEndpoint(new Error("Client exited before readiness (" + String(code) + ")")),
      );
    }),
    Date.now() + 15_000,
  );
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The native Host gate currently requires Windows");
  }
  if (process.env.SCREENER_CLIENT_NATIVE_HOST_GATE !== "true") {
    throw new Error("SCREENER_CLIENT_NATIVE_HOST_GATE=true is required");
  }
  const crossNat = process.env.SCREENER_CLIENT_CROSS_NAT_GATE === "true";
  const linkMedia = process.env.SCREENER_CLIENT_LINK_MEDIA_GATE === "true";
  if (crossNat && linkMedia) {
    throw new Error("Cross-NAT and one-link gate modes are mutually exclusive");
  }
  const mode: GateMode = linkMedia ? "one-link" : crossNat ? "cross-nat" : "local";
  const sourceKind: "window" | "display" =
    process.env.SCREENER_CLIENT_NATIVE_HOST_SOURCE === "display"
      ? "display"
      : "window";
  const remote = mode === "local" ? null : remoteOptions();
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const go = process.env.SCREENER_GO?.trim() || "go";
  const node = process.env.SCREENER_NODE?.trim() || process.execPath;
  const tunnel = process.env.SCREENER_CLOUDFLARED?.trim() || join(
    BUILD_ROOT,
    "cloudflared.exe",
  );
  const profile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  const sourceProfile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  await mkdir(BUILD_ROOT, { recursive: true });
  const sourcePort = await reservePort();
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const sourceDebugPort = await reservePort();
  const clientConfig = join(profile, "client.json");
  const captureBuild = BUILD_ROOT;
  const clientBinary = join(BUILD_ROOT, "screener-client.exe");
  const captureBinary = join(captureBuild, "screener-client-capture.exe");
  const remoteBinary = join(BUILD_ROOT, "screener-peer-gate-linux");
  let source: { close(): Promise<void> } | null = null;
  let client: ChildProcessWithoutNullStreams | null = null;
  let sourceChrome: ChildProcessWithoutNullStreams | null = null;
  let sourceCdp: CdpConnection | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let clientPort = 0;
  let clientDiagnostics = "";
  let remoteTunnel: ChildProcess | null = null;
  let stage = "setup";
  const result: GateResult = {
    passed: false,
    hostNativeActive: false,
    hostInvite: false,
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
    mode,
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
    stage = "application-build";
    run(process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", "npm run build",
    ]);
    stage = "source-server";
    source = await sourceServer(sourcePort);
    stage = "capture-build";
    run(powershell(), [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(ROOT, "native", "client", "platform", "windows", "capture", "build.ps1"),
      "-OutputDirectory", captureBuild,
    ]);
    stage = "client-build";
    run(go, [
      "build", "-trimpath", "-o", clientBinary, "./cmd/screener-client",
    ], join(ROOT, "native", "client"));
    if (remote) {
      stage = "remote-peer-build";
      run(
        go,
        ["build", "-trimpath", "-o", remoteBinary, "./cmd/screener-peer-gate"],
        join(ROOT, "native", "client"),
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
    stage = "client-start";
    client = spawn(clientBinary, [
      mode === "one-link" ? "--link" : "--local",
      ...(mode === "one-link"
        ? ["--tunnel-process", tunnel]
        : []),
      "--capture-process", captureBinary,
      "--node", node,
      "--app", ROOT,
      "--config", clientConfig,
      "--port", String(appPort),
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        NODE_DEBUG: "screener-route",
        PEER_ASSISTED_MEDIA: "true",
        SCREENER_CLIENT_GATE_NO_BROWSER: "true",
        ...(mode === "cross-nat"
          ? {
              STUN_URLS:
                process.env.SCREENER_CLIENT_GATE_STUN_URLS?.trim() ||
                "stun:share.bonfire.icu:3478",
            }
          : {}),
      },
    });
    client.stderr.on("data", (chunk: Buffer) => {
      clientDiagnostics = (clientDiagnostics + chunk.toString()).slice(-262_144);
    });
    stage = "client-ready";
    const clientInfo = await readClientEndpoint(client, mode === "one-link");
    clientPort = clientInfo.endpoint.port;
    if (mode === "cross-nat" && remote) {
      stage = "signaling-tunnel";
      const tunnel = spawn(
        process.env.SCREENER_SSH?.trim() || "ssh",
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
    chrome = spawn(chromePath, [
      "--remote-debugging-port=" + debugPort,
      "--user-data-dir=" + profile,
      "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-logging",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      "about:blank",
    ], { stdio: "pipe", windowsHide: true });
    chrome.stdout.resume();
    chrome.stderr.resume();
    stage = "host-cdp";
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    stage = "host-page";
    const host = await createPage(
      cdp,
      "http://localhost:" + appPort + "/#client-access=" + clientInfo.password +
        "&screener-client=1",
      undefined,
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
          "(() => ({invite: document.querySelector('.lr-invite-url')?.value || null, " +
            "native: Boolean(document.querySelector('.lr-tv-overlay [aria-label]')), " +
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
        ? new URL("/signal", clientInfo.publicOrigin!).toString().replace(/^http/, "ws")
        : `ws://127.0.0.1:${remote.signalPort}/signal`;
      const signalOrigin = mode === "one-link"
        ? clientInfo.publicOrigin!
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
      viewerURL.hostname = "localhost";
      stage = "viewer-page";
      const viewer = await createPage(cdp, viewerURL.toString(), undefined, true);
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
          state.width === 1280 && state.height === 720,
        40_000,
      );
      result.viewerConnected = viewerState.connected;
      result.viewerFrames = viewerState.frames;
      result.viewerWidth = viewerState.width;
      result.viewerHeight = viewerState.height;
      stage = "native-quality-evidence";
      result.nativeQualityEvidence = await waitForValue(
        async () => /"event":"sender-quality-evidence"[^\n]*"state":"(healthy|degraded)"/
          .test(clientDiagnostics),
        Boolean,
        12_000,
      );

      await evaluate<boolean>(
        cdp,
        viewer,
        `(() => {
          const video = document.querySelector('video');
          if (!video) return false;
          window.__screenerGateMedia = video.srcObject;
          return window.__screenerGateMedia !== null;
        })()`,
        Date.now() + 5_000,
      );
      if (sourceKind === "window") {
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
              video.srcObject !== window.__screenerGateMedia &&
              video.videoWidth === 1280 && video.videoHeight === 720);
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
  } catch (error) {
    // Client stderr can contain implementation diagnostics or URLs; keep gate
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
      native: client,
      chrome,
      server: source,
      profile,
      ports: [sourcePort, appPort, debugPort, ...(clientPort ? [clientPort] : [])],
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
  result.passed = result.error === null && result.hostNativeActive &&
    result.hostInvite &&
    (mode !== "local"
      ? result.remoteViewerConnected && result.remoteViewerPackets >= 30 &&
        result.remoteNatPath && result.remotePeerExited === true &&
        (mode !== "cross-nat" || result.reverseSignalTunnelClosed === true)
      : result.viewerConnected && result.viewerFrames >= 30 &&
        result.viewerWidth === 1280 && result.viewerHeight === 720 &&
        result.nativeQualityEvidence &&
        (sourceKind === "display" ||
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
