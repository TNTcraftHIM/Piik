import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { withDeadline } from "../browser-gate-harness";

// Exercise the actual runner and OS signals. An arbitrary nonzero exit is not
// a passing negative control: it must reject the intended condition and clean up.
export async function verifyLaboratory(entry: string): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Laboratory verification requires isolated Linux root");
  const controls = [
    { name: "partial-setup", cases: "browser-browser", error: /^Injected partial network setup failure$/ },
    { name: "missing-fault", cases: "stun-backup", error: /^No packets hit the stun-primary rule;/, media: true },
    { name: "frozen-picture", cases: "browser-browser", error: /^(Decoded video did not continue|Rendered synthetic picture did not change)$/, media: true },
    { name: "cancel-calibration", cases: "browser-browser,app-app", cancelAt: "calibration" },
    { name: "cancel-sharing", cases: "browser-browser,app-app", cancelAt: "continuity" },
  ];
  const results: unknown[] = [];
  const output = resolve("build/network-lab/results", `verification-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(output, { recursive: true });
  for (const control of controls) {
    let report = "", stderr = "", cancelled = false;
    const child = spawn(process.execPath, ["--import", "tsx", entry, "--cases", control.cases,
      ...(control.cancelAt ? [] : ["--negative", control.name])], { stdio: "pipe" });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.report) report = message.report;
        if (control.cancelAt && message.stage === control.cancelAt && !cancelled) {
          cancelled = true; child.kill("SIGINT");
        }
      } catch {}
    });
    try {
      const [code] = await withDeadline(() => once(child, "exit"), Date.now() + 180_000);
      if (code !== 1 || !report) throw new Error(`Expected a recorded failure; exit ${code}: ${stderr}`);
      const records = JSON.parse(await readFile(resolve(report, "summary.json"), "utf8"));
      if (records.length !== 1) throw new Error("A cancelled run continued into another case");
      const result = records[0];
      if (result.passed || (control.error && !control.error.test(result.error ?? "")) ||
          (control.cancelAt && (!cancelled || !result.cancelled)) ||
          (control.media && result.outcome !== "media")) throw new Error(`Wrong failure: ${JSON.stringify(result.error)}`);
      const cleanup = [result.cleanup, ...result.endpointCleanup, ...result.serviceCleanup];
      if (!cleanup.every(value => Object.values(value).every(flag => flag === true)) ||
          !result.profileCleanup.every(Boolean) || result.cleanupError || result.captureError) throw new Error("Negative control leaked resources or lost evidence");
      results.push({ control: control.name, verified: true, report, error: result.error, cleanup: result.cleanup });
    } catch (error) {
      results.push({ control: control.name, verified: false, report, error: String(error) });
      process.exitCode = 1;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await withDeadline(() => once(child, "exit"), Date.now() + 45_000).catch(() => child.kill("SIGKILL"));
      }
    }
    process.stdout.write(JSON.stringify(results.at(-1)) + "\n");
  }
  await writeFile(resolve(output, "verification.json"), JSON.stringify(results, null, 2) + "\n");
}
