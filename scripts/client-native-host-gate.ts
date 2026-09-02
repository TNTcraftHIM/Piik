import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  reservePort,
  waitForVersion,
  withDeadline,
} from "./browser-gate-harness";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_TITLE = "Screener Native Gate Source";

interface Endpoint {
  url: string;
  host: string;
  port: number;
  instanceToken: string;
}

interface GateResult {
  passed: boolean;
  hostNativeActive: boolean;
  hostInvite: boolean;
  viewerConnected: boolean;
  viewerFrames: number;
  viewerWidth: number;
  viewerHeight: number;
  remoteViewerConnected: boolean;
  remoteViewerPackets: number;
  remoteLocalCandidateType: string;
  remoteRemoteCandidateType: string;
  remoteNatPath: boolean;
  remotePeerExited: boolean;
  remoteTunnelClosed: boolean;
  crossNat: boolean;
  cleanup: Awaited<ReturnType<typeof cleanupRun>>;
  error: string | null;
  stage?: string;
}

interface RemoteGateOptions {
  host: string;
  user: string;
  key: string;
  signalPort: number;
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
  return { host, user, key, signalPort };
}

async function runRemotePeerGate(
  binary: string,
  options: RemoteGateOptions,
  roomId: string,
  viewerGrant: string,
  origin: string,
): Promise<RemoteGateResult> {
  const ssh = process.env.SCREENER_SSH?.trim() || "ssh";
  const scp = process.env.SCREENER_SCP?.trim() || "scp";
  const destination = `${options.user}@${options.host}`;
  const remotePath = `/tmp/screener-peer-gate-${randomBytes(8).toString("hex")}`;
  const transportOptions = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-i", options.key,
  ];
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
      signalUrl: `ws://127.0.0.1:${options.signalPort}/signal`,
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

