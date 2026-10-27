import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { cleanupRun, fetchJsonBefore, reservePort, waitForSample } from "./browser-gate-harness";
import { Endpoint } from "./network-lab/endpoint-client";
import type { MediaSample } from "./network-lab/page";
import { checkAppPath, checkContinuity, hasPicture } from "./network-lab/scenarios";

// Real UI/room/transport on loopback. NAT and bandwidth faults remain in the
// namespace laboratory; this gate isolates lifecycle ordering from reachability.
const { values } = parseArgs({ options: { cases: { type: "string" }, repeat: { type: "string", default: "1" },
  negative: { type: "string" }, list: { type: "boolean" } } });
if (values.negative && !["frozen-picture", "cancel"].includes(values.negative)) throw new Error("Unknown negative control");
const cases = [
  { id: "browser-browser", host: false, viewer: false, sfu: false },
  { id: "app-browser", host: true, viewer: false, sfu: false },
  { id: "browser-app", host: false, viewer: true, sfu: false },
  { id: "app-app", host: true, viewer: true, sfu: false },
  { id: "sfu-browser", host: false, viewer: false, sfu: true },
  { id: "fallback-browser", host: false, viewer: false, sfu: false, fallback: true },
  { id: "fallback-app", host: true, viewer: false, sfu: false, fallback: true },
];
const selected = values.cases ? values.cases.split(",").map(id => {
  const item = cases.find(value => value.id === id);
  if (!item) throw new Error(`Unknown lifecycle case: ${id}`);
  return item;
}) : cases;
const repeats = Number(values.repeat);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20 || new Set(selected).size !== selected.length) throw new Error("Invalid repetition or duplicated case");
if (values.list) { process.stdout.write(JSON.stringify(cases, null, 2) + "\n"); process.exit(0); }
if (!process.env.CHROME_PATH) throw new Error("CHROME_PATH is required");
const root = resolve(import.meta.dirname, ".."), suffix = process.platform === "win32" ? ".exe" : "";
const localAddresses = Object.values(networkInterfaces()).flatMap(addresses => addresses?.map(value => value.address) ?? []);
const output = join(root, "build/media-lifecycle", new Date().toISOString().replaceAll(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const binaries = await Promise.all(["server", "app"].map(async name => ({ name,
  sha256: createHash("sha256").update(await readFile(join(root, `build/network-lab/bin/piik-${name}${suffix}`))).digest("hex") })));
await writeFile(join(output, "environment.json"), JSON.stringify({ commit: git("rev-parse", "HEAD"),
  status: git("status", "--short"), platform: process.platform, arch: process.arch, binaries, selected, repeats }, null, 2));
const controller = new AbortController(), signal = controller.signal;
const interrupt = () => controller.abort(new Error("Lifecycle gate cancelled"));
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
// Deliberately do not inherit operator/product settings or credentials.
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
  TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CHROME_PATH: process.env.CHROME_PATH };
const summaries: Array<Record<string, unknown>> = [];
for (let iteration = 0; iteration < repeats && !signal.aborted; iteration++) for (const scenario of selected) {
  if (signal.aborted) break;
  const directory = join(output, `${scenario.id}-${iteration + 1}`); await mkdir(directory);
  const port = await reservePort(), origin = `http://127.0.0.1:${port}`;
  // Distinct approved origins prevent two local Apps from impersonating one
  // another. Namespace trials already isolate their loopback services.
  const viewerOrigin = scenario.host && scenario.viewer ? `http://localhost:${port}` : origin;
  const udp = createSocket("udp4");
  const mediaPort = await new Promise<number>((resolvePort, reject) => {
    udp.once("error", reject); udp.bind(0, "127.0.0.1", () => { const port = udp.address().port; udp.close(() => resolvePort(port)); });
  });
  let serverLog = "";
  const server = spawn(resolve(root, `build/network-lab/bin/piik-server${suffix}`), [], { cwd: directory, stdio: "pipe", windowsHide: true,
    env: { ...env, PIIK_ENV: "development", PIIK_DEBUG: "route", ROOM_DATABASE_PATH: ":memory:",
      LISTEN_HOST: "127.0.0.1", PORT: String(port), PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: [...new Set([origin, viewerOrigin])].join(","),
      PIIK_LOG_DIR: join(directory, "logs"),
      ...((scenario.sfu || scenario.fallback) ? { SFU_LISTEN_HOST: "127.0.0.1", SFU_UDP_PORT: String(mediaPort),
        SFU_PUBLIC_IP: "127.0.0.1", SFU_ONLY: String(scenario.sfu) } : {}) } });
  let serverFailure: Error | undefined;
  server.on("error", error => { serverFailure = error; });
  server.stdout.on("data", data => { serverLog = (serverLog + data).slice(-128_000); });
  server.stderr.on("data", data => { serverLog = (serverLog + data).slice(-128_000); });
  const endpoints: Endpoint[] = [];
  let versions: Array<{ browser: string; app: boolean; appPort: number | null }> = [];
  const result = { scenario: scenario.id, iteration: iteration + 1, passed: false, stage: "startup", error: "",
    versions: [] as typeof versions,
    stages: [] as Array<{ name: string; firstPictureMs: number; firstNewFrameMs?: number; recoveryMs?: number; route: string | null; peer: number }>,
    samples: [] as Array<{ stage: string; host: MediaSample; viewer: MediaSample }>, cleanup: [] as unknown[] };
  const stage = (name: string) => { result.stage = name; process.stdout.write(JSON.stringify({ case: scenario.id, stage: name }) + "\n"); };
  const sample = async () => {
    signal.throwIfAborted();
    const [host, viewer] = await Promise.all(endpoints.map(endpoint => endpoint.call<MediaSample>("sample")));
    result.samples.push({ stage: result.stage, host: host!, viewer: viewer! });
    return { host: host!, viewer: viewer! };
  };
  const media = async (name: string, previousPeer?: number, expectedRoute = scenario.sfu ? "sfu" : "peer",
    recovery?: { baseline: MediaSample; started: number }) => {
    stage(name); const started = performance.now();
    let first: MediaSample | undefined, firstAt = 0;
    let previous = recovery?.baseline, firstNewFrameAt: number | undefined, recoveryError = "No new decoded frame";
    while (performance.now() - started < 40_000) {
      const { viewer } = await sample();
      if (viewer.events.some(event => event.reason === "route-exhausted")) throw new Error("Route exhausted");
      if (hasPicture(viewer) && viewer.route === expectedRoute && viewer.playbackPeerId !== previousPeer) {
        if (!first || first.playbackPeerId !== viewer.playbackPeerId) {
          // Historical decoded counters survive an ICE restart. Recovery begins
          // only after a new frame, then needs a complete continuity window.
          if (!previous || viewer.frames > previous.frames) {
            first = viewer; firstAt = performance.now(); firstNewFrameAt ??= firstAt;
          }
        }
        else if (performance.now() - firstAt >= 3000) {
          try { checkContinuity(first, viewer); }
          catch (error) {
            if (!recovery) throw error;
            recoveryError = error instanceof Error ? error.message : String(error);
            first = undefined; previous = viewer;
            await delay(250, undefined, { signal });
            continue;
          }
          if (viewer.errors.length) throw new Error(`Viewer errors: ${viewer.errors.join("; ")}`);
          const last = result.samples.at(-1)!;
          for (const [index, page] of [last.host, viewer].entries()) {
            const appPort = versions[index]?.appPort;
            if (appPort && !page.controlOrigins.includes(`ws://127.0.0.1:${appPort}`)) throw new Error("Page did not attach its own App");
          }
          if (scenario.host && expectedRoute === "peer") checkAppPath(last.host, "prepare-edge", localAddresses);
          if (scenario.viewer && expectedRoute === "peer") checkAppPath(viewer, "receive-offer", localAddresses);
          result.stages.push({ name, firstPictureMs: firstAt - started,
            ...(recovery ? { firstNewFrameMs: firstNewFrameAt! - recovery.started, recoveryMs: performance.now() - recovery.started } : {}),
            route: viewer.route, peer: viewer.playbackPeerId });
          return viewer;
        }
      } else first = undefined;
      await delay(250, undefined, { signal });
    }
    throw new Error(`No sustained ${expectedRoute} media during ${name}${recovery ? `: ${recoveryError}` : ""}`);
  };
  try {
    await waitForSample(deadline => {
      if (serverFailure) throw serverFailure;
      return fetchJsonBefore<{ status: string }>(`${origin}/healthz`, deadline);
    }, value => value.status === "ok", 15_000);
    for (let index = 0; index < 2; index++) endpoints.push(new Endpoint(null,
      await mkdtemp(join(tmpdir(), "piik-client-media-")), signal, env));
    versions = await Promise.all(endpoints.map((endpoint, index) => endpoint.call<typeof versions[number]>("start", {
      origin: index ? viewerOrigin : origin, app: index ? scenario.viewer : scenario.host,
      loopbackMedia: scenario.sfu || scenario.fallback === true })));
    result.versions = versions;
    await endpoints[0]!.call("navigate", { url: origin + (scenario.host ? "/#piik-client=1" : "/") });
    const share = () => endpoints[0]!.call<string>("share", { sfuOnly: scenario.sfu });
    const invitation = await share();
    if (scenario.fallback) await endpoints[0]!.call("delay-peer-signals", { delayMs: 15000 });
    await endpoints[1]!.call("navigate", { url: invitation.replace(origin, viewerOrigin) + (scenario.viewer ? "&piik-client=1" : "") });
    let received = await media("initial", undefined, scenario.fallback ? "sfu" : undefined);
    if (scenario.fallback) {
      if (!result.samples.some(row => row.host.events.some(event => event.type === "test-signal-delayed"))) throw new Error("Signaling fault was not exercised");
      await endpoints[1]!.call("reset-playback-progress");
      received = await media("direct-continuation", received.playbackPeerId, "peer");
      if (received.playbackProgress.renderedFrames < 30 || received.playbackProgress.maxFrameGapMs > 1500) {
        throw new Error("Working SFU playback stalled during direct continuation");
      }
    }
    if (values.negative === "cancel") {
      stage("cancel-negative-control"); controller.abort(new Error("Lifecycle gate cancelled")); signal.throwIfAborted();
    }
    if (values.negative === "frozen-picture") {
      stage("frozen-negative-control"); await endpoints[0]!.call("freeze-picture");
      await delay(2000, undefined, { signal });
      const frozen = (await sample()).viewer;
      await delay(3000, undefined, { signal });
      checkContinuity(frozen, (await sample()).viewer);
      throw new Error("Frozen source incorrectly passed");
    }
    if (!scenario.host && !scenario.sfu) {
      stage("ice-restart");
      const before = await sample();
      const restartAt = performance.now();
      if (!await endpoints[1]!.call("restart-upstream")) throw new Error("No committed Peer route to restart");
      await waitForSample(sample, row => row.host.events.filter(event => event.type === "restart-request").length >
        before.host.events.filter(event => event.type === "restart-request").length && (!scenario.viewer ||
        row.viewer.controls.filter(command => command.type === "receive-offer").length >
        before.viewer.controls.filter(command => command.type === "receive-offer").length), 10_000);
      const restarted = await media("same-edge-recovered", undefined, undefined,
        { baseline: result.samples.at(-1)!.viewer, started: restartAt });
      if (restarted.playbackPeerId !== received.playbackPeerId) throw new Error("ICE restart replaced the playback connection");
      received = restarted;
    }
    stage("quiet-source"); await endpoints[0]!.call("freeze-picture");
    await delay(6000, undefined, { signal });
    const quiet = await sample();
    if (!quiet.host.sharing || quiet.viewer.playbackPeerId !== received.playbackPeerId) throw new Error("Quiet source retired a healthy route");
    await endpoints[0]!.call("resume-picture");
    const resumed = await media("source-resumed");
    if (resumed.playbackPeerId !== received.playbackPeerId) throw new Error("Source repaint needed a new route");
    stage("stop"); await endpoints[0]!.call("stop");
    await share(); received = await media("reshare", received.playbackPeerId);
    stage("viewer-reload"); await endpoints[1]!.call("reload");
    received = await media("viewer-rejoined");
    stage("host-reload"); await endpoints[0]!.call("reload"); await share();
    received = await media("host-restarted", received.playbackPeerId);
    stage("join-before-share"); await endpoints[0]!.call("stop"); await endpoints[1]!.call("reload");
    await share(); await media("waiting-viewer-resumed");
    if (!scenario.sfu) {
      stage("replace-during-prepare"); await endpoints[0]!.call("stop");
      await endpoints[0]!.call("delay-peer-signals", { delayMs: 8000 });
      await share();
      await waitForSample(sample, row => row.host.events.some(event => event.type === "test-signal-delayed" &&
        event.at > row.host.at - 3000), 10_000);
      await endpoints[0]!.call("stop");
      await endpoints[0]!.call("delay-peer-signals", { delayMs: 0 });
      await share(); received = await media("replacement-active");
      // Release the old real SDP after the new share is active. Stale signaling
      // must neither replace that route nor turn into a terminal page error.
      await delay(8500, undefined, { signal });
      const afterStale = await media("stale-signals-released");
      if (received.playbackPeerId !== afterStale.playbackPeerId) throw new Error("Retired signaling replaced the current route");
    }
    await endpoints[0]!.call("stop"); result.passed = true;
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally {
    await Promise.all(endpoints.map(async (endpoint, index) => {
      await endpoint.call("screenshot", { output: join(directory, `${index}.png`) }, 5000).catch(() => {});
      await writeFile(join(directory, `endpoint-${index}.json`), JSON.stringify(await endpoint.call("logs", {}, 5000).catch(String), null, 2));
      result.cleanup.push(await endpoint.call("close", {}, 30_000).catch(error => ({ error: String(error) })));
    }));
    for (const endpoint of endpoints) result.cleanup.push(await cleanupRun({ chrome: null, native: null, cdp: null,
      server: endpoint.process, profile: endpoint.profile, ports: [] }).catch(error => ({ error: String(error) })));
    result.cleanup.push(await cleanupRun({ chrome: null, native: null, cdp: null, server, profile: null, ports: [port] }));
    if (result.cleanup.some(item => !Object.values(item as object).every(flag => flag === true))) result.passed = false;
    if (signal.aborted) { result.passed = false; result.error = "Cancelled"; }
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
    await writeFile(join(directory, "server.log"), serverLog);
    const { samples: _samples, ...summary } = result; summaries.push(summary);
    process.stdout.write(JSON.stringify(summary) + "\n");
  }
}
process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
await writeFile(join(output, "summary.json"), JSON.stringify(summaries, null, 2));
process.stdout.write(JSON.stringify({ report: output }) + "\n");
if (signal.aborted || summaries.some(result => !result.passed)) process.exitCode = 1;
