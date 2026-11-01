// Linux-only kernel controls. Run --list anywhere; the controls need root,
// iproute2/nftables/conntrack/tcpdump and the normal Server example + Browser WASM.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { LabNetwork, command, type NatMode } from "./network-lab/network";
import { echoWorker, udpProbe, filteringProbe } from "./network-lab/udp";
import { checkCalibration, checkMapping } from "./network-lab/scenarios";
import { readPacketFlows } from "./network-lab/packets";
import { LabProcess } from "./network-lab/process";
import { media } from "./network-lab/browser";

const cases = {
  ordinary: "preserve NAT: Browser → real Native room → Browser; history/file/audio/decoded video",
  prepared: "sequential NAT: real Core-required preparation → Native DataChannel",
  recovery: "established Native pair: 50s UDP loss + remap → replacement DataChannel within 30s",
  media: "calibrated prepared Native transit: Browser → Native root → Native probe → Browser decoded media",
  "browser-relay": "Browser source → Native room → Browser relay → decoded viewer; 50s UDP loss and recovery",
};
const { values } = parseArgs({ options: {
  list: { type: "boolean" }, case: { type: "string" }, output: { type: "string" },
  executable: { type: "string" }, worker: { type: "string" },
} });
if (values.list) console.log(Object.entries(cases).map(([name, text]) => `${name}: ${text}`).join("\n"));
else if (values.worker) {
  if (values.worker === "echo") await echoWorker();
  else if (values.worker === "probe") console.log(JSON.stringify(await udpProbe(false)));
  else if (values.worker === "filter") console.log(JSON.stringify(await filteringProbe()));
  else throw Error("Unknown LAB worker");
} else {
  assert(values.case && Object.hasOwn(cases, values.case), "Choose --case ordinary|prepared|recovery|media|browser-relay (or --list)");
  assert.equal(process.platform, "linux", "Kernel controls run only on Linux");
  assert.equal(process.getuid?.(), 0, "Kernel controls need root for owned namespaces");
  await run(values.case as keyof typeof cases);
}

