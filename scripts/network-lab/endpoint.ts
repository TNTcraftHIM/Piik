import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CdpConnection, cleanupRun, createPage, evaluate, fetchJsonBefore, launchChrome, reservePort, waitForSample,
  waitForVersion, type PageHandle } from "../browser-gate-harness";
import { readAppEndpoint } from "../app-gate-endpoint";
import { pageProbe, type MediaSample } from "./page";
import { filteringProbe, preparePeerProbe, udpProbe } from "./udp";

export async function endpointWorker(): Promise<void> {
  let chrome: ChildProcessWithoutNullStreams | null = null, app: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null, page: PageHandle | null = null;
  const profile = process.env.PIIK_NETWORK_LAB_PROFILE;
  if (!profile) throw new Error("Parent-owned browser profile is required");
  const ports: number[] = [];
  let rendezvous: Awaited<ReturnType<typeof preparePeerProbe>> | null = null;
  const logs: Record<string, string> = {};
  const log = (name: string, data: Buffer) => { logs[name] = ((logs[name] ?? "") + data).slice(-64_000); };
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    rendezvous?.close();
    return cleanupRun({ chrome, native: app, cdp, server: null, profile, ports });
  };
  const sample = () => evaluate<MediaSample>(cdp!, page!, "networkLab.sample()", Date.now() + 5000);
  const click = async (selector: string) => {
    await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
      `(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.disabled&&node.getAttribute('aria-disabled')!=='true';})()`, deadline), Boolean, 10_000);
    await evaluate(cdp!, page!, `document.querySelector(${JSON.stringify(selector)}).click()`, Date.now() + 5000);
  };
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line) as { id: number; action: string; origin?: string; app?: boolean; loopbackMedia?: boolean;
        url?: string; output?: string; delayMs?: number; load?: boolean; ipv6?: boolean; prediction?: boolean; sfuOnly?: boolean; peer?: { address: string; port: number } };
      try {
        let result: unknown;
        if (request.action === "probe") {
          result = await udpProbe(request.load === true, request.ipv6 === true);
        } else if (request.action === "filter-probe") {
          result = await filteringProbe();
        } else if (request.action === "peer-prepare") {
          rendezvous?.close(); rendezvous = await preparePeerProbe(); result = rendezvous.mapping;
        } else if (request.action === "peer-probe") {
          if (!rendezvous) throw new Error("Survey must precede peer probing");
          result = await rendezvous.run(request.peer!);
        } else if (request.action === "start") {
          const origin = new URL(request.origin!).origin;
          await waitForSample(deadline => fetchJsonBefore<{ status: string }>(`${origin}/healthz`, deadline),
            value => value.status === "ok", 10_000);
          if (request.app) {
            app = spawn(resolve(`build/network-lab/bin/piik-app${process.platform === "win32" ? ".exe" : ""}`), ["--site", origin, "--debug", "--config", join(profile, "app.json")],
              { stdio: "pipe", windowsHide: true, env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: "true", PIIK_LOG_DIR: join(profile, "logs") } });
            app.stderr.on("data", data => log("app", data));
            await once(app, "spawn");
            ports.push((await readAppEndpoint(app)).port); app.stdout.resume();
          }
          const debugPort = await reservePort(); ports.push(debugPort);
          chrome = await launchChrome(process.env.CHROME_PATH!, debugPort, profile, [
            "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
            "--no-proxy-server", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
            // The lifecycle SFU binds only loopback; namespace trials keep ordinary ICE interfaces.
            ...(request.loopbackMedia ? ["--allow-loopback-in-peer-connection"] : []),
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
            `--unsafely-treat-insecure-origin-as-secure=${origin}`,
          ]);
          chrome.stdout.resume(); chrome.stderr.on("data", data => log("browser", data));
          const version = await waitForVersion(debugPort, chrome);
          cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
          await cdp.call("Browser.setPermission", { origin, permission: { name: "loopback-network" }, setting: "granted" }, undefined, Date.now() + 5000);
          result = { browser: version.Browser, app: request.app === true, appPort: request.app ? ports[0] : null };
        } else if (request.action === "navigate") {
          if (page) {
            const oldTimeOrigin = await evaluate<number>(cdp!, page!, "performance.timeOrigin", Date.now() + 5000);
            const navigation = await cdp!.call<{ loaderId?: string; errorText?: string }>("Page.navigate", { url: request.url! }, page.sessionId, Date.now() + 5000);
            if (navigation.errorText) throw new Error(navigation.errorText);
            await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
              `${navigation.loaderId ? `performance.timeOrigin !== ${oldTimeOrigin} && ` : ""}document.readyState === 'complete' && Boolean(window.networkLab)`, deadline), Boolean, 10_000);
          } else page = await createPage(cdp!, request.url!, pageProbe);
          result = true;
        } else if (request.action === "reload") {
          const oldTimeOrigin = await evaluate<number>(cdp!, page!, "performance.timeOrigin", Date.now() + 5000);
          await cdp!.call("Page.reload", {}, page!.sessionId, Date.now() + 5000);
          await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
            `performance.timeOrigin !== ${oldTimeOrigin} && document.readyState === 'complete' && Boolean(window.networkLab)`, deadline), Boolean, 10_000);
          result = true;
        } else if (request.action === "share") {
          const advanced = 'button[aria-controls="host-advanced-door"]';
          await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
            `Boolean(document.querySelector(${JSON.stringify(advanced)}))`, deadline), Boolean, 10_000);
          if (await evaluate<boolean>(cdp!, page!, `document.querySelector(${JSON.stringify(advanced)}).getAttribute('aria-expanded') !== 'true'`, Date.now() + 5000)) await click(advanced);
          if (request.sfuOnly) {
            if (request.prediction) throw new Error("SFU-only cannot request NAT enhancement");
            await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
              `Boolean(document.querySelector('button[role="switch"][aria-label^="Server media"][aria-disabled="true"][aria-checked="true"]'))`, deadline), Boolean, 10_000);
          }
          // Browser-to-App encoded fanout is the production H264 path. VP8
          // deliberately stays in the Browser and must not masquerade as App WAN.
          await click(app ? 'button[aria-label^="H264"]' : 'button[aria-label^="VP8"]');
          await click('button[aria-label="720p"]');
          await click("button.lr-tv-big.is-action");
          // Selecting Browser before App discovery completes intentionally uses
          // Browser fanout. An App scenario waits for the real control session.
          if (app) await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
            `Boolean(document.querySelector('.lr-source-picker-refresh:not(:disabled)')) && networkLab.sample().then(value => value.controlOpen)`,
            deadline), Boolean, 10_000);
          await click('button[data-source-tab="browser"]');
          await click('button.lr-source-option[aria-label="Choose what to share"]');
          await waitForSample(sample, value => value.sharing && value.width > 0 &&
            (request.prediction === undefined || value.natPrediction === request.prediction), 30_000);
          result = await evaluate<string>(cdp!, page!, "document.querySelector('.lr-invite-url').value", Date.now() + 5000);
        } else if (request.action === "sample") {
          result = await sample();
        } else if (request.action === "delay-peer-signals") {
          if (!Number.isInteger(request.delayMs) || request.delayMs! < 0 || request.delayMs! > 30_000) throw new Error("Invalid signal delay");
          await evaluate(cdp!, page!, `networkLab.delayPeerSignals(${request.delayMs})`, Date.now() + 5000);
          result = true;
        } else if (request.action === "reset-playback-progress") {
          await evaluate(cdp!, page!, "networkLab.resetPlaybackProgress()", Date.now() + 5000);
          result = true;
        } else if (request.action === "restart-upstream") {
          result = await evaluate(cdp!, page!, "networkLab.restartUpstream()", Date.now() + 5000);
        } else if (request.action === "freeze-picture") {
          result = await evaluate(cdp!, page!, "networkLab.freezeCapture()", Date.now() + 5000);
        } else if (request.action === "resume-picture") {
          result = await evaluate(cdp!, page!, "networkLab.resumeCapture()", Date.now() + 5000);
        } else if (request.action === "signal-probe") {
          result = await evaluate(cdp!, page!, "networkLab.signalProbe()", Date.now() + 5000);
        } else if (request.action === "logs") {
          if (app) logs.app = await readFile(join(profile, "logs", "client.log"), "utf8")
            .then(text => text.slice(-64_000), error => String(error));
          result = logs;
        } else if (request.action === "stop") {
          await click('button[aria-label="Stop sharing"]'); result = true;
        } else if (request.action === "voice-open" || request.action === "voice-join") {
          await click('button[aria-label="Interact"]');
          await click('[role="tab"][id$="-voice-tab"]');
          await click(`button[aria-label="${request.action === "voice-open" ? "Open room voice" : "Join voice"}"]`);
          await waitForSample(deadline => evaluate<boolean>(cdp!, page!,
            `Boolean(document.querySelector('button[aria-label="Microphone"][aria-pressed="false"]'))`, deadline), Boolean, 10_000);
          await click('button[aria-label="Microphone"][aria-pressed="false"]'); result = true;
        } else if (request.action === "voice-sample") {
          result = await evaluate(cdp!, page!, "networkLab.voiceSample()", Date.now() + 5000);
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
