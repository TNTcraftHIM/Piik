import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { reservePort, withDeadline } from "./browser-gate-harness";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "client-check");

interface GateResult {
  passed: boolean;
  paired: boolean;
  health: boolean;
  viewerPage: boolean;
  websocketUpgrade: boolean;
  hostExited: boolean;
  viewerExited: boolean;
  remoteBinaryRemoved: boolean;
  error: string | null;
  stage: string;
}

class LineCapture {
  readonly lines: string[] = [];
  private pending = "";
  private stderr = "";
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.pending += chunk.toString();
      for (;;) {
        const newline = this.pending.indexOf("\n");
        if (newline < 0) return;
        const line = this.pending.slice(0, newline).trim();
        this.pending = this.pending.slice(newline + 1);
        if (line) this.lines.push(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2_048);
    });
  }

  async wait(
    predicate: (line: string) => boolean,
    after = -1,
    timeoutMs = 30_000,
  ): Promise<{ line: string; index: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let index = after + 1; index < this.lines.length; index += 1) {
        const line = this.lines[index]!;
        if (predicate(line)) return { line, index };
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        const detail = this.stderr.trim();
        throw new Error(
          `Client exited before readiness (${String(this.child.exitCode)})` +
            (detail ? `: ${detail}` : ""),
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error("Client output timed out");
  }
}

function run(
  command: string,
  args: string[],
  cwd = ROOT,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `${command} failed`);
  }
  return result.stdout.trim();
}

function remoteOptions(): {
  host: string;
  user: string;
  key: string;
  ssh: string;
  scp: string;
} {
  const host = process.env.SCREENER_REMOTE_HOST?.trim();
  const key = process.env.SCREENER_REMOTE_SSH_KEY?.trim();
  if (!host || !key) {
    throw new Error("SCREENER_REMOTE_HOST and SCREENER_REMOTE_SSH_KEY are required");
  }
  return {
    host,
    key,
    user: process.env.SCREENER_REMOTE_USER?.trim() || "root",
    ssh: process.env.SCREENER_SSH?.trim() || "ssh",
    scp: process.env.SCREENER_SCP?.trim() || "scp",
  };
}

function transportArgs(key: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-i", key,
  ];
}

function localLANAddress(): string {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const privateAddress = addresses.find((address) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address),
  );
  if (!privateAddress) {
    throw new Error("A private LAN IPv4 address is required for the Client gate");
  }
  return privateAddress;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    await withDeadline(
      () => new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      Date.now() + timeoutMs,
    );
  } catch {
    return false;
  }
  return true;
}

async function stopChild(child: ChildProcessWithoutNullStreams | null): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.stdin.end();
  if (await waitForExit(child, 2_000)) return true;
  child.kill();
  if (await waitForExit(child, 5_000)) return true;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  }
  return waitForExit(child, 2_000);
}

async function createInvitation(port: number, password: string): Promise<string> {
  const origin = `http://localhost:${port}`;
  const access = await fetch(`${origin}/api/site-access`, {
    method: "POST",
    headers: { Authorization: `Bearer ${password}`, Origin: origin },
  });
  if (!access.ok) throw new Error("Local access authentication failed");
  const cookie = access.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Local access cookie was not issued");
  const room = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
    },
    body: JSON.stringify({ codeEntryPolicy: "open" }),
  });
  if (!room.ok) throw new Error("Local room creation failed");
  const value = await room.json() as { inviteUrl?: unknown };
  if (typeof value.inviteUrl !== "string") {
    throw new Error("Local room invitation was unavailable");
  }
  return value.inviteUrl;
}

