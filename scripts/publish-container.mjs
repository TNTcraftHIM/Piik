#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readReleaseArtifacts } from "./release-artifacts.mjs";

const [image, directory, version, revision] = process.argv.slice(2);
if (process.argv.length !== 6 || !image) {
  throw new Error("Usage: node scripts/publish-container.mjs <local-image> <artifacts> <version> <full-SHA>");
}
const { files } = readReleaseArtifacts(directory, version, revision);
const server = files.find((file) => file.name.endsWith("-runtime.tar.gz"));
assert.ok(server, "Server archive is missing");
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
assert.equal(gh(`commits/${version}`).sha, revision, "Published source tag changed");
assert.equal(release.assets.find((asset) => asset.name === server.name)?.digest,
  `sha256:${server.sha256}`, "Container must wrap the published Server archive");

function verifyImage(reference) {
  const metadata = JSON.parse(run("docker", "image", "inspect", reference))[0];
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Architecture, "amd64");
  const labels = metadata.Config.Labels;
  assert.equal(labels["org.opencontainers.image.version"], version);
  assert.equal(labels["org.opencontainers.image.revision"], revision);
  assert.equal(labels["tv.piik.server.sha256"], server.sha256);
}
verifyImage(image);
const tag = `${destination}:${version}`;
let exists = true;
try { run("docker", "manifest", "inspect", tag); }
catch (error) {
  // Authentication/network failures are not evidence that a tag is absent.
  if (!/manifest unknown|no such manifest/i.test(String(error.stderr ?? ""))) throw error;
  exists = false;
}
if (exists) {
  run("docker", "pull", tag);
  verifyImage(tag);
  process.stdout.write(`${tag} already exists; retained without replacement.\n`);
} else {
  run("docker", "tag", image, tag);
  run("docker", "push", tag);
}
// Retrying an older release must never move latest backwards.
if (gh("releases/latest").tag_name === version) {
  run("docker", "tag", tag, `${destination}:latest`);
  run("docker", "push", `${destination}:latest`);
}
process.stdout.write(`Container publication complete: ${tag}\n`);
