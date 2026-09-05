import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { reservePort, withDeadline } from "./browser-gate-harness";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "client-check");

interface GateResult {
  passed: boolean;
  linkCreated: boolean;
  invitationUsesLink: boolean;
  remotePage: boolean;
  remoteWebSocket: boolean;
  clientExited: boolean;
  linkClosed: boolean;
  error: string | null;
  stage: string;
}

class LineCapture {
  readonly lines: string[] = [];
  private pending = "";
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
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
    timeoutMs = 45_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = this.lines.find(predicate);
      if (line) return line;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(
          `Client exited before readiness (${String(this.child.exitCode)})` +
            (this.stderr.trim() ? `: ${this.stderr.trim()}` : ""),
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
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
  };
}

function transportArgs(key: string): string[] {
  const bindAddress = process.env.SCREENER_REMOTE_BIND_ADDRESS?.trim();
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    ...(bindAddress ? ["-o", `BindAddress=${bindAddress}`] : []),
    "-i", key,
  ];
}

function localLANAddress(): string {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const address = addresses.find((value) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value),
  );
  if (!address) throw new Error("A private LAN IPv4 address is required");
  return address;
}

async function waitForRemotePage(
  ssh: string,
  transport: string[],
  destination: string,
  url: string,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = spawnSync(ssh, [
      ...transport,
      destination,
      "curl", "--fail", "--silent", url,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status === 0 && result.stdout.includes('<div id="root"></div>')) {
      return result.stdout;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("public Viewer page did not become reachable");
}

async function createInvitation(port: number, password: string): Promise<string> {
  const origin = `http://localhost:${port}`;
  const access = await fetch(`${origin}/api/site-access`, {
    method: "POST",
    headers: { Authorization: `Bearer ${password}`, Origin: origin },
  });
  const cookie = access.headers.get("set-cookie")?.split(";", 1)[0];
  if (!access.ok) throw new Error("Local access authentication failed");
  const room = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: origin,
    },
    body: JSON.stringify({ codeEntryPolicy: "open" }),
  });
  const value = await room.json() as { inviteUrl?: unknown };
  if (!room.ok || typeof value.inviteUrl !== "string") {
    throw new Error("Local room creation failed");
  }
  return value.inviteUrl;
}

async function stopClient(child: ChildProcessWithoutNullStreams | null): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.stdin.write("\n");
  try {
    await withDeadline(
      () => new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      Date.now() + 8_000,
    );
  } catch {
    child.kill();
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntilLinkCloses(origin: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/healthz`, { cache: "no-store" });
      if (!response.ok) return true;
    } catch {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function main(): Promise<void> {
  if (process.env.SCREENER_CLIENT_LINK_GATE !== "true") {
    throw new Error("SCREENER_CLIENT_LINK_GATE=true is required");
  }
  const remote = remoteOptions();
  const transport = transportArgs(remote.key);
  const destination = `${remote.user}@${remote.host}`;
  const go = process.env.SCREENER_GO?.trim() || "go";
  const configuredClient = process.env.SCREENER_CLIENT_EXE?.trim();
  const node = process.env.SCREENER_CLIENT_NODE?.trim() || process.execPath;
  const app = process.env.SCREENER_CLIENT_APP?.trim() || ROOT;
  const tunnel = process.env.SCREENER_CLOUDFLARED?.trim() ||
    join(BUILD_ROOT, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const profile = await mkdtemp(join(tmpdir(), "screener-client-link-"));
  const port = await reservePort();
  const clientBinary = configuredClient || join(
    BUILD_ROOT,
    process.platform === "win32" ? "screener-client.exe" : "screener-client",
  );
  let client: ChildProcessWithoutNullStreams | null = null;
  let publicOrigin = "";
  const result: GateResult = {
    passed: false,
    linkCreated: false,
    invitationUsesLink: false,
    remotePage: false,
    remoteWebSocket: false,
    clientExited: false,
    linkClosed: false,
    error: null,
    stage: "setup",
  };
  await mkdir(BUILD_ROOT, { recursive: true });
  try {
    result.stage = "build";
    if (!configuredClient) {
      run(go, ["build", "-trimpath", "-o", clientBinary, "./cmd/screener-client"],
        join(ROOT, "native", "client"));
    }
    result.stage = "client-start";
    client = spawn(clientBinary, [
      "--link",
      "--node", node,
      "--app", app,
      "--config", join(profile, "client.json"),
      "--port", String(port),
      "--lan-address", localLANAddress(),
      "--tunnel-process", tunnel,
    ], {
      cwd: ROOT,
      env: { ...process.env, SCREENER_CLIENT_GATE_NO_BROWSER: "true" },
      stdio: "pipe",
      windowsHide: true,
    });
    const output = new LineCapture(client);
    const accessLine = await output.wait(
      (line) => line.startsWith("Local access password: ") || line === "Local access: open",
    );
    const originLine = await output.wait(
      (line) => line.startsWith("Public invitation origin: "),
    );
    publicOrigin = originLine.slice("Public invitation origin: ".length);
    result.linkCreated = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(publicOrigin);
    const invitation = await createInvitation(
      port,
      accessLine.startsWith("Local access password: ")
        ? accessLine.slice("Local access password: ".length)
        : "",
    );
    const invite = new URL(invitation);
    result.invitationUsesLink = invite.origin === publicOrigin && /^#v=/.test(invite.hash);

    result.stage = "remote-page";
    const page = await waitForRemotePage(
      remote.ssh,
      transport,
      destination,
      invitation.split("#", 1)[0]!,
    );
    result.remotePage = page.includes('<div id="root"></div>');

    result.stage = "remote-websocket";
    const websocketProbe = [
      "curl --http1.1 --include --silent --no-buffer --max-time 5",
      `--header ${JSON.stringify(`Origin:${publicOrigin}`)}`,
      `--header ${JSON.stringify("Upgrade:websocket")}`,
      `--header ${JSON.stringify("Connection:Upgrade")}`,
      `--header ${JSON.stringify("Sec-WebSocket-Version:13")}`,
      `--header ${JSON.stringify("Sec-WebSocket-Key:dGhlIHNhbXBsZSBub25jZQ==")}`,
      JSON.stringify(new URL("/signal", publicOrigin).toString()),
      "2>/dev/null || true",
    ].join(" ");
    const websocketDeadline = Date.now() + 20_000;
    while (Date.now() < websocketDeadline && !result.remoteWebSocket) {
      const upgrade = run(remote.ssh, [
        ...transport,
        destination,
        websocketProbe,
      ]);
      result.remoteWebSocket = upgrade.includes("101 Switching Protocols");
      if (!result.remoteWebSocket) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    result.passed = result.linkCreated && result.invitationUsesLink &&
      result.remotePage && result.remoteWebSocket;
    if (!result.passed) throw new Error("one-link control path was incomplete");
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.stage = result.passed ? "cleanup" : result.stage;
    result.clientExited = await stopClient(client);
    result.linkClosed = publicOrigin ? await waitUntilLinkCloses(publicOrigin) : true;
    await rm(profile, { recursive: true, force: true });
    result.passed = result.passed && result.clientExited && result.linkClosed;
    if (!result.passed && result.error === null) result.error = "cleanup failed";
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  if (!result.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
