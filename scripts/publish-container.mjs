#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readReleaseArtifacts } from "./release-artifacts.mjs";

const [image, directory, version, revision] = process.argv.slice(2);
if (process.argv.length !== 6 || !image) {
  throw new Error("Usage: node scripts/publish-container.mjs <local-image-prefix> <artifacts> <version> <full-SHA>");
}
const { servers } = readReleaseArtifacts(directory, version, revision);
const repository = process.env.GITHUB_REPOSITORY || "TNTcraftHIM/Piik";
const destination = `ghcr.io/${repository.toLowerCase()}`;
const run = (command, ...args) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000,
}).trim();
const gh = (path) => JSON.parse(run("gh", "api", `repos/${repository}/${path}`));
const release = gh(`releases/tags/${version}`);
assert.equal(release.draft, false, "Container publication requires a published GitHub release");
assert.equal(release.prerelease, false);
assert.equal(release.target_commitish, revision);
assert.equal(run("gh", "api", `repos/${repository}/commits/${version}`,
  "--header", "Accept: application/vnd.github.sha"), revision, "Published source tag changed");
for (const server of servers) {
  assert.equal(release.assets.find((asset) => asset.name === server.name)?.digest,
    `sha256:${server.sha256}`, "Container must wrap the published Server archive");
}

function verifyImage(reference, server) {
  const metadata = JSON.parse(run("docker", "image", "inspect", reference))[0];
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Architecture, server.arch);
  const labels = metadata.Config.Labels;
  assert.equal(labels["org.opencontainers.image.version"], version);
  assert.equal(labels["org.opencontainers.image.revision"], revision);
  assert.equal(labels["tv.piik.server.sha256"], server.sha256);
}
const tag = `${destination}:${version}`;
function manifest(reference) {
  try { return JSON.parse(run("docker", "manifest", "inspect", reference)); }
  catch (error) {
    // Authentication/network failures are not evidence that a tag is absent.
    if (!/manifest unknown|no such manifest/i.test(String(error.stderr ?? ""))) throw error;
    return null;
  }
}

function verifyIndex(reference, index) {
  assert.deepEqual(index.manifests.map(item => `${item.platform.os}/${item.platform.architecture}`).sort(),
    servers.map(server => `linux/${server.arch}`).sort(), "Container platforms differ from the release");
  for (const server of servers) {
    run("docker", "pull", "--platform", `linux/${server.arch}`, reference);
    verifyImage(reference, server);
  }
}

for (const server of servers) verifyImage(`${image}-${server.arch}`, server);
const existing = manifest(tag);
if (existing) {
  verifyIndex(tag, existing);
  process.stdout.write(`${tag} already exists; retained without replacement.\n`);
} else {
  const parts = servers.map(server => ({ server, tag: `${tag}-${server.arch}` }));
  // Validate every existing platform before publishing any missing sibling.
  for (const part of parts) {
    part.exists = manifest(part.tag) !== null;
    if (part.exists) {
      run("docker", "pull", "--platform", `linux/${part.server.arch}`, part.tag);
      verifyImage(part.tag, part.server);
    }
  }
  for (const part of parts) {
    if (part.exists) continue;
    run("docker", "tag", `${image}-${part.server.arch}`, part.tag);
    run("docker", "push", part.tag);
  }
  run("docker", "buildx", "imagetools", "create", "--tag", tag, ...parts.map(part => part.tag));
  verifyIndex(tag, manifest(tag));
}
// Retrying an older release must never move latest backwards.
if (gh("releases/latest").tag_name === version) {
  run("docker", "buildx", "imagetools", "create", "--tag", `${destination}:latest`, tag);
  verifyIndex(`${destination}:latest`, manifest(`${destination}:latest`));
}
process.stdout.write(`Container publication complete: ${tag}\n`);
