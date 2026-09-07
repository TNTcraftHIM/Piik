import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "build/embedded-media/encoded-variants.probe.exe");
const output = resolve("build/embedded-media/encoded-variants-result.json");
const steady = ["high", "two-high", "high-low", "all", "mid-low", "low"];
const traces = ["envelope", "exact-cold", "exact-warm", "warm-clock-ablation"];
const results = [];
const report = {
  completed: false,
  scope: "CPU-only Native VP8 encode microbenchmark, not playback/network/H264 acceptance",
  input: "32 synthetic NV12 frames per size; generation and scaling excluded",
  profiles: [[480, 270, 312500], [960, 540, 1250000], [1920, 1080, 5000000]],
  fps: 30,
  threadsPerEncoder: 4,
  demandTrace: ["H/H", "H/L", "L/L", "M/M", "H/H", "H/L", "H/H"],
  secondsPerDemand: 2,
  envelope: "maximum-demand active set; no LiveKit demand detection/debounce emulation",
  warm: "retain at most three codec objects within the 14-second trace, stop inactive encoding",
  clockAblation: "change only encoder PTS to a continuous active-frame clock; not a production proposal",
  cpuMeasurement: "whole-window GetProcessTimes and QueryProcessCycleTime on Windows; cycles are not converted to milliseconds",
  sources: Object.fromEntries(["native/capture/windows/encoded_variants.probe.cpp", "native/capture/windows/vp8_encoder.cpp"].map(
    (path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")],
  )),
  host: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  results,
};
mkdirSync(dirname(output), { recursive: true });

for (let round = 0; round < 2; round++) {
  for (const scene of ["still", "motion"]) {
    const cases = [...steady, ...(scene === "motion" ? traces : [])];
    if (round) cases.reverse();
    for (const scenario of cases) {
      const processResult = spawnSync(executable, [scenario, scene], {
        encoding: "utf8", windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024,
      });
      assert.equal(processResult.error, undefined, processResult.error?.message);
      assert.equal(processResult.status, 0, processResult.stderr);
      const result = JSON.parse(processResult.stdout);
      assert.equal(result.scenario, scenario);
      assert.equal(result.scene, scene);
      if (traces.includes(scenario)) {
        const expected = scenario === "envelope" ? [420, 360, 300, 0] : [180, 60, 300, 0];
        assert.deepEqual(result.summary.encodedFrames, expected);
        assert.equal(result.transitions.length, 7);
        assert.equal(result.summary.createCount, scenario === "exact-warm" || scenario === "warm-clock-ablation" ? 3 : 5);
      } else {
        const masks = { high: 4, "two-high": 12, "high-low": 5, all: 7, "mid-low": 3, low: 1 };
        assert.deepEqual(result.summary.encodedFrames, [0, 1, 2, 3].map((slot) => masks[scenario] & (1 << slot) ? 90 : 0));
        if (scenario === "two-high") assert.equal(result.summary.encodedBytes[2], result.summary.encodedBytes[3]);
      }
      results.push({ round: round + 1, ...result });
      writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`${round + 1} ${scene} ${scenario}: mean=${result.summary.workMeanMs}ms p95=${result.summary.workP95Ms}ms cpu=${result.summary.cpuCoresAt30Fps} cores`);
    }
  }
}
report.completed = true;
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Passed ${results.length} bounded runs; results: ${output}`);