async function main(): Promise<void> {
  if (process.env.SCREENER_CLIENT_PAIR_GATE !== "true") {
    throw new Error("SCREENER_CLIENT_PAIR_GATE=true is required");
  }
  const remote = remoteOptions();
  const destination = `${remote.user}@${remote.host}`;
  const transport = transportArgs(remote.key);
  const go = process.env.SCREENER_GO?.trim() || "go";
  const node = process.env.SCREENER_NODE?.trim() || process.execPath;
  const profile = await mkdtemp(join(tmpdir(), "screener-client-pair-"));
  const port = await reservePort();
  const clientConfig = join(profile, "client.json");
  const hostBinary = join(BUILD_ROOT, process.platform === "win32"
    ? "screener-client.exe"
    : "screener-client");
  const remoteBinary = join(BUILD_ROOT, "screener-client-linux-amd64");
  const remotePath = `/tmp/screener-client-pair-${randomBytes(8).toString("hex")}`;
  let host: ChildProcessWithoutNullStreams | null = null;
  let viewer: ChildProcessWithoutNullStreams | null = null;
  const result: GateResult = {
    passed: false,
    paired: false,
    health: false,
    viewerPage: false,
    websocketUpgrade: false,
    hostExited: false,
    viewerExited: false,
    remoteBinaryRemoved: false,
    error: null,
    stage: "setup",
  };
  await mkdir(BUILD_ROOT, { recursive: true });
  try {
    result.stage = "build";
    run(go, ["build", "-trimpath", "-o", hostBinary, "./cmd/screener-client"],
      join(ROOT, "native", "client"));
    run(go, ["build", "-trimpath", "-o", remoteBinary, "./cmd/screener-client"],
      join(ROOT, "native", "client"), {
        ...process.env,
        GOOS: "linux",
        GOARCH: "amd64",
        CGO_ENABLED: "0",
      });
    result.stage = "remote-copy";
    run(remote.scp, [...transport, remoteBinary, `${destination}:${remotePath}`]);
    run(remote.ssh, [...transport, destination, "chmod", "700", remotePath]);

    result.stage = "host-start";
    host = spawn(hostBinary, [
      "--pair-host",
      "--node", node,
      "--app", ROOT,
      "--config", clientConfig,
      "--port", String(port),
      "--lan-address", localLANAddress(),
    ], {
      cwd: ROOT,
      env: { ...process.env, SCREENER_CLIENT_GATE_NO_BROWSER: "true" },
      stdio: "pipe",
      windowsHide: true,
    });
    const hostOutput = new LineCapture(host);
    const endpointLine = await hostOutput.wait((line) => {
      try {
        const value = JSON.parse(line) as { url?: unknown };
        return typeof value.url === "string";
      } catch {
        return false;
      }
    });
    const passwordLine = await hostOutput.wait(
      (line) => line.startsWith("Local access password: "),
      endpointLine.index,
    );
    const password = passwordLine.line.slice("Local access password: ".length);
    const invitation = await createInvitation(port, password);
    const viewerPath = new URL(invitation).pathname;
    const prompt = await hostOutput.wait((line) => line === "Paste a Viewer invitation:");
    host.stdin.write(invitation + "\n");
    const offerMarker = await hostOutput.wait(
      (line) => line === "Send this offer to the Viewer:",
      prompt.index,
    );
    const offer = await hostOutput.wait(
      (line) => /^[A-Za-z0-9_-]{100,}$/.test(line),
      offerMarker.index,
    );

    result.stage = "viewer-start";
    viewer = spawn(remote.ssh, [
      ...transport,
      "-T",
      destination,
      "env",
      "SCREENER_CLIENT_GATE_NO_BROWSER=true",
      remotePath,
      "--pair-viewer",
    ], { stdio: "pipe", windowsHide: true });
    const viewerOutput = new LineCapture(viewer);
    const viewerPrompt = await viewerOutput.wait((line) => line === "Paste the Host offer:");
    viewer.stdin.write(offer.line + "\n");
    const answerMarker = await viewerOutput.wait(
      (line) => line === "Send this answer to the Host:",
      viewerPrompt.index,
    );
    const answer = await viewerOutput.wait(
      (line) => /^[A-Za-z0-9_-]{100,}$/.test(line),
      answerMarker.index,
    );
    host.stdin.write(answer.line + "\n");
    await Promise.all([
      hostOutput.wait((line) => line.startsWith("Viewer connected."), offerMarker.index),
      viewerOutput.wait((line) => line === "Paired room connected.", answer.index),
    ]);
    result.paired = true;

    result.stage = "remote-http";
    const health = run(remote.ssh, [
      ...transport,
      destination,
      "curl", "--fail", "--silent", `http://127.0.0.1:${port}/healthz`,
    ]);
    result.health = JSON.parse(health).status === "ok";
    const page = run(remote.ssh, [
      ...transport,
      destination,
      "curl", "--fail", "--silent", `http://127.0.0.1:${port}${viewerPath}`,
    ]);
    result.viewerPage = page.includes('<div id="root"></div>');

    result.stage = "remote-websocket";
    const websocketProbe = [
      'const net=require("node:net");',
      `const socket=net.connect(${port},"127.0.0.1",()=>socket.write(`,
      `"GET /signal HTTP/1.1\\r\\nHost: localhost:${port}\\r\\n` +
        `Origin: http://localhost:${port}\\r\\nUpgrade: websocket\\r\\n` +
        "Connection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n" +
        '"));',
      'let response="";',
      'socket.on("data",chunk=>{response+=chunk;',
      'if(response.includes("\\r\\n\\r\\n")){',
      'console.log(response.split("\\r\\n",1)[0]);socket.destroy();}});',
      'socket.setTimeout(2000,()=>{socket.destroy();process.exitCode=2;});',
    ].join("");
    const upgrade = run(remote.ssh, [
      ...transport,
      destination,
      `node -e '${websocketProbe}'`,
    ]);
    result.websocketUpgrade = upgrade.includes("101 Switching Protocols");
    result.passed = result.paired && result.health && result.viewerPage &&
      result.websocketUpgrade;
    if (!result.passed) throw new Error("paired control surface was incomplete");
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.stage = result.passed ? "cleanup" : result.stage;
    result.viewerExited = await stopChild(viewer);
    result.hostExited = await stopChild(host);
    try {
      run(remote.ssh, [...transport, destination, "rm", "-f", remotePath]);
      result.remoteBinaryRemoved = true;
    } catch {
      result.remoteBinaryRemoved = false;
    }
    await rm(profile, { recursive: true, force: true });
    result.passed = result.passed && result.hostExited && result.viewerExited &&
      result.remoteBinaryRemoved;
    if (!result.passed && result.error === null) result.error = "cleanup failed";
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
