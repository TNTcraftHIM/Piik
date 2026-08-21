import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRoomResponseSchema } from "../src/shared/protocol";
import { createScreenerServer, type ScreenerServer } from "../src/server/app";
import type { ServerConfig } from "../src/server/config";
import { CdpConnection, cleanupRun, createPage, evaluate, reservePort, waitForVersion } from "./native-one-viewer-gate";
const root = resolve(import.meta.dirname, "..");
const nginxConfigPath = resolve(root, "deploy/nginx/share.bonfire.icu.conf.example");
const teardownTest = "strongly rotates and revokes every Viewer generation and media edge";
const fragmentProbe = `(() => {
  let domContentLoaded = false;
  const state = { fragmentAtStart: location.hash.length > 0, replaced: false, beforeDomContentLoaded: false };
  document.addEventListener("DOMContentLoaded", () => { domContentLoaded = true; }, { once: true });
  const replaceState = history.replaceState;
  history.replaceState = function(...args) {
    if (location.hash) { state.replaced = true; state.beforeDomContentLoaded = !domContentLoaded; }
    return replaceState.apply(this, args);
  };
  Object.defineProperty(globalThis, "__SCREENER_ACCESS_GATE__", { value: state });
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
  appLogLeakCount: number; sqliteLeakCount: number; leakAuditCompleted: boolean;
  rotateRevokeCasePresent: boolean; cleanupPassed: boolean;
}
interface BrowserAudit {
  fragmentSeenAtDocumentStart: boolean; fragmentReplaceObserved: boolean;
  fragmentClearedBeforeDomContentLoaded: boolean; fragmentCleared: boolean;
  canonicalRoomPath: boolean; roomSessionGrantMatches: number;
  otherSessionGrantMatches: number; localGrantMatches: number;
  cookieGrantMatches: number; resourceGrantMatches: number;
}
function secret(): string { return randomBytes(24).toString("base64url"); }
function leakCount(values: readonly (string | Buffer)[], secrets: readonly string[]): number {
  return values.filter((value) => secrets.some((item) => value.includes(item))).length;
}
function diagnosticText(values: readonly unknown[]): string {
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}:${value.message}`;
    try { return JSON.stringify(value) ?? ""; } catch { return ""; }
  }).join(" ");
}
async function sqliteFiles(profile: string): Promise<Buffer[]> {
  const names = (await readdir(profile)).filter((name) => name.startsWith("rooms.sqlite"));
  return Promise.all(names.map((name) => readFile(join(profile, name))));
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
    nginxConfigSafe: false, appLogLeakCount: 0, sqliteLeakCount: 0,
    leakAuditCompleted: false, rotateRevokeCasePresent: false,
    cleanupPassed: false,
  };
  const chromePath = process.env.CHROME_PATH?.trim() ?? "";
  const sitePassword = secret();
  const roomPassword = secret();
  const requestRecords: string[] = [];
  const nginxLines: string[] = [];
  const appLogs: string[] = [];
  const originalConsoleError = console.error;
  let profile: string | null = null;
  let server: ScreenerServer | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let appPort = 0;
  let debugPort = 0;

  console.error = (...values: unknown[]) => { appLogs.push(diagnosticText(values)); };
  try {
    report.rotateRevokeCasePresent = (await readFile(
      resolve(root, "tests/server-signal.test.ts"), "utf8",
    )).includes(teardownTest);
    await access(chromePath);
    appPort = await reservePort();
    do { debugPort = await reservePort(); } while (debugPort === appPort);
    profile = await mkdtemp(join(tmpdir(), "screener-access-privacy-"));
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const config: ServerConfig = {
      nodeEnv: "production", port: appPort, listenHost: "127.0.0.1",
      publicBaseUrl: new URL(baseUrl), allowedOrigins: new Set([baseUrl]),
      siteAccessPassword: sitePassword, roomDatabasePath: join(profile, "rooms.sqlite"),
      roomTtlMs: 14_400_000, maxRooms: 4, maxViewersPerRoom: 2,
      peerAssistedMedia: false, stunUrls: [],
    };
    server = await createScreenerServer({ config, staticDirectory: resolve(root, "dist/client") });
    server.httpServer.prependListener("request", (request, response) => {
      const target = request.url ?? "";
      const record = `${request.method ?? ""} ${target} ${request.headers.referer ?? ""}`;
      requestRecords.push(record);
      response.once("finish", () => nginxLines.push(`${record} ${response.statusCode}`));
    });
    await server.listen(appPort, "127.0.0.1");
    report.serverReady = true;
    const login = await fetch(`${baseUrl}/api/site-access`, {
      method: "POST", headers: { Authorization: `Bearer ${sitePassword}`, Origin: baseUrl },
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const createdResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl },
      body: JSON.stringify({ viewerPolicy: "private-link" }),
    });
    const room = createRoomResponseSchema.parse(await createdResponse.json());
    const invite = new URL(room.inviteUrl);
    const grant = new URLSearchParams(invite.hash.slice(1)).get("v") ?? "";
    if (!grant) throw new Error("Private room did not return a Viewer grant");
    server.roomStore.connectParticipant({
      roomId: room.roomId, role: "host", token: room.hostToken,
      clientId: "privacy-gate-host", sessionId: "privacy-gate-host-session",
    });
    await server.roomStore.setViewerPassword(room.roomId, roomPassword, "privacy-gate-host-session");
    report.roomPrepared = true;
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      "--headless=new", "--no-first-run", "--disable-extensions",
      "--disable-logging", "about:blank",
    ], { cwd: root, stdio: "pipe", windowsHide: true });
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    report.chromeConnected = true;
    const context = await cdp.call<{ browserContextId: string }>(
      "Target.createBrowserContext", { disposeOnDetach: true }, undefined, Date.now() + 5_000,
    );
    const page = await createPage(cdp, room.inviteUrl, fragmentProbe, true, context.browserContextId);
    report.pageLoaded = true;
    const expected = JSON.stringify({ roomId: room.roomId, grant });
    const audit = await evaluate<BrowserAudit>(cdp, page, `(() => {
        const expected = ${expected};
        const fragment = globalThis.__SCREENER_ACCESS_GATE__;
        const entries = (storage) => Object.keys(storage).map((key) => [key, storage.getItem(key)]);
        const session = entries(sessionStorage); const local = entries(localStorage);
        return {
          fragmentSeenAtDocumentStart: fragment?.fragmentAtStart === true,
          fragmentReplaceObserved: fragment?.replaced === true,
          fragmentClearedBeforeDomContentLoaded: fragment?.beforeDomContentLoaded === true,
          fragmentCleared: location.hash === "",
          canonicalRoomPath: location.pathname === "/r/" + expected.roomId && location.search === "",
          roomSessionGrantMatches: session.filter(([key, value]) => key === "screener:viewer-grant:" + expected.roomId && value === expected.grant).length,
          otherSessionGrantMatches: session.filter(([key, value]) => value?.includes(expected.grant) && key !== "screener:viewer-grant:" + expected.roomId).length,
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
    report.appLogLeakCount = leakCount(appLogs, transportSecrets);
    report.sqliteLeakCount = leakCount(await sqliteFiles(profile), [...transportSecrets, roomPassword]);
    report.leakAuditCompleted = true;
  } catch {
    // The report intentionally exposes no exception text or secret-bearing diagnostics.
  } finally {
    console.error = originalConsoleError;
    const cleanup = await cleanupRun({
      cdp, native: null, chrome, server, profile,
      ports: [appPort, debugPort].filter((port) => port > 0),
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
    report.appLogLeakCount === 0 && report.sqliteLeakCount === 0 &&
    report.rotateRevokeCasePresent && report.cleanupPassed;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
