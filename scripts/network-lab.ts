import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { withDeadline } from "./browser-gate-harness";
import { endpointWorker } from "./network-lab/endpoint";
import { command, LabNetwork, SITE_IP, SITE_ORIGIN } from "./network-lab/network";
import { checkCalibration, hasPicture, selectScenarios, type Scenario } from "./network-lab/scenarios";
import { echoWorker, type ProbeResult } from "./network-lab/udp";
import type { MediaSample } from "./network-lab/page";

const ROOT = resolve(import.meta.dirname, ".."), ENTRY = resolve(import.meta.filename);
const { values } = parseArgs({ options: { worker: { type: "string" }, suite: { type: "string", default: "smoke" },
  cases: { type: "string" }, repeat: { type: "string", default: "1" }, seed: { type: "string", default: "1" }, list: { type: "boolean" } } });

class Endpoint {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly process: ChildProcessWithoutNullStreams;
  constructor(namespace: string) {
    this.process = spawn("ip", ["netns", "exec", namespace, process.execPath, "--import", "tsx", ENTRY, "--worker", "endpoint"],
      { cwd: ROOT, env: labEnvironment(), stdio: "pipe" });
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
    try {
      return await withDeadline(() => new Promise<T>((resolveCall, reject) => {
        this.pending.set(id, { resolve: value => resolveCall(value as T), reject });
        this.process.stdin.write(JSON.stringify({ id, action, ...args }) + "\n", error => {
          if (error) { this.pending.delete(id); reject(error); }
        });
      }), Date.now() + timeout);
    } finally { this.pending.delete(id); }
  }
}

function labEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, CHROME_PATH: process.env.CHROME_PATH, LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR };
}

