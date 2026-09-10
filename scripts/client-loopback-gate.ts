import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  launchChrome,
  waitForVersion,
} from "./browser-gate-harness";
import {
  readClientEndpoint,
  type ClientEndpoint as Endpoint,
} from "./client-gate-endpoint";
import {
  NATIVE_CLIENT_PORT_END,
  NATIVE_CLIENT_PORT_START,
  NATIVE_CLIENT_PROTOCOL,
  NATIVE_CLIENT_SUBPROTOCOL,
} from "../src/client/native/wire";

const PAGE_URL = "https://share.bonfire.icu/";
const NATIVE_PROTOCOL = NATIVE_CLIENT_PROTOCOL;
const NATIVE_SUBPROTOCOL = NATIVE_CLIENT_SUBPROTOCOL;

interface GateReport {
  passed: boolean;
  platform: NodeJS.Platform;
  browser: string | null;
  hostedExpectation: "blocked" | "connected";
  clientStarted: boolean;
  localPageConnected: boolean;
  localPageError: string | null;
  localPageEvents: string[];
  hostedPageConnected: boolean;
  hostedPageError: string | null;
  hostedPageEvents: string[];
  hostedPageBlockedByBrowser: boolean;
  clientExited: boolean;
  browserExited: boolean;
  profileRemoved: boolean;
}

async function browserHandshake(
  cdp: CdpConnection,
  page: { sessionId: string },
  endpoint: Endpoint,
): Promise<{ health: boolean; responses: string[]; error: string | null; events: string[] }> {
  const endpointJSON = JSON.stringify({
    host: "127.0.0.1",
    expectedPort: endpoint.port,
    portStart: NATIVE_CLIENT_PORT_START,
    portEnd: NATIVE_CLIENT_PORT_END,
  });
  return await evaluate(
    cdp,
    page,
    `(() => new Promise((resolve) => {
      const expected = ${endpointJSON};
      const result = { health: false, responses: [], error: null, events: [] };
      const finish = () => resolve(result);
      const discover = async () => {
        for (let port = expected.portStart; port <= expected.portEnd; port += 1) {
          const probeController = new AbortController();
          const probeTimer = setTimeout(() => probeController.abort(), 500);
          try {
            const response = await fetch("http://" + expected.host + ":" + port + "/health", {
              cache: "no-store", signal: probeController.signal, targetAddressSpace: "loopback",
            });
            if (!response.ok) continue;
            const health = await response.json();
            if (health.protocol === ${NATIVE_PROTOCOL} && health.service === "piik-client" &&
                health.port === port && typeof health.instanceToken === "string" &&
                typeof health.nativeMedia?.video === "boolean" &&
                typeof health.nativeMedia?.processAudio === "boolean" &&
                typeof health.nativeMedia?.systemAudio === "boolean" &&
                typeof health.nativeMedia?.hardwareH264 === "boolean") {
              return { port, instanceToken: health.instanceToken };
            }
          } catch {} finally {
            clearTimeout(probeTimer);
          }
        }
        throw new Error("Client not found");
      };
      discover()
        .then((endpoint) => {
          result.health = endpoint.port === expected.expectedPort;
          const socket = new WebSocket(
            "ws://" + expected.host + ":" + endpoint.port + "/control",
            ["${NATIVE_SUBPROTOCOL}." + endpoint.instanceToken],
          );
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            finish();
          };
          const timer = setTimeout(() => { result.events.push("timeout"); result.error = "control timeout"; socket.close(); settle(); }, 8000);
          socket.onopen = () => {
            const expectedProtocol = "${NATIVE_SUBPROTOCOL}." + endpoint.instanceToken;
            result.events.push(socket.protocol === expectedProtocol ? "open" : "protocol-mismatch");
            if (socket.protocol !== expectedProtocol) {
              result.error = "control protocol mismatch";
              socket.close();
              settle();
              return;
            }
            socket.send(JSON.stringify({ version: ${NATIVE_PROTOCOL}, id: "request_hello", type: "hello" }));
          };
          socket.onclose = (event) => { result.events.push("close:" + event.code); if (!settled && !result.error) result.error = "control closed"; settle(); };
          socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            result.events.push("message:" + message.type);
            result.responses.push(message.type);
            if (message.type === "ready") {
              try { socket.send(JSON.stringify({ version: ${NATIVE_PROTOCOL}, id: "request_ping", type: "ping" })); } catch (error) { result.error = String(error?.message || error); settle(); }
            } else if (message.type === "pong") {
              socket.close(1000, "gate complete");
              settle();
            }
          };
          socket.onerror = () => { result.events.push("error"); result.error = "control socket error"; socket.close(); settle(); };
        })
        .catch((error) => { result.error = String(error?.message || error); finish(); });
    }))()`,
    Date.now() + 15_000,
  );
}