function powershell(): string {
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

async function sourceServer(port: number): Promise<{ close(): Promise<void> }> {
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

async function readClientEndpoint(child: ChildProcessWithoutNullStreams): Promise<{
  endpoint: Endpoint;
  password: string;
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
            const value = JSON.parse(line) as Partial<Endpoint>;
            if (typeof value.url === "string" && typeof value.port === "number" &&
                typeof value.instanceToken === "string") {
              endpoint = value as Endpoint;
            }
          } catch {
            // Informational lines are printed after the endpoint.
          }
          const passwordLine = lines.find((entry) => entry.startsWith("Local access password: "));
          if (endpoint && passwordLine) {
            child.stdout.off("data", onData);
            resolveEndpoint({
              endpoint,
              password: passwordLine.slice("Local access password: ".length),
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
  const remote = crossNat ? remoteOptions() : null;
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const go = process.env.SCREENER_GO?.trim() || "go";
  const node = process.env.SCREENER_NODE?.trim() || process.execPath;
  const profile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  const sourceProfile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  const sourcePort = await reservePort();
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const clientConfig = join(profile, "client.json");
  const captureBuild = join(profile, "capture");
  const clientBinary = join(profile, "screener-client.exe");
  const captureBinary = join(captureBuild, "screener-client-capture.exe");
  const remoteBinary = join(profile, "screener-peer-gate-linux");
  let source: { close(): Promise<void> } | null = null;
  let client: ChildProcessWithoutNullStreams | null = null;
  let sourceChrome: ChildProcessWithoutNullStreams | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let clientPort = 0;
  let remoteTunnel: ChildProcess | null = null;
  let stage = "setup";
  const result: GateResult = {
    passed: false,
    hostNativeActive: false,
    hostInvite: false,
    viewerConnected: false,
    viewerFrames: 0,
    viewerWidth: 0,
    viewerHeight: 0,
    remoteViewerConnected: false,
    remoteViewerPackets: 0,
    remoteLocalCandidateType: "",
    remoteRemoteCandidateType: "",
    remoteNatPath: false,
    remotePeerExited: !crossNat,
    remoteTunnelClosed: !crossNat,
    crossNat,
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
    if (crossNat) {
      stage = "remote-peer-build";
      run(
        go,
        ["build", "-trimpath", "-o", remoteBinary, "./cmd/screener-peer-gate"],
        join(ROOT, "native", "client"),
        { ...process.env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
      );
    }
    stage = "source-browser";
    sourceChrome = spawn(chromePath, [
      "--user-data-dir=" + sourceProfile,
      "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-logging",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--app=http://127.0.0.1:" + sourcePort + "/",
    ], { stdio: "pipe", windowsHide: true });
    sourceChrome.stdout.resume();
    sourceChrome.stderr.resume();
    stage = "client-start";
    client = spawn(clientBinary, [
      "--local", "--native",
      "--capture-process", captureBinary,
      "--node", node,
      "--app", ROOT,
      "--config", clientConfig,
      "--port", String(appPort),
      "--native-window-title", SOURCE_TITLE,
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        PEER_ASSISTED_MEDIA: "true",
        SCREENER_CLIENT_GATE_NO_BROWSER: "true",
        ...(crossNat
          ? {
              STUN_URLS:
                process.env.SCREENER_CLIENT_GATE_STUN_URLS?.trim() ||
                "stun:share.bonfire.icu:3478",
            }
          : {}),
      },
    });
    client.stderr.resume();
    stage = "client-ready";
    const clientInfo = await readClientEndpoint(client);
    clientPort = clientInfo.endpoint.port;
    if (crossNat && remote) {
      stage = "signaling-tunnel";
      const tunnel = spawn(
        process.env.SCREENER_SSH?.trim() || "ssh",
        [
          "-N", "-T",
          "-o", "BatchMode=yes",
          "-o", "StrictHostKeyChecking=yes",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "ConnectTimeout=10",
          "-i", remote.key,
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
      "http://localhost:" + appPort + "/?screener-native=1&screener-native-window=" +
        encodeURIComponent(SOURCE_TITLE) + "#client-access=" + clientInfo.password,
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
        "({body: document.body.innerText.slice(0, 1000), buttons: [...document.querySelectorAll('button')].map((button) => ({label: button.getAttribute('aria-label'), text: button.textContent, disabled: button.disabled})), invites: [...document.querySelectorAll('input')].map((input) => ({className: input.className, value: input.value}))})",
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
    if (crossNat && remote) {
      stage = "remote-viewer";
      const remoteResult = await runRemotePeerGate(
        remoteBinary,
        remote,
        roomMatch[1],
        viewerGrant,
        `http://localhost:${appPort}`,
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
    }
  } catch (error) {
    // Client stderr can contain implementation diagnostics or URLs; keep gate
    // output independent of credentials and media-path identifiers.
    result.error = error instanceof Error ? error.message : String(error);
    result.stage = stage;
  } finally {
    result.remotePeerExited = result.remotePeerExited || !crossNat;
    if (remoteTunnel) {
      result.remoteTunnelClosed = await stopChild(remoteTunnel);
    }
    result.cleanup = await cleanupRun({
      cdp,
      native: client,
      chrome,
      server: source,
      profile,
      ports: [sourcePort, appPort, debugPort, ...(clientPort ? [clientPort] : [])],
    });
    if (sourceChrome && sourceChrome.exitCode === null) {
      sourceChrome.kill();
    }
    if (sourceProfile) {
      await cleanupRun({
        cdp: null,
        native: sourceChrome,
        chrome: null,
        server: null,
        profile: sourceProfile,
        ports: [sourcePort],
      });
    }
  }
  result.passed = result.error === null && result.hostNativeActive &&
    result.hostInvite &&
    (crossNat
      ? result.remoteViewerConnected && result.remoteViewerPackets >= 30 &&
        result.remoteNatPath && result.remotePeerExited && result.remoteTunnelClosed
      : result.viewerConnected && result.viewerFrames >= 30 &&
        result.viewerWidth === 1280 && result.viewerHeight === 720) &&
    result.cleanup.browserExited && result.cleanup.nativeExited &&
    result.cleanup.serverClosed && result.cleanup.portsClosed &&
    result.cleanup.profileRemoved;
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.passed) process.exitCode = 1;
}

await main();
