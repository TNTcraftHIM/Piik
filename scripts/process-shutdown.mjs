import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./process-shutdown.ps1", import.meta.url));
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const targets = new WeakMap();
const helperArgs = (action, data) => [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
  action, Buffer.from(JSON.stringify(data)).toString("base64"),
];

// The first line belongs to the launcher; later output belongs to the application.
async function readTargetPid(child) {
  return await new Promise((resolvePid, rejectPid) => {
    let line = "";
    const finish = (error, pid) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout.pause();
      if (error) rejectPid(error);
      else resolvePid(pid);
    };
    const onData = (chunk) => {
      const newline = chunk.indexOf(10);
      if (newline < 0) {
        line += chunk.toString("ascii");
        return;
      }
      line += chunk.subarray(0, newline).toString("ascii");
      const pid = Number(line.trim());
      finish(Number.isSafeInteger(pid) && pid > 0 ? null : new Error("Windows launcher returned an invalid process ID"), pid);
      if (newline + 1 < chunk.length) child.stdout.unshift(chunk.subarray(newline + 1));
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error(`Windows launcher stopped before reporting its process ID: ${child.stderr.read()?.toString().trim() || child.exitCode}`));
    const timer = setTimeout(() => finish(new Error("Windows launcher did not report its process ID")), 15_000);
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

// Windows needs an isolated, hidden console; Node's windowsHide/detached flags
// remove that console. The returned ChildProcess is its waiting PowerShell parent.
export async function spawnProcess(command, args, { cwd, env, logDirectory }) {
  const options = { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
  if (process.platform !== "win32") return spawn(command, args, options);
  const directory = mkdtempSync(join(logDirectory, "process-"));
  const child = spawn(powershell, helperArgs("Start", {
    command, arguments: args, directory,
  }), options);
  try {
    targets.set(child, await readTargetPid(child));
    return child;
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 5_000,
      });
      await stopped.catch(() => undefined);
    }
    throw error;
  }
}

export async function requestShutdown(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  const pid = targets.get(child);
  if (!pid) throw new Error("Windows graceful shutdown requires spawnProcess");
  const sender = spawn(powershell, helperArgs("Stop", { pid }), {
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 15_000,
  });
  let stderr = "";
  sender.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolveStop, rejectStop) => {
    sender.once("error", rejectStop);
    sender.once("close", (code) => code === 0
      ? resolveStop()
      : rejectStop(new Error(`Windows graceful shutdown failed: ${stderr.trim() || code}`)));
  });
}
