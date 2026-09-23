#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resetBuildWorkspace } from "./build-workspace.mjs";

const [image, revision] = process.argv.slice(2);
if (process.argv.length !== 4 || !image || !/^[0-9a-f]{40}$/.test(revision ?? "")) {
  throw new Error("Usage: node scripts/check-container.mjs <local-image> <full-source-sha>");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = `piik-check-${randomUUID()}`;
const workspace = resetBuildWorkspace(root, "container-check", project);
const environment = { ...process.env, PIIK_IMAGE: image };
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
async function request(path, options) {
  const response = await fetch(`http://127.0.0.1:8787${path}`, {
    ...options, signal: AbortSignal.timeout(2_000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}
async function expectServices(sfu, natPrediction) {
  const capabilities = await (await request("/api/capabilities")).json();
  // Capability metadata is extensible. This gate checks configured services,
  // not the absence of other compatible capabilities.
  assert.equal(capabilities.sfu, sfu);
  assert.equal(capabilities.natPrediction, natPrediction);
}
async function binding(port) {
  const socket = createSocket("udp4");
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(1); // RFC 8489 Binding Request, no attributes.
  packet.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(packet, 8);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`STUN ${port} timed out`)), 2_000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      socket.once("error", finish);
      socket.once("message", (reply) => {
        try {
          assert.ok(reply.length >= 20);
          assert.equal(reply.readUInt16BE(0), 0x0101);
          assert.deepEqual(reply.subarray(4, 20), packet.subarray(4, 20));
          finish();
        } catch (error) { finish(error); }
      });
      socket.send(packet, port, "127.0.0.1", (error) => { if (error) finish(error); });
    });
  } finally { socket.close(); }
}

copyFileSync(join(root, "deploy/container/compose.yaml"), join(workspace, "compose.yaml"));
const sample = readFileSync(join(root, "deploy/container/.env.example"), "utf8");
writeFileSync(join(workspace, ".env"), sample);
try {
  const metadata = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(metadata.Config.User, "65532:65532");
  assert.equal(metadata.Config.Labels["org.opencontainers.image.revision"], revision);
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Architecture, "amd64");
  assert.match(compose("run", "--rm", "--no-deps", "piik", "--check-config"), /config=ok/);
  compose("up", "-d", "--pull", "never");
  await until(async () => assert.deepEqual(await (await request("/healthz")).json(), { status: "ok" }), "ready");
  await expectServices(false, false);
  assert.equal((await (await request("/api/site-access")).json()).required, false);
  const html = await (await request("/")).text();
  const asset = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  assert.ok(asset, "Server must embed the Web UI");
  const script = await (await request(asset)).text();
  assert.ok(script.includes(revision), "Web and Server must have the same source identity");
  await binding(3478);
  const room = await (await request("/api/rooms", {
    method: "POST", headers: { Origin: "https://share.example.com", "Content-Type": "application/json" },
    body: JSON.stringify({ codeEntryPolicy: "open" }),
  })).json();
  assert.match(room.roomId, /^[1-9][0-9]{3}$/);
  assert.ok(room.hostToken);
  const container = JSON.parse(docker("inspect", compose("ps", "-q", "piik")))[0];
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.ok(container.HostConfig.CapDrop.includes("ALL"));
  assert.ok(container.HostConfig.SecurityOpt.some((value) => value.startsWith("no-new-privileges")));

  // Recreate with optional services on the same persistent room volume.
  writeFileSync(join(workspace, ".env"), `${sample}\nSFU_UDP_PORT=7882\nSFU_PUBLIC_IP=127.0.0.1\nNAT_PREDICTION_ENABLED=true\nPIIK_DEBUG=server\n`);
  compose("up", "-d", "--force-recreate", "--pull", "never");
  await until(() => expectServices(true, true), "optional services");
  await request(`/api/rooms/${room.roomId}/access`, {
    method: "POST",
    headers: { Origin: "https://share.example.com", Authorization: `Bearer ${room.hostToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set-code-entry-policy", policy: "private" }),
  });
  for (const port of [3478, 3479, 3480]) await binding(port);
  compose("kill", "--signal", "SIGUSR1", "piik");
  const state = join(workspace, "state");
  mkdirSync(state);
  await until(() => {
    compose("cp", "piik:/home/nonroot/.", state);
    assert.ok(readdirSync(join(state, "logs")).some((name) => name.endsWith(".zip")));
  }, "diagnostic export");
  assert.equal(readFileSync(join(state, "rooms.sqlite")).subarray(0, 16).toString(), "SQLite format 3\0");
  compose("stop");
  const stopped = JSON.parse(docker("inspect", compose("ps", "-aq", "piik")))[0];
  assert.equal(stopped.State.ExitCode, 0, "SIGTERM must shut down cleanly");
  process.stdout.write("Container checks passed: P2P, embedded services, room persistence, diagnostics and shutdown.\n");
} catch (error) {
  try { process.stderr.write(`${compose("logs", "--no-color", "--tail", "60")}\n`); } catch { /* Startup may have failed. */ }
  throw error;
} finally {
  try { compose("down", "--volumes", "--remove-orphans"); }
  finally { rmSync(workspace, { recursive: true, force: true }); }
}
