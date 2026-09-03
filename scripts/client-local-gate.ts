import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  fetchJsonBefore,
  reservePort,
  waitForSample,
  waitForVersion,
  withDeadline,
} from "./browser-gate-harness";
import {
  decodeClientEndpoint,
  type ClientEndpoint as Endpoint,
} from "./client-gate-endpoint";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface GateReport {
  passed: boolean;
  platform: NodeJS.Platform;
  browser: string | null;
  clientStarted: boolean;
  localServerReady: boolean;
  bootstrapAuthenticated: boolean;
  bootstrapRemoved: boolean;
  hostReady: boolean;
  lanInvite: boolean;
  clientExited: boolean;
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
  bootstrapPresent: location.hash.startsWith('#client-access='),
  access,
  hostReady: Boolean(document.querySelector('.lr-host-personal-controls')),
}))`;

async function readEndpoint(
  client: ChildProcessWithoutNullStreams,
): Promise<Endpoint> {
  let buffered = "";
  return withDeadline(
    () => new Promise<Endpoint>((resolveEndpoint, rejectEndpoint) => {
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString();
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        client.stdout.off("data", onData);
        try {
          resolveEndpoint(decodeClientEndpoint(buffered.slice(0, newline)));
        } catch (error) {
          rejectEndpoint(error);
        }
      };
      client.stdout.on("data", onData);
      client.once("error", rejectEndpoint);
      client.once("exit", (code) =>
        rejectEndpoint(new Error(`Client exited before readiness (${code ?? "signal"})`)),
      );
    }),
    Date.now() + 10_000,
  );
}

async function main(): Promise<void> {
  if (process.env.SCREENER_CLIENT_LOCAL_GATE !== "true") {
    throw new Error("Local Client gate was not explicitly enabled");
  }
  const browserPath = process.env.CHROME_PATH?.trim();
  const clientPath = process.env.SCREENER_CLIENT_EXE?.trim();
  const nodePath = process.env.SCREENER_CLIENT_NODE?.trim();
  const appDirectory = process.env.SCREENER_CLIENT_APP?.trim() || ROOT;
  const lanAddress = process.env.SCREENER_CLIENT_GATE_LAN_ADDRESS?.trim();
  if (!browserPath || !clientPath || !nodePath || !lanAddress) {
    throw new Error(
      "CHROME_PATH, SCREENER_CLIENT_EXE, SCREENER_CLIENT_NODE, and SCREENER_CLIENT_GATE_LAN_ADDRESS are required",
    );
  }

  const report: GateReport = {
    passed: false,
    platform: process.platform,
    browser: null,
    clientStarted: false,
    localServerReady: false,
    bootstrapAuthenticated: false,
    bootstrapRemoved: false,
    hostReady: false,
    lanInvite: false,
    clientExited: false,
    browserExited: false,
    portsClosed: false,
    profileRemoved: false,
    error: null,
  };
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const profile = await mkdtemp(join(tmpdir(), "screener-client-loopback-"));
  const configPath = join(profile, "client.json");
  let client: ChildProcessWithoutNullStreams | null = null;
  let browser: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let loopbackPort = 0;
  try {
    client = spawn(clientPath, [
      "--node", nodePath,
      "--app", appDirectory,
      "--config", configPath,
      "--lan-address", lanAddress,
      "--port", String(appPort),
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, SCREENER_CLIENT_GATE_NO_BROWSER: "true" },
    });
    client.stderr.resume();
    const endpoint = await readEndpoint(client);
    loopbackPort = endpoint.port;
    report.clientStarted = true;
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
      throw new Error("Client access bootstrap is unavailable");
    }

    browser = spawn(browserPath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      ...(process.env.SCREENER_CLIENT_GATE_NO_SANDBOX === "true"
        ? ["--no-sandbox"]
        : []),
      "--no-first-run",
      "--no-proxy-server",
      "--disable-logging",
      "about:blank",
    ], { stdio: "pipe", windowsHide: true });
    browser.stdout.resume();
    browser.stderr.resume();
    const version = await waitForVersion(debugPort, browser);
    report.browser = version.Browser;
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    const page = await createPage(
      cdp,
      `http://localhost:${appPort}/#client-access=${config.localAccessPassword}`,
    );
    const readState = (deadline: number) =>
      evaluate<LocalPageState>(cdp!, page, LOCAL_PAGE_STATE, deadline).then((value) => {
        report.bootstrapAuthenticated = value.access?.required === true &&
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
      native: client,
      chrome: browser,
      server: null,
      profile,
      ports: [appPort, debugPort, ...(loopbackPort ? [loopbackPort] : [])],
    });
    report.clientExited = cleanup.nativeExited;
    report.browserExited = cleanup.browserExited;
    report.portsClosed = cleanup.portsClosed;
    report.profileRemoved = cleanup.profileRemoved;
  }
  report.passed = report.clientStarted && report.localServerReady &&
    report.bootstrapAuthenticated && report.bootstrapRemoved && report.hostReady &&
    report.lanInvite && report.clientExited && report.browserExited &&
    report.portsClosed && report.profileRemoved && report.error === null;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
