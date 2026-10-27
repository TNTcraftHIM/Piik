// Finite acceptance owns its loopback services and shuts them down on exit.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const corePort = await freePort(), uiPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`;
const env = { ...process.env, PIIK_CHANNEL_PORT: String(corePort), PIIK_CHANNEL_UI_PORT: String(uiPort),
  PIIK_CHANNEL_WEB_ORIGIN: origin, CHANNEL_UI_ORIGIN: origin, PIIK_CHANNEL_DATA_DIR: ":memory:",
  PIIK_CHANNEL_OWNER_KEY: randomUUID(), PIIK_CHANNEL_INVITE_KEY: randomUUID() };
const children = [];
function start(command, args) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("error", error => { output += String(error); });
  children.push(child);
  return { child, output: () => output };
}
async function ready(process, url) {
  for (let index = 0; index < 100; index++) {
    if (await fetch(url).then(response => response.ok).catch(() => false)) return;
    if (process.child.exitCode !== null) throw new Error(process.output());
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Acceptance service did not become ready: ${process.output()}`);
}
try {
  const core = start(resolve(`prototype/channel-server/target/debug/piik-channel-prototype${process.platform === "win32" ? ".exe" : ""}`), []);
  await ready(core, `http://127.0.0.1:${corePort}/healthz`);
  const web = start(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "prototype/channel-server/vite.config.ts"]);
  await ready(web, origin);
  const check = spawn(process.execPath, ["prototype/channel-server/browser-acceptance.mjs", ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: "inherit", timeout: 300_000,
  });
  children.push(check);
  const [code] = await once(check, "exit");
  if (code !== 0) process.exitCode = 1;
} finally {
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}
