import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
} from "./browser-gate-harness";
import {
  readAppEndpoint,
} from "./app-gate-endpoint";

interface GateReport {
  passed: boolean;
  platform: NodeJS.Platform;
  browser: string | null;
  appStarted: boolean;
  localServerReady: boolean;
  bootstrapAuthenticated: boolean;
  bootstrapRemoved: boolean;
  hostReady: boolean;
  lanInvite: boolean;
  appExited: boolean;
  browserExited: boolean;
  portsClosed: boolean;
  profileRemoved: boolean;
  error: string | null;
}

interface LocalPageState {
  bootstrapPresent: boolean;
  access: { required: boolean; authenticated: boolean } | null;
  hostReady: boolean;
}

const LOCAL_PAGE_STATE = `fetch('/api/site-access')
  .then((response) => response.json())
  .catch(() => null)
  .then((access) => ({
  bootstrapPresent: ['client-access', 'piik-client']
    .some((key) => new URLSearchParams(location.hash.slice(1)).has(key)),
  access,
  hostReady: Boolean(document.querySelector('.lr-host-personal-controls')),
}))`;

async function main(): Promise<void> {
  if (process.env.PIIK_CLIENT_LOCAL_GATE !== "true") {
    throw new Error("Local App gate was not explicitly enabled");
  }
  const browserPath = process.env.CHROME_PATH?.trim();
  const appPath = process.env.PIIK_CLIENT_EXE?.trim();
  const lanAddress = process.env.PIIK_CLIENT_GATE_LAN_ADDRESS?.trim();
  if (!browserPath || !appPath || !lanAddress) {
    throw new Error(
      "CHROME_PATH, PIIK_CLIENT_EXE, and PIIK_CLIENT_GATE_LAN_ADDRESS are required",
    );
  }

  const report: GateReport = {
    passed: false,
    platform: process.platform,
    browser: null,
    appStarted: false,
    localServerReady: false,
    bootstrapAuthenticated: false,
    bootstrapRemoved: false,
    hostReady: false,
    lanInvite: false,
    appExited: false,
    browserExited: false,
    portsClosed: false,
    profileRemoved: false,
    error: null,
  };
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const profile = await mkdtemp(join(tmpdir(), "piik-client-loopback-"));
  const configPath = join(profile, "client.json");
  let app: ChildProcessWithoutNullStreams | null = null;
  let browser: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let loopbackPort = 0;
  try {
    app = spawn(appPath, [
      "--local",
      "--config", configPath,
      "--lan-address", lanAddress,
      "--port", String(appPort),
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: "true" },
    });
    app.stderr.resume();
    const endpoint = await readAppEndpoint(app);
    loopbackPort = endpoint.port;
    report.appStarted = true;
    await waitForSample(
      (deadline) => fetchJsonBefore<{ status: string }>(
        `http://127.0.0.1:${appPort}/healthz`,
        deadline,
      ),
      (health) => health.status === "ok",
      15_000,
    );
    report.localServerReady = true;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      localAccessPassword?: unknown;
    };
    if (typeof config.localAccessPassword !== "string") {
      throw new Error("App access bootstrap is unavailable");
    }
    const localAccessPassword = config.localAccessPassword;
    const bootstrap = new URLSearchParams({
      ...(localAccessPassword ? { "client-access": localAccessPassword } : {}),
      "piik-client": "1",
    }).toString();

    browser = await launchChrome(browserPath, debugPort, profile, [
      "--headless=new",
      ...(process.env.PIIK_CLIENT_GATE_NO_SANDBOX === "true"
        ? ["--no-sandbox"]
        : []),
      "--no-first-run",
      "--no-proxy-server",
      "--disable-logging",
    ]);
    browser.stdout.resume();
    browser.stderr.resume();
    const version = await waitForVersion(debugPort, browser);
    report.browser = version.Browser;
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    const page = await createPage(
      cdp,
      `http://localhost:${appPort}/#${bootstrap}`,
    );
    const readState = (deadline: number) =>
      evaluate<LocalPageState>(cdp!, page, LOCAL_PAGE_STATE, deadline).then((value) => {
        report.bootstrapAuthenticated = value.access?.required === Boolean(localAccessPassword) &&
          value.access.authenticated;
        report.bootstrapRemoved = !value.bootstrapPresent;
        report.hostReady = value.hostReady;
        return value;
      });
    await waitForSample(
      readState,
      (value) => value.access?.authenticated === true &&
        value.hostReady,
      15_000,
    );
    report.lanInvite = await evaluate<boolean>(
      cdp,
      page,
      `fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeEntryPolicy: 'open' }),
      }).then(async (response) => {
        if (!response.ok) return false;
        const room = await response.json();
        return typeof room.inviteUrl === 'string' &&
          room.inviteUrl.startsWith(${JSON.stringify(`http://${lanAddress}:${appPort}/r/`)});
      })`,
      Date.now() + 5_000,
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanup = await cleanupRun({
      cdp,
      native: app,
      chrome: browser,
      server: null,
      profile,
      ports: [appPort, debugPort, ...(loopbackPort ? [loopbackPort] : [])],
    });
    report.appExited = cleanup.nativeExited;
    report.browserExited = cleanup.browserExited;
    report.portsClosed = cleanup.portsClosed;
    report.profileRemoved = cleanup.profileRemoved;
  }
  report.passed = report.appStarted && report.localServerReady &&
    report.bootstrapAuthenticated && report.bootstrapRemoved && report.hostReady &&
    report.lanInvite && report.appExited && report.browserExited &&
    report.portsClosed && report.profileRemoved && report.error === null;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
