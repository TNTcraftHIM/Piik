import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(join(tmpdir(), "piik-channel-browser-"));
const session = `channel-browser-${randomUUID().slice(0, 8)}`;
const executable = process.env.AGENT_BROWSER_PATH ?? (process.platform === "win32"
  ? join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe") : "agent-browser");
async function browser(...args) {
  const child = spawn(executable, ["--session", session, "--json", ...args], { windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const [code] = await once(child, "exit");
  child.stdout.destroy(); child.stderr.destroy();
  assert.equal(code, 0, stderr || stdout);
  const result = JSON.parse(stdout);
  assert(result.success, result.error);
  return result.data;
}
const web = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "prototype/channel-browser/vite.config.ts"], {
  env: { ...process.env, PIIK_BROWSER_ROOM_PORT: String(port) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "", result;
web.stdout.on("data", bytes => { serverOutput += bytes; });
web.stderr.on("data", bytes => { serverOutput += bytes; });
try {
  const deadline = Date.now() + 15_000;
  while (!await fetch(`${origin}/tests/browser.html`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)) {
    assert(web.exitCode === null && Date.now() < deadline, serverOutput);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await browser("--profile", profile, "open", `${origin}/tests/browser.html`);
  await browser("wait", "--fn", "typeof window.runBrowserRoomCheck === 'function'");
  result = (await browser("eval", "window.runBrowserRoomCheck()" )).result;
  assert(result?.passed, JSON.stringify(result));
  assert.deepEqual((await browser("errors")).errors, []);
} finally {
  try { await browser("close"); }
  finally {
    if (web.exitCode === null) { const exited = once(web, "exit"); web.kill(); await exited; }
    web.stdout.destroy(); web.stderr.destroy();
    assert(!relative(tmpdir(), profile).startsWith("..") && basename(profile).startsWith("piik-channel-browser-"));
    await rm(profile, { recursive: true, force: true });
  }
}
const cleanup = { browserClosed: true, serverClosed: web.exitCode !== null || web.signalCode !== null, profileRemoved: !existsSync(profile) };
await mkdir("build/channel-browser-check", { recursive: true });
await writeFile("build/channel-browser-check/result.json", JSON.stringify({ ...result, cleanup }, null, 2) + "\n");
console.log(JSON.stringify({ ...result, cleanup }, null, 2));
