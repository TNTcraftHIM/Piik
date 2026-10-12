import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupRun, withDeadline } from "./browser-gate-harness";
import { endpointWorker } from "./network-lab/endpoint";
import { command, LabNetwork, SITE_IP, SITE_ORIGIN } from "./network-lab/network";
import { checkCalibration, checkContinuity, checkFaultHit, hasPicture, selectScenarios, type Scenario } from "./network-lab/scenarios";
import { echoWorker, type ProbeResult } from "./network-lab/udp";
import type { MediaSample } from "./network-lab/page";
import { checkMediaFeedback, readPacketFlows } from "./network-lab/packets";

const ROOT = resolve(import.meta.dirname, ".."), ENTRY = resolve(import.meta.filename);
const { values } = parseArgs({ options: { worker: { type: "string" }, suite: { type: "string", default: "smoke" },
  cases: { type: "string" }, repeat: { type: "string", default: "1" }, seed: { type: "string", default: "1" }, list: { type: "boolean" } } });

class Endpoint {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly process: ChildProcessWithoutNullStreams;
  constructor(namespace: string, readonly profile: string, private readonly signal: AbortSignal) {
    this.process = spawn("ip", ["netns", "exec", namespace, process.execPath, "--import", "tsx", ENTRY, "--worker", "endpoint"],
      { cwd: ROOT, env: { ...labEnvironment(), PIIK_NETWORK_LAB_PROFILE: profile }, stdio: "pipe" });
    this.process.stderr.on("data", data => process.stderr.write(data));
    createInterface({ input: this.process.stdout }).on("line", line => {
      try {
        const reply = JSON.parse(line), pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.result);
      } catch { this.fail(new Error("Invalid endpoint response")); }
    });
    this.process.on("error", error => this.fail(error));
    this.process.on("exit", (code, signal) => this.fail(new Error(`Endpoint exited (${code ?? signal})`)));
  }
  private fail(error: Error): void { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  async call<T>(action: string, args: Record<string, unknown> = {}, timeout = 45_000): Promise<T> {
    const id = ++this.id;
    const observeAbort = !["close", "logs", "screenshot"].includes(action);
    if (observeAbort) this.signal.throwIfAborted();
    const abort = () => this.pending.get(id)?.reject(new Error("Laboratory run cancelled"));
    try {
      return await withDeadline(() => new Promise<T>((resolveCall, reject) => {
        this.pending.set(id, { resolve: value => resolveCall(value as T), reject });
        if (observeAbort) this.signal.addEventListener("abort", abort, { once: true });
        this.process.stdin.write(JSON.stringify({ id, action, ...args }) + "\n", error => {
          if (error) { this.pending.delete(id); reject(error); }
        });
      }), Date.now() + timeout);
    } finally { this.pending.delete(id); this.signal.removeEventListener("abort", abort); }
  }
}

function labEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, CHROME_PATH: process.env.CHROME_PATH, LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR };
}

