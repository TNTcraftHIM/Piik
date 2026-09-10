import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import WebSocket from "ws";

export interface PageHandle {
  sessionId: string;
}

interface CdpResult<T> {
  result: { value?: T };
  exceptionDetails?: unknown;
}

export interface CleanupResult {
  browserExited: boolean;
  nativeExited: boolean;
  serverClosed: boolean;
  portsClosed: boolean;
  profileRemoved: boolean;
}

interface AsyncCloseable {
  close(): Promise<void>;
}

// A gate's server is either an in-process page server it closes directly or a
// spawned Piik server it stops like any other child.
export type CleanupServer = AsyncCloseable | ChildProcessWithoutNullStreams;

export interface CleanupResources {
  cdp: CdpConnection | null;
  native: ChildProcessWithoutNullStreams | null;
  chrome: ChildProcessWithoutNullStreams | null;
  server: CleanupServer | null;
  profile: string | null;
  ports: number[];
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", () => this.closePending());
    socket.on("error", () => this.closePending());
  }

  static async connect(url: string, deadline: number): Promise<CdpConnection> {
    const socket = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
    try {
      await withDeadline(() => new Promise<void>((resolveOpen, rejectOpen) => {
        socket.once("open", resolveOpen);
        socket.once("error", rejectOpen);
      }), deadline);
    } catch (error) {
      socket.terminate();
      throw error;
    }
    return new CdpConnection(socket);
  }

  call<T>(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    deadline: number,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot call ${method}: CDP is closed`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolveCall, rejectCall) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`CDP command timed out: ${method}`));
      }, Math.max(0, deadline - Date.now()));
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveCall(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectCall(error);
        },
        timeout,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        rejectCall(error instanceof Error ? error : new Error("CDP send failed"));
      }
    });
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }

  private onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const detail = typeof message.error === "object" && "message" in message.error
        ? String(message.error.message)
        : "unknown protocol error";
      pending.reject(new Error(`CDP command failed: ${detail}`));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private closePending(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
  }
}

// launchChrome starts an isolated Chrome process with the shared CDP flags.
export function launchChrome(
  executable: string,
  debugPort: number,
  profile: string,
  flags: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
  return spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    ...flags,
    "about:blank",
  ], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
    windowsHide: true,
  });
}

export function withDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  now: () => number = Date.now,
): Promise<T> {
  const remaining = Math.max(0, deadline - now());
  return new Promise<T>((resolveValue, rejectValue) => {
    const timeout = setTimeout(
      () => rejectValue(new Error("Operation deadline exceeded")),
      remaining,
    );
    Promise.resolve().then(operation).then(
      (value) => {
        clearTimeout(timeout);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        rejectValue(error);
      },
    );
  });
}

type JsonFetch = (
  input: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export async function fetchJsonBefore<T>(
  url: string,
  deadline: number,
  fetcher: JsonFetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  const abort = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - Date.now()),
  );
  try {
    const response = await withDeadline(
      () => fetcher(url, { signal: controller.signal }),
      deadline,
    );
    if (!response.ok) throw new Error("HTTP response was not successful");
    return await withDeadline(() => response.json() as Promise<T>, deadline);
  } finally {
    clearTimeout(abort);
    controller.abort();
  }
}

export async function waitForSample<T>(
  sample: (deadline: number) => Promise<T>,
  retainAndAccept: (value: T) => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | undefined;
    try {
      value = await withDeadline(() => sample(deadline), deadline);
    } catch {}
    if (value !== undefined && retainAndAccept(value)) return;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Bounded browser stage timed out");
}

export async function createPage(
  cdp: CdpConnection,
  url: string,
  probe?: string,
  newWindow = false,
  browserContextId?: string,
): Promise<PageHandle> {
  const deadline = Date.now() + 15_000;
  const created = await cdp.call<{ targetId: string }>(
    "Target.createTarget",
    {
      url: "about:blank",
      background: false,
      newWindow,
      ...(browserContextId ? { browserContextId } : {}),
    },
    undefined,
    deadline,
  );
  const attached = await cdp.call<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId: created.targetId, flatten: true },
    undefined,
    deadline,
  );
  const page = { sessionId: attached.sessionId };
  await Promise.all([
    cdp.call("Page.enable", {}, page.sessionId, deadline),
    cdp.call("Runtime.enable", {}, page.sessionId, deadline),
  ]);
  if (probe) {
    await cdp.call(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: probe },
      page.sessionId,
      deadline,
    );
  }
  await cdp.call("Page.navigate", { url }, page.sessionId, deadline);
  await waitForSample(
    (sampleDeadline) => evaluate(
      cdp,
      page,
      "document.readyState === 'complete'",
      sampleDeadline,
    ),
    Boolean,
    Math.max(1, deadline - Date.now()),
  );
  return page;
}

export async function evaluate<T>(
  cdp: CdpConnection,
  page: PageHandle,
  expression: string,
  deadline: number,
): Promise<T> {
  const value = await cdp.call<CdpResult<T>>(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    page.sessionId,
    deadline,
  );
  if (value.exceptionDetails) throw new Error("Browser evaluation failed");
  return value.result.value as T;
}

export async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Port reservation failed"));
        return;
      }
      server.close((error) =>
        error ? rejectPort(error) : resolvePort(address.port),
      );
    });
  });
}

// Readiness is the debugging endpoint, never the spawned process: Chrome's
// Windows launcher exits as soon as the browser process takes over the profile
// (measured: exit at ~140 ms, endpoint ready at ~440 ms). The deadline bounds
// the wait, and the launcher's exit code is reported when it runs out.
export async function waitForVersion(
  port: number,
  child: ChildProcessWithoutNullStreams,
): Promise<{ Browser: string; webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return await fetchJsonBefore<{ Browser: string; webSocketDebuggerUrl: string }>(
        `http://127.0.0.1:${port}/json/version`,
        deadline,
      );
    } catch {}
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Chrome startup timed out (exit ${child.exitCode ?? "running"})`);
}

export async function cleanupRun(
  resources: CleanupResources,
): Promise<CleanupResult> {
  if (resources.cdp) {
    try {
      await resources.cdp.call(
        "Browser.close",
        {},
        undefined,
        Date.now() + 2_000,
      );
    } catch {}
    resources.cdp.close();
  }
  const browserExited = resources.chrome
    ? await stopProcessTree(resources.chrome)
    : true;
  if (resources.native && processRunning(resources.native)) {
    try {
      resources.native.stdin.write("\n");
    } catch {}
  }
  const nativeExited = resources.native
    ? await stopProcessTree(resources.native)
    : true;
  const server = resources.server;
  let serverClosed = true;
  if (server && "close" in server) {
    try {
      await withDeadline(() => server.close(), Date.now() + 5_000);
    } catch {
      serverClosed = false;
    }
  } else if (server) {
    serverClosed = await stopProcessTree(server);
  }
  const portsClosed = await waitForPortsClosed(
    [...new Set(resources.ports)],
    5_000,
  );
  const profileRemoved = resources.profile
    ? await removeGateProfile(resources.profile)
    : true;
  return {
    browserExited,
    nativeExited,
    serverClosed,
    portsClosed,
    profileRemoved,
  };
}

function processRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function stopProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> {
  if (!processRunning(child)) return true;
  if (await waitForExit(child, 2_000)) return true;
  if (process.platform === "win32" && child.pid !== undefined) {
    await runBounded(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      5_000,
    );
  } else {
    child.kill("SIGTERM");
    if (await waitForExit(child, 2_000)) return true;
    child.kill("SIGKILL");
  }
  return waitForExit(child, 3_000);
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!processRunning(child)) return true;
  return new Promise<boolean>((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(!processRunning(child));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function runBounded(
  command: string,
  args: string[],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const child = spawn(command, args, {
    stdio: "pipe",
    windowsHide: true,
    env: environment,
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    const code = await withDeadline(
      () => new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", resolveExit);
      }),
      Date.now() + timeoutMs,
    );
    return code === 0;
  } catch {
    child.kill();
    return false;
  }
}

async function waitForPortsClosed(
  ports: number[],
  timeoutMs: number,
): Promise<boolean> {
  if (ports.length === 0) return true;
  try {
    await waitForSample(
      (deadline) => Promise.all(ports.map((port) => portClosed(port, deadline))),
      (closed) => closed.every(Boolean),
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

function portClosed(port: number, deadline: number): Promise<boolean> {
  return withDeadline(() => new Promise<boolean>((resolveClosed) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (closed: boolean) => {
      socket.destroy();
      resolveClosed(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  }), deadline);
}

export const profileCleanupScript = String.raw`
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($env:PIIK_GATE_PROFILE_TO_REMOVE)
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$parent = [IO.Path]::GetDirectoryName($root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$name = [IO.Path]::GetFileName($root)
if ($parent -ine $temp -or $name -notmatch '^piik-(access-privacy|client-loopback|client-media)-[A-Za-z0-9_-]{6}$') { exit 31 }
$rootEntries = @([IO.Directory]::EnumerateFileSystemEntries($parent, $name, [IO.SearchOption]::TopDirectoryOnly))
if ($rootEntries.Count -eq 0) { exit 0 }
if ($rootEntries.Count -ne 1) { exit 34 }
$root = $rootEntries[0]
$rootAttributes = [IO.File]::GetAttributes($root)
if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 32 }
if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) { exit 34 }
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
while ($pending.Count -gt 0) {
  $directory = $pending.Pop()
  $attributes = [IO.File]::GetAttributes($directory)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 32 }
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
    $attributes = [IO.File]::GetAttributes($entry)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 32 }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $pending.Push($entry) }
  }
}
Remove-Item -LiteralPath $root -Recurse -Force
$rootEntries = @([IO.Directory]::EnumerateFileSystemEntries($parent, $name, [IO.SearchOption]::TopDirectoryOnly))
if ($rootEntries.Count -ne 0) { exit 33 }
`;

export function isExactGateProfile(
  profile: string,
  systemTemp: string,
): boolean {
  const candidate = resolve(profile);
  const temp = resolve(systemTemp);
  const same = process.platform === "win32"
    ? dirname(candidate).toLowerCase() === temp.toLowerCase()
    : dirname(candidate) === temp;
  return same &&
    /^piik-(?:access-privacy|client-loopback|client-media)-[A-Za-z0-9_-]{6}$/.test(
      basename(candidate),
    );
}

async function removeGateProfile(profile: string): Promise<boolean> {
  if (!isExactGateProfile(profile, tmpdir())) return false;
  if (process.platform !== "win32") {
    const pending = [profile];
    try {
      while (pending.length > 0) {
        const current = pending.pop()!;
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) {
          pending.push(
            ...(await readdir(current)).map((name) => join(current, name)),
          );
        }
      }
      await rm(profile, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  return runBounded(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", profileCleanupScript],
    10_000,
    { ...process.env, PIIK_GATE_PROFILE_TO_REMOVE: profile },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