async function main(): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("loopback gate requires a desktop platform");
  }
  if (process.env.PIIK_CLIENT_LOOPBACK_GATE !== "true") {
    throw new Error("loopback gate was not explicitly enabled");
  }
  const browserPath = process.env.CHROME_PATH?.trim();
  const clientPath = process.env.PIIK_CLIENT_EXE?.trim();
  if (!browserPath || !clientPath) {
    throw new Error("CHROME_PATH and PIIK_CLIENT_EXE are required");
  }
  const disposableNoSandbox =
    process.env.PIIK_CLIENT_GATE_NO_SANDBOX === "true";
  const grantLoopback =
    process.env.PIIK_CLIENT_GATE_GRANT_LOOPBACK === "true";

  const report: GateReport = {
    passed: false,
    platform: process.platform,
    browser: null,
    hostedExpectation: grantLoopback ? "connected" : "blocked",
    clientStarted: false,
    localPageConnected: false,
    localPageError: null,
    localPageEvents: [],
    hostedPageConnected: false,
    hostedPageError: null,
    hostedPageEvents: [],
    hostedPageBlockedByBrowser: false,
    clientExited: false,
    browserExited: false,
    profileRemoved: false,
  };
  let profile: string | null = null;
  let client: ChildProcessWithoutNullStreams | null = null;
  let browser: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let debugPort = 0;
  try {
    profile = await mkdtemp(join(tmpdir(), "piik-client-loopback-"));
    client = spawn(clientPath, [
      "--site", PAGE_URL,
      "--config", join(profile, "client.json"),
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: "true" },
    });
    client.stderr.resume();
    const endpoint = await readClientEndpoint(client, { timeoutMs: 8_000 });
    report.clientStarted = true;

    const portServer = createServer();
    debugPort = await new Promise<number>((resolvePort, rejectPort) => {
      portServer.once("error", rejectPort);
      portServer.listen(0, "127.0.0.1", () => {
        const address = portServer.address();
        if (!address || typeof address === "string") {
          rejectPort(new Error("debug port reservation failed"));
          return;
        }
        portServer.close((error) => error ? rejectPort(error) : resolvePort(address.port));
      });
    });
    browser = launchChrome(browserPath, debugPort, profile, [
      "--headless=new",
      ...(disposableNoSandbox ? ["--no-sandbox"] : []),
      "--no-first-run",
      "--no-proxy-server",
      "--disable-logging",
    ]);
    browser.stdout.resume();
    browser.stderr.resume();
    const version = await waitForVersion(debugPort, browser);
    report.browser = version.Browser;
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    if (grantLoopback) {
      await cdp.call(
        "Browser.setPermission",
        {
          permission: { name: "loopback-network" },
          setting: "granted",
          origin: PAGE_URL,
        },
        undefined,
        Date.now() + 5_000,
      );
    }

    const localPage = await createPage(cdp, endpoint.url + "/health");
    const localResult = await browserHandshake(cdp, localPage, endpoint);
    report.localPageConnected = localResult.health &&
      localResult.responses.join(",") === "ready,pong";
    report.localPageError = localResult.error;
    report.localPageEvents = localResult.events;

    const hostedPage = await createPage(cdp, PAGE_URL);
    const hostedResult = await browserHandshake(cdp, hostedPage, endpoint);
    report.hostedPageConnected = hostedResult.health &&
      hostedResult.responses.join(",") === "ready,pong";
    report.hostedPageError = hostedResult.error;
    report.hostedPageEvents = hostedResult.events;
    report.hostedPageBlockedByBrowser = !report.hostedPageConnected &&
      hostedResult.error !== null;
  } finally {
    const cleanup = await cleanupRun({
      cdp,
      native: client,
      chrome: browser,
      server: null,
      profile,
      ports: debugPort > 0 ? [debugPort] : [],
    });
    report.browserExited = cleanup.browserExited;
    report.clientExited = cleanup.nativeExited;
    if (profile) {
      report.profileRemoved = cleanup.profileRemoved;
      if (!report.profileRemoved) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        const retry = await cleanupRun({
          cdp: null,
          native: null,
          chrome: null,
          server: null,
          profile,
          ports: [],
        });
        report.profileRemoved = retry.profileRemoved;
      }
    }
  }
  const hostedExpectationMet = grantLoopback
    ? report.hostedPageConnected
    : report.hostedPageBlockedByBrowser;
  report.passed = report.clientStarted && report.localPageConnected &&
    hostedExpectationMet &&
    report.clientExited && report.browserExited && report.profileRemoved;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
