#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resetBuildWorkspace } from "./build-workspace.mjs";
import { checkWebSourceIdentity } from "./container-web-identity.mjs";

const [image, revision] = process.argv.slice(2);
if (process.argv.length !== 4 || !image || !/^[0-9a-f]{40}$/.test(revision ?? "")) {
  throw new Error("Usage: node scripts/check-container.mjs <local-image> <full-source-sha>");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = `piik-check-${randomUUID()}`;
const workspace = resetBuildWorkspace(root, "container-check", project);
const origin = "https://share.example.com";
const ownerKey = randomUUID();
const inviteKey = randomUUID();
const environment = { ...process.env, PIIK_IMAGE: image,
  PIIK_CHANNEL_OWNER_KEY: ownerKey, PIIK_CHANNEL_INVITE_KEY: inviteKey };
function docker(...args) {
  return execFileSync("docker", args, {
    cwd: workspace, env: environment, encoding: "utf8", timeout: 90_000,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
}
function compose(...args) {
  return docker("compose", "--project-name", project, "--file", "compose.yaml", ...args);
}
async function until(check, label) {
  const deadline = Date.now() + 20_000;
  let failure;
  do {
    try { return await check(); } catch (error) { failure = error; }
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`Container check timed out: ${label}`, { cause: failure });
}
async function request(path) {
  const response = await fetch(`http://127.0.0.1:8787${path}`, { signal: AbortSignal.timeout(2_000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}
async function rooms() {
  const socket = new WebSocket("ws://127.0.0.1:8787/prototype/channel", { origin });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Server rooms did not become available")), 10_000);
      socket.once("error", reject);
      socket.once("open", () => {
        const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
        socket.send(JSON.stringify({ type: "join", name: "Container check", key: ownerKey,
          signingKey: [...Buffer.from(publicKey.x, "base64url")] }));
      });
      socket.on("message", bytes => {
        try {
          const event = JSON.parse(bytes.toString());
          assert.notEqual(event.type, "error", event.code);
          if (!["welcome", "state"].includes(event.type)) return;
          const { channel } = event.state;
          if (channel.rooms.length === 3 && channel.rooms.every(room => room.available)) {
            resolve({ channelId: channel.id, roomIds: channel.rooms.map(room => room.id).sort() });
          }
        } catch (error) { reject(error); }
      });
    });
  } finally { clearTimeout(timer); socket.terminate(); }
}

copyFileSync(join(root, "deploy/container/compose.yaml"), join(workspace, "compose.yaml"));
const sample = readFileSync(join(root, "deploy/container/.env.example"), "utf8");
writeFileSync(join(workspace, ".env"), sample
  .replace(/^PIIK_CHANNEL_OWNER_KEY=$/m, `PIIK_CHANNEL_OWNER_KEY=${ownerKey}`)
  .replace(/^PIIK_CHANNEL_INVITE_KEY=$/m, `PIIK_CHANNEL_INVITE_KEY=${inviteKey}`));
try {
  const metadata = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(metadata.Config.User, "65532:65532");
  assert.equal(metadata.Config.Labels["org.opencontainers.image.revision"], revision);
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Architecture, process.arch === "x64" ? "amd64" : process.arch);
  assert.ok(["amd64", "arm64"].includes(metadata.Architecture));
  compose("config", "--quiet");
  compose("up", "-d", "--pull", "never");
  await until(async () => assert.equal(await (await request("/healthz")).text(), "piik-channel-prototype"), "ready");
  const html = await (await request("/")).text();
  await checkWebSourceIdentity(html, revision, async asset => (await request(asset)).text());
  const initial = await rooms();
  const container = JSON.parse(docker("inspect", compose("ps", "-q", "piik")))[0];
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.ok(container.HostConfig.CapDrop.includes("ALL"));
  assert.ok(container.HostConfig.SecurityOpt.some(value => value.startsWith("no-new-privileges")));

  compose("up", "-d", "--force-recreate", "--pull", "never");
  await until(async () => assert.equal(await (await request("/healthz")).text(), "piik-channel-prototype"), "restart");
  assert.deepEqual(await rooms(), initial, "Recreated Server must reopen its persistent rooms");
  compose("stop");
  const stopped = JSON.parse(docker("inspect", compose("ps", "-aq", "piik")))[0];
  assert.equal(stopped.State.ExitCode, 0, "SIGTERM must shut down cleanly");
  const state = join(workspace, "state");
  mkdirSync(state);
  compose("cp", "piik:/home/nonroot/.", state);
  for (const file of ["channel.sqlite", ...initial.roomIds.map(id => `rooms/${id}.sqlite`)]) {
    assert.equal(readFileSync(join(state, file)).subarray(0, 16).toString(), "SQLite format 3\0");
  }
  process.stdout.write("Container checks passed: shared frontend, authenticated Native rooms, persistence and shutdown.\n");
} catch (error) {
  try { process.stderr.write(`${compose("logs", "--no-color", "--tail", "60")}\n`); } catch { /* Startup may have failed. */ }
  throw error;
} finally {
  try { compose("down", "--volumes", "--remove-orphans"); }
  finally { rmSync(workspace, { recursive: true, force: true }); }
}
