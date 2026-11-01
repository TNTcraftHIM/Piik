import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// All children belong to a LabNetwork namespace; its final cleanup also checks
// that no process or host-network change survives a failed control.
export class LabProcess {
  readonly child;
  readonly records: any[] = [];
  stdout = "";
  stderr = "";
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(readonly name: string, namespace: string, program: string, args: string[], env = process.env) {
    this.child = spawn("ip", ["netns", "exec", namespace, program, ...args], { env, stdio: "pipe" });
    this.child.stdin.on("error", () => {});
    this.done = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      // `exit` precedes pipe drainage and can lose the worker's final JSON.
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    void this.done.catch(() => {});
    this.child.stderr.on("data", bytes => { this.stderr += bytes; });
    let pending = "";
    this.child.stdout.on("data", bytes => {
      this.stdout += bytes; pending += bytes;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try { this.records.push(JSON.parse(line)); } catch { /* Human logs are retained separately. */ }
      }
    });
  }

  async wait(check: () => boolean, signal: AbortSignal, milliseconds = 20_000): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (!check()) {
      signal.throwIfAborted();
      assert(this.child.exitCode === null && !this.child.signalCode, `${this.name} exited: ${this.stderr}`);
      assert(Date.now() < deadline, `${this.name} observation deadline`);
      await delay(50, undefined, { signal });
    }
  }

  async close(signal?: NodeJS.Signals): Promise<void> {
    if (this.child.exitCode === null && !this.child.signalCode) {
      if (signal) this.child.kill(signal); else this.child.stdin.end();
    }
    const timeout = new AbortController();
    try {
      const result = await Promise.race([this.done, delay(10_000, undefined, { signal: timeout.signal })
        .then(() => { throw Error(`${this.name} did not retire`); })]);
      assert(result.code === 0 || result.signal === signal, `${this.name} failed: ${this.stderr}`);
    } finally { timeout.abort(); }
  }

  async save(output: string): Promise<void> {
    await writeFile(join(output, `${this.name}.stdout.log`), this.stdout);
    await writeFile(join(output, `${this.name}.stderr.log`), this.stderr);
  }
}
