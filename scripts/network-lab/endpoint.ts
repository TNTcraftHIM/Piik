import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CdpConnection, cleanupRun, createPage, evaluate, fetchJsonBefore, launchChrome, reservePort, waitForSample,
  waitForVersion, type PageHandle } from "../browser-gate-harness";
import { readAppEndpoint } from "../app-gate-endpoint";
import { pageProbe, type MediaSample } from "./page";
import { udpProbe } from "./udp";

export async function endpointWorker(): Promise<void> {
  let chrome: ChildProcessWithoutNullStreams | null = null, app: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null, page: PageHandle | null = null;
  const profile = process.env.PIIK_NETWORK_LAB_PROFILE;
  if (!profile) throw new Error("Parent-owned browser profile is required");
  const ports: number[] = [];
  const logs: Record<string, string> = {};
  const log = (name: string, data: Buffer) => { logs[name] = ((logs[name] ?? "") + data).slice(-64_000); };
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    return cleanupRun({ chrome, native: app, cdp, server: null, profile, ports });
  };
  const sample = () => evaluate<MediaSample>(cdp!, page!, "networkLab.sample()", Date.now() + 5000);
  const click = async (selector: string) => {
    await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`, deadline), Boolean, 10_000);
    await evaluate(cdp!, page!, `document.querySelector(${JSON.stringify(selector)}).click()`, Date.now() + 5000);
  };
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line) as { id: number; action: string; origin?: string; app?: boolean;
        url?: string; output?: string; load?: boolean };
      try {
        let result: unknown;
        if (request.action === "probe") {
          result = await udpProbe(request.load === true);
        } else if (request.action === "start") {
          const origin = new URL(request.origin!).origin;
          await waitForSample(deadline => fetchJsonBefore<{ status: string }>(`${origin}/healthz`, deadline),
            value => value.status === "ok", 10_000);
          if (request.app) {
            app = spawn(resolve("build/network-lab/bin/piik-app"), ["--site", origin, "--config", join(profile, "app.json")],
              { stdio: "pipe", env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: "true", PIIK_LOG_DIR: join(profile, "logs") } });
            app.stderr.on("data", data => log("app", data));
            await once(app, "spawn");
            ports.push((await readAppEndpoint(app)).port); app.stdout.resume();
          }
          const debugPort = await reservePort(); ports.push(debugPort);
          chrome = await launchChrome(process.env.CHROME_PATH!, debugPort, profile, [
            "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
            "--no-proxy-server", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
            `--unsafely-treat-insecure-origin-as-secure=${origin}`,
          ]);
          chrome.stdout.resume(); chrome.stderr.on("data", data => log("browser", data));
          const version = await waitForVersion(debugPort, chrome);
          cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
          await cdp.call("Browser.setPermission", { origin, permission: { name: "loopback-network" }, setting: "granted" }, undefined, Date.now() + 5000);
          result = { browser: version.Browser, app: request.app === true };
        } else if (request.action === "navigate") {
          page = await createPage(cdp!, request.url!, pageProbe);
          result = true;
        } else if (request.action === "share") {
          await click('button[aria-controls="host-advanced-door"]');
          await click('button[aria-label^="VP8"]');
          await click('button[aria-label="720p"]');
          await click("button.lr-tv-big.is-action");
          await click('button[data-source-tab="browser"]');
          await click(".lr-source-option.is-browser");
          await waitForSample(sample, value => value.sharing && value.width > 0, 30_000);
          result = await evaluate<string>(cdp!, page!, "document.querySelector('.lr-invite-url').value", Date.now() + 5000);
        } else if (request.action === "sample") {
          result = await sample();
        } else if (request.action === "signal-probe") {
          result = await evaluate(cdp!, page!, "networkLab.signalProbe()", Date.now() + 5000);
        } else if (request.action === "logs") {
          result = logs;
        } else if (request.action === "stop") {
          await click('button[aria-label="Stop sharing"]'); result = true;
        } else if (request.action === "screenshot") {
          const shot = await cdp!.call<{ data: string }>("Page.captureScreenshot", { format: "png" }, page!.sessionId, Date.now() + 5000);
          await writeFile(request.output!, Buffer.from(shot.data, "base64")); result = true;
        } else if (request.action === "close") {
          result = await cleanup();
        } else throw new Error("Unknown endpoint action");
        process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
        if (closed) break;
      } catch (error) {
        process.stdout.write(JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) }) + "\n");
      }
    }
  } finally { await cleanup(); }
}