async function runCase(scenario: Scenario, seed: number, output: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const network = new LabNetwork(), samples: Array<{ elapsedMs: number; host: MediaSample; viewer: MediaSample }> = [];
  const started = performance.now(), endpoints: Endpoint[] = [];
  let server: ChildProcessWithoutNullStreams | null = null, echo: ChildProcessWithoutNullStreams | null = null;
  let capture: ChildProcessWithoutNullStreams | null = null;
  let serverLog = "", captureLog = "";
  const pcapPath = join(output, "wan.pcap");
  const result: Record<string, unknown> = { scenario, seed, passed: false, stage: "setup", samples };
  try {
    signal.throwIfAborted();
    network.setup([scenario.nat, scenario.nat]);
    echo = spawn("ip", ["netns", "exec", network.wan, process.execPath, "--import", "tsx", ENTRY, "--worker", "echo"],
      { cwd: ROOT, env: labEnvironment(), stdio: "pipe" });
    echo.stderr.on("data", data => process.stderr.write(data));
    await withDeadline(() => once(echo!.stdout, "data"), Date.now() + 10_000);
    for (let i = 0; i < 2; i++) endpoints.push(new Endpoint(network.endpoint(i),
      await mkdtemp(join(tmpdir(), "piik-client-media-")), signal));
    result.stage = "calibration";
    const before = await endpoints[0]!.call<ProbeResult>("probe");
    network.setFault(0, scenario.fault, seed);
    const after = await endpoints[0]!.call<ProbeResult>("probe", { load: ["rate", "loss"].includes(scenario.fault) });
    checkCalibration(before, after, scenario.fault);
    result.calibration = { before, after }; result.initialCounters = network.counters(0);
    // Load probes are calibration traffic, never competing with measured media.
    if (scenario.duringShare) network.setFault(0, "none", seed);
    result.stage = "startup";
    server = spawn("ip", ["netns", "exec", network.wan, resolve("build/network-lab/bin/piik-server")], {
      cwd: output, stdio: "pipe", env: { ...labEnvironment(), PIIK_ENV: "development", ROOM_DATABASE_PATH: ":memory:",
        LISTEN_HOST: SITE_IP, PORT: "9000", PUBLIC_BASE_URL: SITE_ORIGIN, ALLOWED_ORIGINS: SITE_ORIGIN,
        STUN_URLS: `stun:${SITE_IP}:3478,stun:${SITE_IP}:3479,stun:${SITE_IP}:3480`, STUN_LISTEN_HOST: SITE_IP,
        NAT_PREDICTION_ENABLED: "true", ...(scenario.sfu ? { SFU_UDP_PORT: "7882", SFU_LISTEN_HOST: SITE_IP, SFU_PUBLIC_IP: SITE_IP } : {}) },
    });
    server.stdout.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
    server.stderr.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
    await once(server, "spawn");
    result.versions = await Promise.all(endpoints.map((endpoint, index) => endpoint.call("start", {
      origin: SITE_ORIGIN, app: (index === 0 ? scenario.host : scenario.viewer) === "app",
    })));
    capture = spawn("ip", ["netns", "exec", network.wan, "tcpdump", "-i", "internet", "-n", "-s", "96", "-U",
      "-w", pcapPath, "-c", "100000", "udp"], { stdio: "pipe" });
    capture.stderr.on("data", data => { captureLog = (captureLog + data).slice(-4000); });
    await withDeadline(async () => { while (!captureLog.includes("listening on")) {
      if (capture!.exitCode !== null) throw new Error(`Packet capture failed: ${captureLog}`);
      await delay(50, undefined, { signal });
    } }, Date.now() + 5000);
    result.stage = "share";
    await endpoints[0]!.call("navigate", { url: SITE_ORIGIN + (scenario.host === "app" ? "/#piik-client=1" : "/") });
    const invitation = await endpoints[0]!.call<string>("share");
    const joinedAt = performance.now();
    await endpoints[1]!.call("navigate", { url: invitation + (scenario.viewer === "app" ? "&piik-client=1" : "") });
    result.stage = "first-picture";
    let connected = false, exhausted = false;
    while (performance.now() - joinedAt < 110_000) {
      signal.throwIfAborted();
      const host = await endpoints[0]!.call<MediaSample>("sample"), viewer = await endpoints[1]!.call<MediaSample>("sample");
      samples.push({ elapsedMs: performance.now() - started, host, viewer });
      connected = hasPicture(viewer); exhausted = viewer.events.some(event => event.reason === "route-exhausted");
      if (connected || exhausted) break;
      await delay(500, undefined, { signal });
    }
    result.firstPictureMs = connected ? performance.now() - joinedAt : null;
    result.outcome = connected ? "media" : exhausted ? "unavailable" : "timeout";
    if (result.outcome !== scenario.expected) throw new Error(`Expected ${scenario.expected}, observed ${result.outcome}; ${serverLog.slice(-1000)}`);
    if (connected) {
      result.stage = "continuity";
      const first = samples.at(-1)!.viewer;
      await delay(3000, undefined, { signal });
      const next = await endpoints[1]!.call<MediaSample>("sample");
      samples.push({ elapsedMs: performance.now() - started, host: await endpoints[0]!.call("sample"), viewer: next });
      checkContinuity(first, next);
      if (scenario.sfu && next.route !== "sfu") throw new Error("Expected SFU route, but media used another path");
      if (scenario.host === "app") checkAppPath(samples.at(-1)!.host, "prepare-edge");
      if (scenario.viewer === "app") checkAppPath(next, "receive-offer");
      if (scenario.duringShare) {
        result.stage = "impairment";
        network.setFault(0, scenario.fault, seed);
        const impairedAt = performance.now();
        if (scenario.fault === "signaling" && await endpoints[0]!.call("signal-probe")) throw new Error("Signaling remained reachable during blackhole");
        while (performance.now() - impairedAt < 8000) {
          signal.throwIfAborted();
          samples.push({ elapsedMs: performance.now() - started, host: await endpoints[0]!.call("sample"), viewer: await endpoints[1]!.call("sample") });
          await delay(500, undefined, { signal });
        }
        result.impairedCounters = network.counters(0);
        checkFaultHit(scenario.fault, network.counters(0).faultDrops);
        if (scenario.fault === "signaling") checkContinuity(next, samples.at(-1)!.viewer);
        network.setFault(0, "none", seed);
        result.stage = "recovery";
        const restoredAt = performance.now(); let recovered = false;
        while (performance.now() - restoredAt < 60_000) {
          signal.throwIfAborted();
          const previous = samples.at(-1)!.viewer;
          await delay(1000, undefined, { signal });
          const viewer = await endpoints[1]!.call<MediaSample>("sample");
          samples.push({ elapsedMs: performance.now() - started, host: await endpoints[0]!.call("sample"), viewer });
          if (hasPicture(viewer) && viewer.frames - previous.frames >= 15) { recovered = true; break; }
        }
        result.recoveryMs = recovered ? performance.now() - restoredAt : null;
        if (!recovered) throw new Error("Media did not resume within the recovery observation window");
        if (scenario.fault === "signaling" && !await endpoints[0]!.call("signal-probe")) throw new Error("Signaling roundtrip did not recover");
      }
    }
    await endpoints[1]!.call("screenshot", { output: join(output, "viewer.png") });
    result.finalCounters = network.counters(0);
    if (!scenario.duringShare) checkFaultHit(scenario.fault, network.counters(0).faultDrops);
    await endpoints[0]!.call("stop");
    signal.throwIfAborted();
    result.passed = true; result.stage = "done";
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally {
    try {
      result.logs = await Promise.all(endpoints.map(endpoint => endpoint.call("logs", {}, 5000).catch(String)));
      if (!result.passed) await Promise.all(endpoints.map((endpoint, index) =>
        endpoint.call("screenshot", { output: join(output, `failure-${index}.png`) }, 5000).catch(() => {})));
      result.endpointCleanup = await Promise.all(endpoints.map(endpoint => endpoint.call("close", {}, 30_000).catch(error => ({ error: String(error) }))));
      echo?.stdin.end();
      if (capture && capture.exitCode !== null) { result.captureError = "Capture ended before observation completed"; result.passed = false; }
      result.serviceCleanup = await Promise.all([echo, server, capture].map(child => cleanupRun({
        chrome: null, native: null, cdp: null, server: child, profile: null, ports: [],
      })));
      result.cleanup = await network.close();
      // If a worker died, the parent still owns its profile and removes it only
      // after namespace processes have stopped, using the same guarded cleanup.
      result.profileCleanup = await Promise.all(endpoints.map(async endpoint => {
        if (!await access(endpoint.profile).then(() => true, () => false)) return true;
        return (await cleanupRun({ chrome: null, native: null, cdp: null, server: null,
          profile: endpoint.profile, ports: [] })).profileRemoved;
      }));
      if (![...(result.endpointCleanup as object[]), ...(result.serviceCleanup as object[]), result.cleanup as object]
        .every(value => Object.values(value).every(flag => flag === true)) ||
        !(result.profileCleanup as boolean[]).every(Boolean)) result.passed = false;
    } catch (error) { result.cleanupError = String(error); result.passed = false; }
    // Parsing or assertion failures must never skip process/network cleanup.
    if (capture) try {
      const flows = await readPacketFlows(pcapPath); result.packetFlows = flows;
      if (!captureLog.includes("0 packets dropped by kernel")) throw new Error(`Capture loss prevents a complete observation: ${captureLog}`);
      if (result.outcome === "media") {
        if (scenario.sfu) { checkMediaFeedback(flows, network.publicIP(0), SITE_IP); checkMediaFeedback(flows, SITE_IP, network.publicIP(1)); }
        else checkMediaFeedback(flows, network.publicIP(0), network.publicIP(1));
      }
    } catch (error) { result.captureError = String(error); result.passed = false; }
    if (signal.aborted) { result.cancelled = true; result.passed = false; }
    await writeFile(join(output, "server.log"), serverLog);
    await writeFile(join(output, "capture.log"), captureLog);
    result.durationMs = performance.now() - started;
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}

function checkAppPath(sample: MediaSample, action: "prepare-edge" | "receive-offer"): void {
  const connected = sample.controls.some(control => control.type === action && control.connectionId &&
    sample.events.some(event => event.scope === "app" && event.type === "edge-state" &&
      event.connectionId === control.connectionId && event.state === "connected"));
  if (!sample.controlOpen || !connected) throw new Error(`Missing successful App ${action} path`);
}

async function main(): Promise<void> {
  const selected = selectScenarios(values.suite!, values.cases);
  if (values.list) { process.stdout.write(JSON.stringify(selected, null, 2) + "\n"); return; }
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Network lab requires an isolated Linux runner and root for owned namespaces");
  if (!process.env.CHROME_PATH) throw new Error("CHROME_PATH is required");
  const repeat = Number(values.repeat), seed = Number(values.seed);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20 || !Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) throw new Error("Invalid repeat (1..20) or seed (uint32)");
  for (const tool of ["ip", "tc", "nft", "sysctl", "tcpdump"]) command("which", [tool]);
  const output = resolve("build/network-lab/results", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  await mkdir(output, { recursive: true });
  const identity = { revision: command("git", ["rev-parse", "HEAD"]), kernel: command("uname", ["-a"]),
    node: process.version, iproute: command("ip", ["-Version"]), nftables: command("nft", ["--version"]), selected, repeat, seed };
  await writeFile(join(output, "environment.json"), JSON.stringify(identity, null, 2) + "\n");
  const results: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Laboratory run cancelled"));
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  for (let iteration = 0; iteration < repeat; iteration++) for (const scenario of selected) {
    if (controller.signal.aborted) break;
    const directory = join(output, `${scenario.id}-${iteration + 1}`); await mkdir(directory);
    process.stdout.write(JSON.stringify({ starting: scenario.id, iteration: iteration + 1 }) + "\n");
    const result = await runCase(scenario, seed + iteration, directory, controller.signal); results.push(result);
    process.stdout.write(JSON.stringify({ case: scenario.id, passed: result.passed, stage: result.stage, error: result.error }) + "\n");
  }
  process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
  await writeFile(join(output, "summary.json"), JSON.stringify(results.map(({ samples: _samples, ...result }) => result), null, 2) + "\n");
  if (controller.signal.aborted || results.some(result => result.passed !== true)) process.exitCode = 1;
}

if (values.worker === "endpoint") await endpointWorker();
else if (values.worker === "echo") await echoWorker();
else if (values.worker) throw new Error("Unknown network lab worker");
else await main();
