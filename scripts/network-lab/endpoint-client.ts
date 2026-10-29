import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { withDeadline } from "../browser-gate-harness";

// Both laboratories use the same real UI worker. Only the network substrate differs.
export class Endpoint {
  private id = 0;
  private failure: Error | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly process: ChildProcessWithoutNullStreams;
  constructor(namespace: string | null, readonly profile: string, private readonly signal: AbortSignal, env: NodeJS.ProcessEnv) {
    const root = resolve(import.meta.dirname, "../..");
    const args = [process.execPath, "--import", "tsx", resolve(root, "scripts/network-lab.ts"), "--worker", "endpoint"];
    this.process = spawn(namespace ? "ip" : args.shift()!, namespace ? ["netns", "exec", namespace, ...args] : args,
      { cwd: root, env: { ...env, SILIP_NETWORK_LAB_PROFILE: profile }, stdio: "pipe", windowsHide: true });
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