async function runCase(scenario: Scenario, seed: number, output: string): Promise<Record<string, unknown>> {
  const network = new LabNetwork(), samples: Array<{ elapsedMs: number; host: MediaSample; viewer: MediaSample }> = [];
  const started = performance.now(), endpoints: Endpoint[] = [];
  let server: ChildProcessWithoutNullStreams | null = null, echo: ChildProcessWithoutNullStreams | null = null;
  const result: Record<string, unknown> = { scenario, seed, passed: false, stage: "setup", samples };
  let signal: string | null = null;
  const interrupted = () => { signal = "interrupted"; };
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  try {
    network.setup([scenario.nat, scenario.nat]);
    echo = spawn("ip", ["netns", "exec", network.wan, process.execPath, "--import", "tsx", ENTRY, "--worker", "echo"],
      { cwd: ROOT, env: labEnvironment(), stdio: "pipe" });
    echo.stderr.on("data", data => process.stderr.write(data));
    await withDeadline(() => once(echo!.stdout, "data"), Date.now() + 10_000);
    for (let i = 0; i < 2; i++) endpoints.push(new Endpoint(network.endpoint(i)));
    result.stage = "calibration";
    const before = await endpoints[0]!.call<ProbeResult>("probe");
    network.setFault(0, scenario.duringShare ? "none" : scenario.fault, seed);
    const after = await endpoints[0]!.call<ProbeResult>("probe", { load: ["rate", "loss"].includes(scenario.fault) });
    checkCalibration(before, after, scenario.duringShare ? "none" : scenario.fault);
    result.calibration = { before, after }; result.initialCounters = network.counters(0);
    result.stage = "startup";
    server = spawn("ip", ["netns", "exec", network.wan, resolve("build/network-lab/bin/piik-server")], {
      cwd: output, stdio: "pipe", env: { ...labEnvironment(), PIIK_ENV: "development", ROOM_DATABASE_PATH: ":memory:",
        LISTEN_HOST: SITE_IP, PORT: "9000", PUBLIC_BASE_URL: SITE_ORIGIN, ALLOWED_ORIGINS: SITE_ORIGIN,
        STUN_URLS: `stun:${SITE_IP}:3478,stun:${SITE_IP}:3479,stun:${SITE_IP}:3480`, STUN_LISTEN_HOST: SITE_IP,
        NAT_PREDICTION_ENABLED: "true", ...(scenario.sfu ? { SFU_UDP_PORT: "7882", SFU_LISTEN_HOST: SITE_IP, SFU_PUBLIC_IP: SITE_IP } : {}) },
    });
    let serverLog = "";
    server.stdout.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
    server.stderr.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
    await once(server, "spawn"); await delay(300);
    result.versions = await Promise.all(endpoints.map((endpoint, index) => endpoint.call("start", {
      origin: SITE_ORIGIN, app: (index === 0 ? scenario.host : scenario.viewer) === "app",
    })));
    result.stage = "share";
    await endpoints[0]!.call("navigate", { url: SITE_ORIGIN + (scenario.host === "app" ? "/#piik-client=1" : "/") });
    const invitation = await endpoints[0]!.call<string>("share");
    const joinedAt = performance.now();
    await endpoints[1]!.call("navigate", { url: invitation + (scenario.viewer === "app" ? "&piik-client=1" : "") });
    result.stage = "first-picture";
    let connected = false, exhausted = false;
    while (performance.now() - joinedAt < 110_000) {
      if (signal) throw new Error(signal);
      const host = await endpoints[0]!.call<MediaSample>("sample"), viewer = await endpoints[1]!.call<MediaSample>("sample");
      samples.push({ elapsedMs: performance.now() - started, host, viewer });
      connected = hasPicture(viewer); exhausted = viewer.events.some(event => event.reason === "route-exhausted");
      if (connected || exhausted) break;
      await delay(500);
    }
    result.firstPictureMs = connected ? performance.now() - joinedAt : null;
    result.outcome = connected ? "media" : exhausted ? "unavailable" : "timeout";
    if (result.outcome !== scenario.expected) throw new Error(`Expected ${scenario.expected}, observed ${result.outcome}; ${serverLog.slice(-1000)}`);
    if (connected) {
      result.stage = "continuity";
      const first = samples.at(-1)!.viewer;
      await delay(3000);
      const next = await endpoints[1]!.call<MediaSample>("sample");
      samples.push({ elapsedMs: performance.now() - started, host: await endpoints[0]!.call("sample"), viewer: next });
      if (next.frames - first.frames < 30) throw new Error("Decoded video did not continue after initial picture");
      if (scenario.host === "app" && !samples.at(-1)!.host.controls.includes("receive-offer")) throw new Error("Host bypassed expected App ingress");
      if (scenario.viewer === "app" && !next.controls.includes("receive-offer")) throw new Error("Viewer bypassed expected App reception");
      if (scenario.duringShare) {
        result.stage = "impairment";
        network.setFault(0, scenario.fault, seed);
        const impaired = await endpoints[0]!.call<ProbeResult>("probe", { load: scenario.fault === "rate" });
        checkCalibration(before, impaired, scenario.fault);
        result.impairedCalibration = impaired;
        const impairedAt = performance.now();
        while (performance.now() - impairedAt < 8000) {
          if (signal) throw new Error(signal);
          samples.push({ elapsedMs: performance.now() - started, host: await endpoints[0]!.call("sample"), viewer: await endpoints[1]!.call("sample") });
          await delay(500);
        }
        result.impairedCounters = network.counters(0);
        network.setFault(0, "none", seed);
        result.stage = "recovery";
        const restoredAt = performance.now(); let recovered = false;
        while (performance.now() - restoredAt < 60_000) {
          if (signal) throw new Error(signal);
          const previous = samples.at(-1)!.viewer;
          await delay(1000);
          const viewer = await endpoints[1]!.call<MediaSample>("sample");
          samples.push({ elapsedMs: performance.now() - started, host: await endpoints[0]!.call("sample"), viewer });
          if (hasPicture(viewer) && viewer.frames - previous.frames >= 15) { recovered = true; break; }
        }
        result.recoveryMs = recovered ? performance.now() - restoredAt : null;
        if (!recovered) throw new Error("Media did not resume within the recovery observation window");
      }
    }
    await endpoints[1]!.call("screenshot", { output: join(output, "viewer.png") });
    result.finalCounters = network.counters(0);
    await endpoints[0]!.call("stop");
    result.passed = true; result.stage = "done";
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally {
    result.endpointCleanup = await Promise.all(endpoints.map(endpoint => endpoint.call("close", {}, 15_000).catch(error => ({ error: String(error) }))));
    echo?.stdin.end(); server?.kill("SIGTERM");
    await delay(200);
    result.cleanup = await network.close();
    if (!(result.endpointCleanup as Array<Record<string, unknown>>).every(value => Object.values(value).every(flag => flag === true)) ||
        !Object.values(result.cleanup as Record<string, boolean>).every(Boolean)) result.passed = false;
    process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    result.durationMs = performance.now() - started;
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}

async function main(): Promise<void> {
  const selected = selectScenarios(values.suite!, values.cases);
  if (values.list) { process.stdout.write(JSON.stringify(selected, null, 2) + "\n"); return; }
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Network lab requires an isolated Linux runner and root for owned namespaces");
  if (!process.env.CHROME_PATH) throw new Error("CHROME_PATH is required");
  const repeat = Number(values.repeat), seed = Number(values.seed);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20 || !Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) throw new Error("Invalid repeat (1..20) or seed (uint32)");
  for (const tool of ["ip", "tc", "nft", "sysctl"]) command("which", [tool]);
  const output = resolve("build/network-lab/results", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  await mkdir(output, { recursive: true });
  const identity = { revision: command("git", ["rev-parse", "HEAD"]), kernel: command("uname", ["-a"]),
    node: process.version, iproute: command("ip", ["-Version"]), nftables: command("nft", ["--version"]), selected, repeat, seed };
  await writeFile(join(output, "environment.json"), JSON.stringify(identity, null, 2) + "\n");
  const results: Array<Record<string, unknown>> = [];
  for (let iteration = 0; iteration < repeat; iteration++) for (const scenario of selected) {
    const directory = join(output, `${scenario.id}-${iteration + 1}`); await mkdir(directory);
    process.stdout.write(JSON.stringify({ starting: scenario.id, iteration: iteration + 1 }) + "\n");
    const result = await runCase(scenario, seed + iteration, directory); results.push(result);
    process.stdout.write(JSON.stringify({ case: scenario.id, passed: result.passed, stage: result.stage, error: result.error }) + "\n");
  }
  await writeFile(join(output, "summary.json"), JSON.stringify(results.map(({ samples: _samples, ...result }) => result), null, 2) + "\n");
  if (results.some(result => result.passed !== true)) process.exitCode = 1;
}

if (values.worker === "endpoint") await endpointWorker();
else if (values.worker === "echo") await echoWorker();
else if (values.worker) throw new Error("Unknown network lab worker");
else await main();
