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
import { command, LabNetwork, SITE_IP, SITE_IPV6, SITE_ORIGIN } from "./network-lab/network";
import { checkAppPath, checkCalibration, checkContinuity, checkFaultHit, checkMapping, hasPicture, selectScenarios, summarizeTrials, type Scenario, type TrialSummary } from "./network-lab/scenarios";
import { echoWorker, type ProbeResult } from "./network-lab/udp";
import type { MediaSample } from "./network-lab/page";
import { checkMediaFeedback, checkMediaPath, readPacketFlows, type PacketFlow } from "./network-lab/packets";
import { verifyLaboratory } from "./network-lab/verify";

const ROOT = resolve(import.meta.dirname, ".."), ENTRY = resolve(import.meta.filename);
const { values } = parseArgs({ options: { worker: { type: "string" }, suite: { type: "string", default: "smoke" },
  cases: { type: "string" }, repeat: { type: "string", default: "1" }, seed: { type: "string", default: "1" },
  prediction: { type: "string", default: "on" },
  ipv6: { type: "boolean" }, list: { type: "boolean" }, verify: { type: "boolean" }, negative: { type: "string" } } });

class Endpoint {
  private id = 0;
  private failure: Error | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly process: ChildProcessWithoutNullStreams;
  constructor(namespace: string, readonly profile: string, private readonly signal: AbortSignal) {
    this.process = spawn("ip", ["netns", "exec", namespace, process.execPath, "--import", "tsx", ENTRY, "--worker", "endpoint"],
      { cwd: ROOT, env: { ...labEnvironment(), PIIK_NETWORK_LAB_PROFILE: profile }, stdio: "pipe" });
    this.process.stderr.on("data", data => process.stderr.write(data));
    this.process.stdin.on("error", error => this.fail(error));
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
  private fail(error: Error): void { this.failure = error; for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  async call<T>(action: string, args: Record<string, unknown> = {}, timeout = 45_000): Promise<T> {
    const id = ++this.id;
    if (this.failure) throw this.failure;
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

async function runCase(scenario: Scenario, seed: number, prediction: boolean, output: string, signal: AbortSignal): Promise<TrialSummary & Record<string, unknown>> {
  const network = new LabNetwork(), samples: Array<{ elapsedMs: number; host: MediaSample; viewer: MediaSample; sibling?: MediaSample }> = [];
  const started = performance.now(), endpoints: Endpoint[] = [];
  let server: ChildProcessWithoutNullStreams | null = null, echo: ChildProcessWithoutNullStreams | null = null;
  let stun: ChildProcessWithoutNullStreams | null = null;
  let capture: ChildProcessWithoutNullStreams | null = null;
  let serverLog = "", captureLog = "";
  const mediaWindows: Array<{ name: string; startMs: number; endMs: number; addresses: string[] }> = [];
  const pcapPath = join(output, "wan.pcap");
  const result: TrialSummary & Record<string, unknown> = { scenario, seed, prediction, passed: false, stage: "setup", samples };
  const stage = (name: string) => {
    result.stage = name; process.stdout.write(JSON.stringify({ case: scenario.id, stage: name }) + "\n");
  };
  const faultIndex = scenario.faultEndpoint ?? 0;
  const setFault = (fault: Scenario["fault"]) => network.setFault(faultIndex, values.negative === "missing-fault" ? "none" : fault, seed, scenario.direction);
  const counters = () => network.counters(faultIndex);
  const sampleAll = async () => {
    const [host, viewer, sibling] = await Promise.all(endpoints.map(endpoint => endpoint.call<MediaSample>("sample")));
    const sample = { elapsedMs: performance.now() - started, host: host!, viewer: viewer!, sibling };
    samples.push(sample); return sample;
  };
  const addresses = () => endpoints.map((_, index) => scenario.ipv6 ? network.ipv6(index) : network.publicIP(index));
  const checkAppPaths = () => {
    const current = samples.at(-1)!;
    if (scenario.host === "app") checkAppPath(current.host, "prepare-edge", network.localAddresses(0));
    if (scenario.viewer === "app") checkAppPath(current.viewer, "receive-offer", network.localAddresses(1));
  };
  const proveMedia = (flows: PacketFlow[], peers = addresses()) => {
    if (scenario.sfu) { checkMediaFeedback(flows, peers[0]!, SITE_IP); checkMediaFeedback(flows, SITE_IP, peers[1]!); }
    else checkMediaPath(flows, peers[0]!, peers[1]!, scenario.sibling ? [peers[2]!] : []);
    if (scenario.sibling) checkMediaPath(flows, peers[0]!, peers[2]!, [peers[1]!]);
  };
  try {
    signal.throwIfAborted();
    network.setup([...scenario.nat, ...(scenario.sibling ? ["preserve" as const] : [])], scenario.ipv6, values.negative === "partial-setup");
    echo = spawn("ip", ["netns", "exec", network.wan, process.execPath, "--import", "tsx", ENTRY, "--worker", "echo", ...(scenario.ipv6 ? ["--ipv6"] : [])],
      { cwd: ROOT, env: labEnvironment(), stdio: "pipe" });
    echo.stderr.on("data", data => process.stderr.write(data));
    echo.stdin.on("error", () => {});
    await withDeadline(() => once(echo!.stdout, "data"), Date.now() + 10_000);
    if (scenario.ipv6) {
      stun = spawn("ip", ["netns", "exec", network.wan, resolve("build/network-lab/bin/stun"), `[${SITE_IPV6}]:3478`],
        { env: labEnvironment(), stdio: "pipe" });
      stun.stderr.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
      stun.stdin.on("error", () => {});
      await withDeadline(() => once(stun!.stdout, "data"), Date.now() + 5000);
    }
    for (let i = 0; i < (scenario.sibling ? 3 : 2); i++) endpoints.push(new Endpoint(network.endpoint(i),
      await mkdtemp(join(tmpdir(), "piik-client-media-")), signal));
    stage("calibration");
    const baselines = await Promise.all(endpoints.map(endpoint => endpoint.call<ProbeResult>("probe")));
    result.mappingCalibration = baselines;
    baselines.forEach((probe, index) => checkMapping(probe, scenario.nat[index] ?? "preserve"));
    const filtering = await Promise.all(endpoints.map(endpoint => endpoint.call<{ sameEndpoint: boolean; changedPort: boolean; changedAddress: boolean }>("filter-probe")));
    result.filteringCalibration = filtering;
    if (filtering.some(probe => !probe.sameEndpoint || probe.changedPort || probe.changedAddress)) throw new Error("Observed NAT filtering differs from the configured endpoint-dependent filter");
    const before = baselines[faultIndex]!;
    const pair = endpoints.slice(0, 2);
    const mappings = await Promise.all(pair.map(endpoint => endpoint.call<{ address: string; port: number }>("peer-prepare")));
    const reachability = await Promise.all(pair.map((endpoint, index) => endpoint.call<{ replies: number }>("peer-probe", { peer: mappings[1 - index] })));
    result.peerCalibration = { mappings, reachability };
    if (scenario.nat.every(mode => mode === "preserve") && reachability.some(probe => probe.replies < 5)) throw new Error("Baseline UDP rendezvous failed independently of Piik");
    if (scenario.ipv6) {
      const probes = await Promise.all(endpoints.map(endpoint => endpoint.call<ProbeResult>("probe", { ipv6: true })));
      if (probes.some(probe => probe.received !== probe.sent || !probe.mappings[0]?.address.startsWith("2001:db8:72:"))) throw new Error("IPv6 calibration failed");
      result.ipv6Calibration = probes;
    }
    setFault(scenario.fault);
    const after = await endpoints[faultIndex]!.call<ProbeResult>("probe", { load: ["rate", "loss"].includes(scenario.fault) });
    result.calibration = { before, after }; result.initialCounters = counters();
    checkCalibration(before, after, scenario.fault);
    // Load probes are calibration traffic, never competing with measured media.
    if (scenario.duringShare) setFault("none");
    stage("startup");
    server = spawn("ip", ["netns", "exec", network.wan, resolve("build/network-lab/bin/piik-server")], {
      cwd: output, stdio: "pipe", env: { ...labEnvironment(), PIIK_ENV: "development", ROOM_DATABASE_PATH: ":memory:",
        LISTEN_HOST: SITE_IP, PORT: "9000", PUBLIC_BASE_URL: SITE_ORIGIN, ALLOWED_ORIGINS: SITE_ORIGIN,
        STUN_URLS: `stun:${SITE_IP}:3478,stun:${SITE_IP}:3479,stun:${SITE_IP}:3480${scenario.ipv6 ? `,stun:[${SITE_IPV6}]:3478` : ""}`, STUN_LISTEN_HOST: SITE_IP,
        NAT_PREDICTION_ENABLED: "true", ...(scenario.sfu ? { SFU_UDP_PORT: "7882", SFU_LISTEN_HOST: SITE_IP, SFU_PUBLIC_IP: SITE_IP } : {}) },
    });
    server.stdout.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
    server.stderr.on("data", data => { serverLog = (serverLog + data).slice(-32_000); });
    await once(server, "spawn");
    result.versions = await Promise.all(endpoints.map((endpoint, index) => endpoint.call("start", {
      origin: SITE_ORIGIN, app: index < 2 && (index === 0 ? scenario.host : scenario.viewer) === "app",
    })));
    capture = spawn("ip", ["netns", "exec", network.wan, "tcpdump", "-i", "internet", "-n", "-s", "96", "-U",
      "-w", pcapPath, "-c", "100000", "udp"], { stdio: "pipe" });
    capture.stderr.on("data", data => { captureLog = (captureLog + data).slice(-4000); });
    await withDeadline(async () => { while (!captureLog.includes("listening on")) {
      if (capture!.exitCode !== null) throw new Error(`Packet capture failed: ${captureLog}`);
      await delay(50, undefined, { signal });
    } }, Date.now() + 5000);
    stage("share");
    await endpoints[0]!.call("navigate", { url: SITE_ORIGIN + (scenario.host === "app" ? "/#piik-client=1" : "/") });
    const invitation = await endpoints[0]!.call<string>("share", { prediction });
    const joinedAt = performance.now();
    await endpoints[1]!.call("navigate", { url: invitation + (scenario.viewer === "app" ? "&piik-client=1" : "") });
    if (scenario.sibling) await endpoints[2]!.call("navigate", { url: invitation });
    stage("first-picture");
    let connected = false, exhausted = false;
    while (performance.now() - joinedAt < 110_000) {
      signal.throwIfAborted();
      const { viewer, sibling } = await sampleAll();
      connected = hasPicture(viewer) && (!scenario.sibling || !!sibling && hasPicture(sibling));
      exhausted = viewer.events.some(event => event.reason === "route-exhausted");
      if (connected || exhausted) break;
      await delay(500, undefined, { signal });
    }
    result.firstPictureMs = connected ? performance.now() - joinedAt : null;
    result.outcome = connected ? "media" : exhausted ? "unavailable" : "timeout";
    const expected = prediction ? scenario.enhancedExpected ?? scenario.expected : scenario.expected;
    if (result.outcome === "timeout" || (expected !== "observed" && result.outcome !== expected)) throw new Error(`Expected ${expected}, observed ${result.outcome}; ${serverLog.slice(-1000)}`);
    if (connected) {
      stage("continuity");
      const first = samples.at(-1)!.viewer;
      const steadyStart = Date.now();
      await delay(3000, undefined, { signal });
      const { viewer: next, sibling: healthy } = await sampleAll();
      checkContinuity(first, next);
      checkAppPaths();
      mediaWindows.push({ name: "baseline", startMs: steadyStart, endMs: Date.now(), addresses: addresses() });
      if (values.negative === "frozen-picture") {
        stage("negative-control");
        await endpoints[0]!.call("freeze-picture");
        // Drain already encoded frames before measuring the deliberately static source.
        await delay(2000, undefined, { signal });
        const frozen = await endpoints[1]!.call<MediaSample>("sample");
        await delay(3000, undefined, { signal });
        checkContinuity(frozen, (await sampleAll()).viewer);
        throw new Error("Frozen synthetic picture incorrectly passed");
      }
      if (scenario.sfu && next.route !== "sfu") throw new Error("Expected SFU route, but media used another path");
      if (scenario.duringShare) {
        stage("impairment");
        setFault(scenario.fault);
        const impairedAt = performance.now();
        let healthyWindow = healthy, healthyAt = impairedAt;
        if (scenario.fault === "signaling" && await endpoints[0]!.call("signal-probe")) throw new Error("Signaling remained reachable during blackhole");
        while (performance.now() - impairedAt < 8000) {
          signal.throwIfAborted();
          await sampleAll();
          if (healthyWindow && performance.now() - healthyAt >= 2000) {
            const current = samples.at(-1)!.sibling!;
            checkContinuity(healthyWindow, current);
            if (current.height < healthy!.height) throw new Error("Weak Viewer reduced its healthy sibling's resolution");
            healthyWindow = current; healthyAt = performance.now();
          }
          await delay(500, undefined, { signal });
        }
        result.impairedCounters = counters();
        checkFaultHit(scenario.fault, counters().faultDrops);
        if (scenario.fault === "signaling") checkContinuity(next, samples.at(-1)!.viewer);
        if (healthy) {
          checkContinuity(healthy, samples.at(-1)!.sibling!);
          if (samples.at(-1)!.sibling!.height < healthy.height) throw new Error("Weak Viewer reduced its healthy sibling's resolution");
        }
        if (scenario.remap) {
          result.addressChange = network.remapUDP(faultIndex);
          if (!await endpoints[0]!.call("signal-probe")) throw new Error("UDP address change interrupted TCP signaling");
        }
        const restoredAt = performance.now();
        setFault("none");
        result.restoredCounters = counters();
        const restoredProbe = await endpoints[faultIndex]!.call<ProbeResult>("probe");
        result.restoredCalibration = restoredProbe;
        checkCalibration(before, restoredProbe, "none");
        if (scenario.remap && restoredProbe.mappings.some(mapping => mapping.address !== network.publicIP(faultIndex))) throw new Error("UDP mappings retained the old public address");
        stage("recovery");
        let recovered = false;
        while (performance.now() - restoredAt < 60_000) {
          signal.throwIfAborted();
          const previous = samples.at(-1)!.viewer;
          await delay(1000, undefined, { signal });
          const { viewer } = await sampleAll();
          if (hasPicture(viewer) && viewer.frames > previous.frames) { recovered = true; break; }
        }
        result.recoveryMs = recovered ? performance.now() - restoredAt : null;
        if (!recovered) throw new Error("Media did not resume within the recovery observation window");
        const recoveredFirst = samples.at(-1)!.viewer, recoveredStart = Date.now();
        await delay(3000, undefined, { signal });
        const { viewer: recoveredNext } = await sampleAll();
        checkContinuity(recoveredFirst, recoveredNext);
        checkAppPaths();
        mediaWindows.push({ name: "recovered", startMs: recoveredStart, endMs: Date.now(), addresses: addresses() });
        if (scenario.fault === "signaling" && !await endpoints[0]!.call("signal-probe")) throw new Error("Signaling roundtrip did not recover");
      }
    }
    await endpoints[1]!.call("screenshot", { output: join(output, "viewer.png") });
    result.finalCounters = counters();
    if (!scenario.duringShare) checkFaultHit(scenario.fault, counters().faultDrops);
    await endpoints[0]!.call("stop");
    signal.throwIfAborted();
    result.passed = true; stage("done");
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally {
    try {
      result.logs = await Promise.all(endpoints.map(endpoint => endpoint.call("logs", {}, 5000).catch(String)));
      if (!result.passed) await Promise.all(endpoints.map((endpoint, index) =>
        endpoint.call("screenshot", { output: join(output, `failure-${index}.png`) }, 5000).catch(() => {})));
      result.endpointCleanup = await Promise.all(endpoints.map(endpoint => endpoint.call("close", {}, 30_000).catch(error => ({ error: String(error) }))));
      echo?.stdin.end();
      stun?.stdin.end();
      if (capture && capture.exitCode !== null) { result.captureError = "Capture ended before observation completed"; result.passed = false; }
      result.serviceCleanup = await Promise.all([echo, stun, server, capture].map(child => cleanupRun({
        chrome: null, native: null, cdp: null, server: child, profile: null, ports: [],
      }).catch(error => ({ error: String(error) }))));
      result.cleanup = await network.close().catch(error => ({ error: String(error) }));
      // If a worker died, the parent still owns its profile and removes it only
      // after namespace processes have stopped, using the same guarded cleanup.
      result.profileCleanup = await Promise.all(endpoints.map(async endpoint => {
        const exists = await access(endpoint.profile).then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
        if (!exists) return true;
        if (!(result.cleanup as { namespacesRemoved?: boolean }).namespacesRemoved) return false;
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
      if (result.outcome === "media" && !signal.aborted) proveMedia(flows);
      result.mediaWindows = [];
      for (const window of mediaWindows) {
        const selected = await readPacketFlows(pcapPath, window);
        proveMedia(selected, window.addresses);
        (result.mediaWindows as unknown[]).push({ ...window, flows: selected });
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

async function main(): Promise<void> {
  const selected = selectScenarios(values.suite!, values.cases);
  if (values.list) { process.stdout.write(JSON.stringify(selected, null, 2) + "\n"); return; }
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Network lab requires an isolated Linux runner and root for owned namespaces");
  if (!process.env.CHROME_PATH) throw new Error("CHROME_PATH is required");
  if (values.negative && !["missing-fault", "frozen-picture", "partial-setup"].includes(values.negative)) throw new Error("Unknown negative control");
  const repeat = Number(values.repeat), seed = Number(values.seed);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20 || !Number.isInteger(seed) || seed < 1 || seed + repeat - 1 > 0xffff_ffff) throw new Error("Invalid repeat (1..20) or seed (uint32)");
  if (!["on", "off", "compare"].includes(values.prediction!)) throw new Error("Prediction must be on, off or compare");
  for (const tool of ["ip", "tc", "nft", "sysctl", "tcpdump", ...(selected.some(scenario => scenario.remap) ? ["conntrack"] : [])]) command("which", [tool]);
  const output = resolve("build/network-lab/results", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  await mkdir(output, { recursive: true });
  process.stdout.write(JSON.stringify({ report: output }) + "\n");
  const identity = { revision: command("git", ["rev-parse", "HEAD"]), kernel: command("uname", ["-a"]),
    node: process.version, iproute: command("ip", ["-Version"]), tc: command("tc", ["-Version"]), nftables: command("nft", ["--version"]), selected, repeat, seed, prediction: values.prediction };
  await writeFile(join(output, "environment.json"), JSON.stringify(identity, null, 2) + "\n");
  const results: Array<TrialSummary & Record<string, unknown>> = [];
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Laboratory run cancelled"));
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  for (let iteration = 0; iteration < repeat; iteration++) for (const scenario of selected) {
    const variants = values.prediction === "compare" ? (iteration % 2 === 0 ? [false, true] : [true, false]) : [values.prediction === "on"];
    for (const prediction of variants) {
      if (controller.signal.aborted) break;
      const directory = join(output, `${scenario.id}-${iteration + 1}-${prediction ? "on" : "off"}`); await mkdir(directory);
      process.stdout.write(JSON.stringify({ starting: scenario.id, iteration: iteration + 1, prediction }) + "\n");
      const result = await runCase(scenario, seed + iteration, prediction, directory, controller.signal); results.push(result);
      process.stdout.write(JSON.stringify({ case: scenario.id, passed: result.passed, stage: result.stage, error: result.error, prediction }) + "\n");
    }
  }
  process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
  await writeFile(join(output, "summary.json"), JSON.stringify(results.map(({ samples: _samples, ...result }) => result), null, 2) + "\n");
  await writeFile(join(output, "distributions.json"), JSON.stringify(summarizeTrials(results), null, 2) + "\n");
  if (controller.signal.aborted || results.some(result => result.passed !== true)) process.exitCode = 1;
}

if (values.worker === "endpoint") await endpointWorker();
else if (values.worker === "echo") await echoWorker(values.ipv6);
else if (values.worker) throw new Error("Unknown network lab worker");
else if (values.verify) await verifyLaboratory(ENTRY);
else await main();