async function run(name: keyof typeof cases): Promise<void> {
  const source = resolve(import.meta.dirname, "..");
  const output = resolve(values.output ?? `build/network-lab/${name}-${Date.now()}`);
  const executable = resolve(values.executable ?? (process.env.CARGO_TARGET_DIR
    ? join(process.env.CARGO_TARGET_DIR, "debug/examples/network_lab")
    : "prototype/channel-server/target/debug/examples/network_lab"));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // A failed observation is retained; never reuse its output.
  const network = new LabNetwork(), processes: LabProcess[] = [];
  const stopped = new AbortController();
  const cancel = () => stopped.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const signal = stopped.signal;
  const start = (label: string, ns: string, program: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const child = new LabProcess(label, ns, program, args, env); processes.push(child); return child;
  };
  // Reuse this entry's worker with the same TypeScript loader (or bundled JS).
  const worker = (label: string, ns: string, task: string) => start(label, ns, process.execPath,
    [...process.execArgv, process.argv[1]!, "--worker", task]);
  const browserCase = name === "ordinary" || name === "media" || name === "browser-relay";
  const modes: NatMode[] = name === "media" ? ["sequential", "sequential", "preserve", "preserve"]
    : name === "browser-relay" ? ["preserve", "preserve", "preserve", "preserve"]
    : name === "ordinary" ? ["preserve", "preserve", "preserve"]
    : name === "prepared" ? ["sequential", "sequential"] : ["preserve", "preserve"];
  const result: any = { case: name, scope: cases[name], passed: false,
    sourceHead: process.env.SOURCE_HEAD ?? command("git", ["-C", source, "rev-parse", "HEAD"]), kernel: command("uname", ["-sr"]), node: process.version };
  let capture: LabProcess | undefined;
  try {
    network.setup(modes);
    const fullConeNodes = name === "media" ? [2, 3] : name === "browser-relay" ? [1, 2, 3] : [];
    for (const index of fullConeNodes) network.exec(network.router(index), "nft", [
      "add chain ip lab_nat prerouting { type nat hook prerouting priority dstnat; policy accept; }\n"
      + `add rule ip lab_nat prerouting iifname \"wan0\" ip daddr ${network.publicIP(index)} meta l4proto udp dnat to 10.71.${index + 1}.2\n`
      + "add rule inet lab_filter forward iifname \"wan0\" meta l4proto udp counter accept",
    ]);
    const echo = worker("echo", network.wan, "echo");
    await echo.wait(() => echo.records.some(row => row.ready), signal);
    result.calibration = await Promise.all(modes.map(async (mode, index) => {
      const probe = worker(`mapping-${index}`, network.endpoint(index), "probe");
      assert.equal((await probe.done).code, 0);
      checkMapping(probe.records[0], mode); checkCalibration(probe.records[0], probe.records[0], "none");
      const filter = worker(`filter-${index}`, network.endpoint(index), "filter");
      assert.equal((await filter.done).code, 0);
      const value = filter.records[0], fullCone = fullConeNodes.includes(index);
      assert(value.sameEndpoint && value.changedPort === fullCone && value.changedAddress === fullCone, "NAT filtering calibration");
      return { mapping: probe.records[0], filtering: value };
    }));
    await echo.close();
    // Reachability, not fake plans, retains the Native transit path when Core
    // would otherwise choose the legal Browser-to-Browser shortcut.
    const blocked = name === "ordinary" ? [[1, 2], [2, 1]] : name === "media"
      ? [[0, 3], [3, 0], [1, 2], [2, 1], [2, 3], [3, 2]] : [];
    for (const [index, peer] of blocked) network.exec(network.router(index!), "nft", [
      `add rule inet lab_filter faults ip daddr ${network.publicIP(peer!)} meta l4proto udp counter drop`,
    ]);
    result.blockedShortcuts = blocked;
    capture = start("capture", network.wan, "tcpdump", ["-i", "internet", "-n", "-s", "96", "-U", "-w", join(output, "wan.pcap"), "-c", "20000", "udp"]);
    await capture.wait(() => capture!.stderr.includes("listening on"), signal);
    const domain = start("domain", network.wan, executable, ["domain", join(output, "domain")],
      { ...process.env, PIIK_CHANNEL_PORT: browserCase ? "9001" : "9000" });
    await domain.wait(() => domain.records.some(row => row.event?.type === "domain-ready"), signal);
    if (browserCase) await media({ source, output, executable, network, start, signal, result }, name as "ordinary" | "media" | "browser-relay");
    else {
      start("native-host", network.endpoint(0), executable, ["host", join(output, "host")]);
      const reader = start("native-reader", network.endpoint(1), executable, ["participant"]);
      const ready = (since = 0) => reader.records.some(row => row.atMs >= since && row.event?.type === "native-command"
        && row.event.command.type === "base_state" && row.event.command.ready);
      await reader.wait(() => ready(), signal, 90_000);
      result.plans = reader.records.filter(row => row.event?.type === "plan").flatMap(row => row.event.pairs);
      if (name === "prepared") {
        assert(result.plans.some((pair: any) => pair.preparation === "required"));
        assert(reader.records.some(row => row.event?.type === "native-signal" && row.event.udp === "complete"));
      } else {
        const initial = result.plans.at(-1).id;
        const blockedAt = Date.now();
        network.setFault(0, "udp-block", 1);
        await delay(50_000, undefined, { signal });
        result.blocked = network.counters(0);
        assert(result.blocked.faultDrops > 0, "Blackout must hit actual peer traffic");
        result.remap = network.remapUDP(0);
        const restored = Date.now(); network.setFault(0, "none", 1);
        await reader.wait(() => ready(restored), signal, 30_000);
        result.recovery = { blockedAt, restoredAt: restored, events: reader.records.filter(row => row.atMs >= blockedAt) };
        assert(result.recovery.events.some((row: any) => row.event?.type === "plan" && row.event.pairs.some((pair: any) => pair.id !== initial)));
      }
      await delay(3000, undefined, { signal });
    }
    result.passed = true;
  } catch (error) { result.error = String(error instanceof Error ? error.stack : error); }
  finally {
    for (const child of [...processes].reverse()) {
      try { await child.close(child.name === "echo" ? undefined : "SIGINT"); }
      catch (error) { (result.cleanupErrors ??= []).push(String(error)); }
      await child.save(output);
    }
    try {
      if (capture) {
        result.packetFlows = await readPacketFlows(join(output, "wan.pcap"));
        result.counters = modes.map((_, index) => network.counters(index));
        if (result.passed) {
          const edges = result.mediaEdges ?? (name === "ordinary" ? [[0, 1], [0, 2]] : name === "media" ? [[0, 2], [0, 1], [1, 3]] : [[0, 1]]);
          for (const [a, b] of edges) for (const [from, to] of [[a!, b!], [b!, a!]]) assert(result.packetFlows.some((flow: any) =>
            flow.source === network.publicIP(from) && flow.destination === network.publicIP(to) && (browserCase ? flow.kind === "rtp" : flow.kind === "other")), "Actual peer wire traffic must cross every selected edge");
        }
      }
      result.remainingNamespacePids = Object.fromEntries(network.namespaces.map(ns => [ns, command("ip", ["netns", "pids", ns])]));
      assert(Object.values(result.remainingNamespacePids).every(value => !value), "All owned children must retire");
    } catch (error) { (result.cleanupErrors ??= []).push(String(error)); }
    result.cleanup = await network.close();
    if (result.cleanupErrors?.length || Object.values(result.cleanup).some(value => !value)) result.passed = false;
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ output, passed: result.passed, error: result.error, cleanup: result.cleanup }));
    if (!result.passed) process.exitCode = 1;
  }
}
