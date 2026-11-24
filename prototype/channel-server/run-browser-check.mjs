// Finite acceptance owns its loopback services and shuts them down on exit.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { freeUdpPort } from "./acceptance-udp-port.mjs";

async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const corePort = await freePort(), uiPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`;
const protocolOnly = process.argv.includes("--protocol");
const directory = await mkdtemp(join(tmpdir(), "piik-room-host-check-"));
const env = { ...process.env, PIIK_CHANNEL_PORT: String(corePort), PIIK_CHANNEL_UI_PORT: String(uiPort),
  PIIK_CHANNEL_WEB_DIR: resolve(process.env.PIIK_CHANNEL_WEB_DIR ?? "build/channel-web"),
  PIIK_CHANNEL_VITE_CACHE_DIR: join(directory, "vite-cache"),
  PIIK_CHANNEL_ICE_SERVERS: "[]",
  PIIK_CHANNEL_HOSTING_MODE: "lightweight",
  PIIK_CHANNEL_ROOM_CREATION_POLICY: "ordinary",
  PIIK_CHANNEL_WEB_ORIGIN: origin, CHANNEL_UI_ORIGIN: origin, PIIK_CHANNEL_DATA_DIR: directory,
  CHANNEL_WS_URL: `ws://127.0.0.1:${corePort}/prototype/channel`,
  CHANNEL_DATA_FILE: join(directory, "channel.sqlite"),
  PIIK_CHANNEL_OWNER_KEY: randomUUID() };
const children = [];
const services = [];
function redact(value) {
  return value.replaceAll(env.PIIK_CHANNEL_OWNER_KEY, "[owner key]");
}
function start(command, args, own = {}) {
  const child = spawn(command, args, { env: { ...env, ...own }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = chunk => { output = (output + chunk).slice(-65536); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", error => { append(String(error)); });
  children.push(child);
  const service = { child, output: () => redact(output) };
  services.push(service);
  return service;
}
async function ready(process, url) {
  const signal = AbortSignal.timeout(10_000);
  while (!signal.aborted) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) throw new Error(process.output());
    if (await fetch(url, { signal }).then(response => response.ok).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Acceptance service did not become ready: ${process.output()}`);
}
try {
  const core = start(resolve(process.env.CHANNEL_EXECUTABLE ?? `prototype/channel-server/target/debug/piik-channel-prototype${process.platform === "win32" ? ".exe" : ""}`), [],
    { PIIK_CHANNEL_UDP_PORT: String(await freeUdpPort()) });
  await ready(core, `http://127.0.0.1:${corePort}/healthz`);
  if (!protocolOnly) {
    const web = start(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "prototype/channel-server/vite.config.ts"]);
    await ready(web, origin);
  }
  const check = spawn(process.execPath, protocolOnly ? ["--import", "tsx", "--test", "prototype/channel-server/check.mjs"]
    : ["prototype/channel-server/browser-acceptance.mjs", ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: "inherit", timeout: 300_000,
  });
  children.push(check);
  const [code] = await once(check, "exit");
  if (code !== 0) {
    process.exitCode = 1;
    for (const service of services) console.error(`Acceptance service exit=${service.child.exitCode} signal=${service.child.signalCode}\n${service.output()}`);
  }
} finally {
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  if (relative(tmpdir(), directory).startsWith("..") || !basename(directory).startsWith("piik-room-host-check-")) {
    throw new Error("Unexpected acceptance data directory");
  }
  await rm(directory, { recursive: true, force: true });
}
