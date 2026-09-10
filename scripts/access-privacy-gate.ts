import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  SIGNALING_PROTOCOL,
  createRoomResponseSchema,
  decodeServerMessage,
  roomAccessUpdateResponseSchema,
} from "../src/shared/protocol";
import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  fetchJsonBefore,
  launchChrome,
  reservePort,
  waitForSample,
  waitForVersion,
  withDeadline,
} from "./browser-gate-harness";
const root = resolve(import.meta.dirname, "..");
const nginxConfigPath = resolve(root, "deploy/nginx/share.bonfire.icu.conf.example");
const serverExecutable = join(root, "build", "client-check",
  process.platform === "win32" ? "piik-server.exe" : "piik-server");
// PIIK_ENV=production refuses to start without STUN. Nothing listens on
// this address, so the gate still never leaves the loopback interface.
const gateStunUrl = "stun:127.0.0.1:3478";
const hostClientId = "privacy-gate-host";
const serverReadyTimeoutMs = 20_000;
const signalDeadlineMs = 10_000;
const serverStopTimeoutMs = 10_000;
// Hop-by-hop headers the proxy must not forward (RFC 9110 7.6.1); Node frames
// the forwarded body itself.
const hopByHopHeaders = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);
const fragmentProbe = `(() => {
  let domContentLoaded = false;
  const state = { fragmentAtStart: location.hash.length > 0, replaced: false, beforeDomContentLoaded: false };
  document.addEventListener("DOMContentLoaded", () => { domContentLoaded = true; }, { once: true });
  const replaceState = history.replaceState;
  history.replaceState = function(...args) {
    if (location.hash) { state.replaced = true; state.beforeDomContentLoaded = !domContentLoaded; }
    return replaceState.apply(this, args);
  };
  Object.defineProperty(globalThis, "__PIIK_ACCESS_GATE__", { value: state });
})();`;
interface GateReport {
  passed: boolean; serverReady: boolean; roomPrepared: boolean;
  chromeConnected: boolean; pageLoaded: boolean; browserAudited: boolean;
  fragmentSeenAtDocumentStart: boolean; fragmentReplaceObserved: boolean;
  fragmentClearedBeforeDomContentLoaded: boolean; fragmentCleared: boolean;
  canonicalRoomPath: boolean; roomSessionGrantMatches: number;
  otherSessionGrantMatches: number; localGrantMatches: number;
  cookieGrantMatches: number; resourceGrantMatches: number;
  requestLeakCount: number; nginxLogLeakCount: number; nginxConfigSafe: boolean;
  appLogLeakCount: number; persistentRoomFileCount: number; leakAuditCompleted: boolean;
  cleanupPassed: boolean;
}
interface BrowserAudit {
  fragmentSeenAtDocumentStart: boolean; fragmentReplaceObserved: boolean;
  fragmentClearedBeforeDomContentLoaded: boolean; fragmentCleared: boolean;
  canonicalRoomPath: boolean; roomSessionGrantMatches: number;
  otherSessionGrantMatches: number; localGrantMatches: number;
  cookieGrantMatches: number; resourceGrantMatches: number;
}
// An observer records the request line and returns the sink for its status.
type RequestObserver = (request: IncomingMessage) => (status: number) => void;
function secret(): string { return randomBytes(24).toString("base64url"); }
function leakCount(values: readonly (string | Buffer)[], secrets: readonly string[]): number {
  return values.filter((value) => secrets.some((item) => value.includes(item))).length;
}
// The profile is also the server's working directory, so a room database the
// gate never configured would land here.
async function persistentRoomFiles(profile: string): Promise<string[]> {
  return (await readdir(profile)).filter((name) => name.startsWith("rooms.sqlite"));
}
async function reserveDistinctPorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < count) {
    const port = await reservePort();
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}
function buildServer(): void {
  const go = process.env.PIIK_GO?.trim() || "go";
  const result = spawnSync(go, ["build", "-trimpath", "-o", serverExecutable, "./cmd/piik-server"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("piik-server build failed");
}
function forwardedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHopHeaders.has(name)),
  );
}
function requestPreamble(request: IncomingMessage): string {
  const lines = [`${request.method} ${request.url} HTTP/1.1`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}
function upgradeStatus(chunk: Buffer): number {
  const statusLine = chunk.toString("latin1", 0, Math.min(chunk.length, 32));
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  return match ? Number(match[1]) : 0;
}
// startProxy stands in for the nginx reverse proxy the deployment runs in
// front of the server (deploy/nginx/share.bonfire.icu.conf.example). It
// observes every request line the browser and the gate emit, which is what the
// in-process httpServer.prependListener("request") hook used to do, and it is
// the only origin the browser ever sees.
// ponytail: the upgrade pipes ignore backpressure; gate traffic is a handful of
// signaling frames. Use stream.pipe with drain handling if that ever changes.
function startProxy(port: number, upstreamPort: number, observe: RequestObserver): Promise<Server> {
  const proxy = createServer((request, response) => {
    const finish = observe(request);
    response.once("finish", () => finish(response.statusCode));
    const upstream = httpRequest({
      host: "127.0.0.1", port: upstreamPort, method: request.method,
      path: request.url, headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, forwardedHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("upgrade", (request, clientSocket, head) => {
    const finish = observe(request);
    const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
    const destroy = () => { clientSocket.destroy(); upstream.destroy(); };
    let statusRecorded = false;
    upstream.on("connect", () => {
      upstream.write(requestPreamble(request));
      if (head.length > 0) upstream.write(head);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!statusRecorded) { statusRecorded = true; finish(upgradeStatus(chunk)); }
      clientSocket.write(chunk);
    });
    clientSocket.on("data", (chunk: Buffer) => upstream.write(chunk));
    for (const socket of [clientSocket, upstream]) {
      socket.on("error", destroy);
      socket.on("close", destroy);
    }
  });
  return new Promise((resolveProxy, rejectProxy) => {
    proxy.once("error", rejectProxy);
    proxy.listen(port, "127.0.0.1", () => resolveProxy(proxy));
  });
}
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  child.kill();
  await withDeadline(() => closed, Date.now() + serverStopTimeoutMs);
}
async function closeProxy(proxy: Server | null): Promise<void> {
  if (!proxy) return;
  proxy.closeAllConnections();
  await new Promise<void>((resolveClosed) => proxy.close(() => resolveClosed()));
}
// authenticateHost replaces the in-process roomStore.connectParticipant call:
// the room needs a connected Host, and out of process the only way to get one
// is the handshake tests/server-signal.test.ts drives over /signal.
async function authenticateHost(
  webSocketUrl: string, origin: string, cookie: string, roomId: string, hostToken: string,
): Promise<WebSocket> {
  const socket = new WebSocket(webSocketUrl, { origin, headers: { Cookie: cookie } });
  const deadline = Date.now() + signalDeadlineMs;
  await withDeadline(() => new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  }), deadline);
  const authenticated = new Promise<void>((resolveAuth, rejectAuth) => {
    socket.on("error", rejectAuth);
    socket.once("close", () => rejectAuth(new Error("Host signaling closed before authenticating")));
    socket.on("message", (data) => {
      try {
        if (decodeServerMessage(data.toString()).type === "authenticated") resolveAuth();
      } catch (error) {
        rejectAuth(error instanceof Error ? error : new Error("Unreadable server message"));
      }
    });
  });
  socket.send(JSON.stringify({
    type: "authenticate", protocol: SIGNALING_PROTOCOL, roomId,
    role: "host", token: hostToken, clientId: hostClientId,
  }));
  try {
    await withDeadline(() => authenticated, deadline);
  } catch (error) {
    socket.terminate();
    throw error;
  }
  // The Host session lives until the server stops; a late transport error must
  // not surface as an unhandled event.
  socket.on("error", () => {});
  return socket;
}
async function main(): Promise<void> {
  const report: GateReport = {
    passed: false, serverReady: false, roomPrepared: false,
    chromeConnected: false, pageLoaded: false, browserAudited: false,
    fragmentSeenAtDocumentStart: false, fragmentReplaceObserved: false,
    fragmentClearedBeforeDomContentLoaded: false, fragmentCleared: false,
    canonicalRoomPath: false, roomSessionGrantMatches: 0,
    otherSessionGrantMatches: 0, localGrantMatches: 0, cookieGrantMatches: 0,
    resourceGrantMatches: 0, requestLeakCount: 0, nginxLogLeakCount: 0,
    nginxConfigSafe: false, appLogLeakCount: 0, persistentRoomFileCount: 0,
    leakAuditCompleted: false, cleanupPassed: false,
  };
  const chromePath = process.env.CHROME_PATH?.trim() ?? "";
  const sitePassword = secret();
  const roomPassword = secret();
  const requestRecords: string[] = [];
  const nginxLines: string[] = [];
  const appLogs: string[] = [];
  let profile: string | null = null;
  let server: { close(): Promise<void> } | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let proxyPort = 0;
  let serverPort = 0;
  let debugPort = 0;

  try {
    await access(chromePath);
    [proxyPort, serverPort, debugPort] = await reserveDistinctPorts(3);
    profile = await mkdtemp(join(tmpdir(), "piik-access-privacy-"));
    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    await mkdir(dirname(serverExecutable), { recursive: true });
    buildServer();
    let proxy: Server | null = null;
    let hostSocket: WebSocket | null = null;
    const child = spawn(serverExecutable, [], {
      // The working directory decides where .env is read and where an
      // unconfigured room database would be written; the empty profile keeps
      // both the developer's environment and the repository out of the run.
      cwd: profile, stdio: "pipe", windowsHide: true,
      // An explicit environment: config.Load fails closed on a removed
      // variable, so nothing from the developer's shell may reach the server.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        PIIK_ENV: "production",
        ROOM_DATABASE_PATH: ":memory:",
        PORT: String(serverPort),
        LISTEN_HOST: "127.0.0.1",
        // Production requires an https public origin. The browser reaches the
        // same host and port over plain HTTP through the observing proxy, so
        // only the scheme of the invite URL is rewritten before navigating.
        PUBLIC_BASE_URL: `https://127.0.0.1:${proxyPort}`,
        ALLOWED_ORIGINS: baseUrl,
        SITE_ACCESS_PASSWORD: sitePassword,
        MAX_VIEWERS_PER_ROOM: "2",
        ENDPOINT_MEDIA_COPY_CAPACITY: "2",
        STUN_URLS: gateStunUrl,
      },
    });
    child.stdout.on("data", (chunk: Buffer) => appLogs.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => appLogs.push(chunk.toString()));
    server = {
      async close() {
        hostSocket?.terminate();
        await stopChild(child);
        await closeProxy(proxy);
      },
    };
    proxy = await startProxy(proxyPort, serverPort, (request) => {
      // The fields the in-process request listener recorded, plus whether a
      // Cookie travelled at all: the audit must see credential-bearing
      // requests without ever storing a credential.
      const record = `${request.method ?? ""} ${request.url ?? ""} ` +
        `${request.headers.referer ?? ""} ${request.headers.cookie ? "cookie" : "no-cookie"}`;
      requestRecords.push(record);
      return (status) => nginxLines.push(`${record} ${status}`);
    });
    await waitForSample(
      (deadline) => fetchJsonBefore<{ status: string }>(
        `http://127.0.0.1:${serverPort}/healthz`, deadline),
      (health) => health.status === "ok",
      serverReadyTimeoutMs,
    );
    report.serverReady = true;
    const login = await fetch(`${baseUrl}/api/site-access`, {
      method: "POST", headers: { Authorization: `Bearer ${sitePassword}`, Origin: baseUrl },
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const createdResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl },
      body: JSON.stringify({ codeEntryPolicy: "open" }),
    });
    const room = createRoomResponseSchema.parse(await createdResponse.json());
    const invite = new URL(room.inviteUrl);
    const grant = new URLSearchParams(invite.hash.slice(1)).get("v") ?? "";
    if (!grant) throw new Error("Room creation did not return a Viewer grant");
    invite.protocol = "http:";
    hostSocket = await authenticateHost(
      `ws://127.0.0.1:${proxyPort}/signal`, baseUrl, cookie, room.roomId, room.hostToken);
    const accessResponse = await fetch(`${baseUrl}/api/rooms/${room.roomId}/access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${room.hostToken}`, "Content-Type": "application/json",
        Cookie: cookie, Origin: baseUrl,
      },
      body: JSON.stringify({ action: "set-viewer-password", password: roomPassword }),
    });
    const accessUpdate = roomAccessUpdateResponseSchema.parse(await accessResponse.json());
    if (accessUpdate.type !== "viewer-password-updated" || !accessUpdate.enabled) {
      throw new Error("Room preparation did not enable the Viewer password");
    }
    report.roomPrepared = true;
    chrome = launchChrome(chromePath, debugPort, profile, [
      "--headless=new", "--no-first-run", "--disable-extensions",
      "--disable-logging",
    ], { cwd: root });
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    report.chromeConnected = true;
    const context = await cdp.call<{ browserContextId: string }>(
      "Target.createBrowserContext", { disposeOnDetach: true }, undefined, Date.now() + 5_000,
    );
    const page = await createPage(cdp, invite.toString(), fragmentProbe, true, context.browserContextId);
    report.pageLoaded = true;
    const expected = JSON.stringify({ roomId: room.roomId, grant });
    const audit = await evaluate<BrowserAudit>(cdp, page, `(() => {
        const expected = ${expected};
        const fragment = globalThis.__PIIK_ACCESS_GATE__;
        const entries = (storage) => Object.keys(storage).map((key) => [key, storage.getItem(key)]);
        const session = entries(sessionStorage); const local = entries(localStorage);
        return {
          fragmentSeenAtDocumentStart: fragment?.fragmentAtStart === true,
          fragmentReplaceObserved: fragment?.replaced === true,
          fragmentClearedBeforeDomContentLoaded: fragment?.beforeDomContentLoaded === true,
          fragmentCleared: location.hash === "",
          canonicalRoomPath: location.pathname === "/r/" + expected.roomId && location.search === "",
          roomSessionGrantMatches: session.filter(([key, value]) => key === "piik:viewer-grant:" + expected.roomId && value === expected.grant).length,
          otherSessionGrantMatches: session.filter(([key, value]) => value?.includes(expected.grant) && key !== "piik:viewer-grant:" + expected.roomId).length,
          localGrantMatches: local.filter(([, value]) => value && value.includes(expected.grant)).length,
          resourceGrantMatches: performance.getEntriesByType("resource").filter((entry) => entry.name.includes(expected.grant)).length,
        };
      })()`, Date.now() + 5_000);
    const cookies = await cdp.call<{ cookies: { name: string; value: string }[] }>(
      "Storage.getCookies", { browserContextId: context.browserContextId }, undefined, Date.now() + 5_000);
    audit.cookieGrantMatches = leakCount(cookies.cookies.map(({ name, value }) => `${name}=${value}`), [grant]);
    Object.assign(report, audit, { browserAudited: true });
    await cdp.call("Target.disposeBrowserContext", { browserContextId: context.browserContextId },
      undefined, Date.now() + 5_000);

    await server.close();
    server = null;
    const transportSecrets = [sitePassword, grant];
    const nginxConfig = await readFile(nginxConfigPath, "utf8");
    report.requestLeakCount = leakCount(requestRecords, transportSecrets);
    report.nginxLogLeakCount = leakCount(nginxLines, transportSecrets);
    report.nginxConfigSafe = !/\$(?:http_authorization|request_body)(?:\b|_)/.test(nginxConfig);
    report.appLogLeakCount = leakCount(appLogs, [...transportSecrets, roomPassword]);
    report.persistentRoomFileCount = (await persistentRoomFiles(profile)).length;
    report.leakAuditCompleted = true;
  } catch {
    // The report intentionally exposes no exception text or secret-bearing diagnostics.
  } finally {
    const cleanup = await cleanupRun({
      cdp, native: null, chrome, server, profile,
      ports: [proxyPort, serverPort, debugPort].filter((port) => port > 0),
    });
    report.cleanupPassed = Object.values(cleanup).every(Boolean);
  }

  report.passed = report.browserAudited && report.fragmentSeenAtDocumentStart &&
    report.fragmentReplaceObserved && report.fragmentClearedBeforeDomContentLoaded &&
    report.fragmentCleared &&
    report.canonicalRoomPath && report.roomSessionGrantMatches === 1 &&
    report.otherSessionGrantMatches === 0 && report.localGrantMatches === 0 &&
    report.cookieGrantMatches === 0 && report.resourceGrantMatches === 0 &&
    report.leakAuditCompleted && report.requestLeakCount === 0 &&
    report.nginxLogLeakCount === 0 && report.nginxConfigSafe &&
    report.appLogLeakCount === 0 && report.persistentRoomFileCount === 0 &&
    report.cleanupPassed;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
