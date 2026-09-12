import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function readReleaseArtifacts(directory, version, revision) {
  if (!directory || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") ||
      !/^[0-9a-f]{40}$/.test(revision ?? "")) {
    throw new Error("An artifact directory, stable version and full source SHA are required");
  }
  const root = resolve(directory);
  const files = new Map();
  const targets = new Set();
  function asset(name) {
    if (typeof name !== "string" || basename(name) !== name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error("Release asset name is invalid");
    }
    const path = join(root, name);
    if (!files.has(name)) {
      const bytes = readFileSync(path);
      files.set(name, { name, path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    return files.get(name);
  }
  for (const name of readdirSync(root).filter((name) => name.endsWith(".release.json"))) {
    const descriptor = JSON.parse(readFileSync(asset(name).path, "utf8"));
    if (descriptor.schema !== 2 || descriptor.version !== version || descriptor.revision !== revision) {
      throw new Error(`Release identity mismatch: ${name}`);
    }
    const target = descriptor.target ?? "server";
    if (targets.has(target)) throw new Error(`Duplicate release target: ${target}`);
    targets.add(target);
    if (asset(descriptor.artifact).sha256 !== descriptor.artifactSha256) {
      throw new Error(`Release artifact checksum mismatch: ${name}`);
    }
    if (target === "server") {
      if (asset(descriptor.manifest).sha256 !== descriptor.manifestSha256) {
        throw new Error("Server manifest checksum mismatch");
      }
    } else if (readFileSync(asset(`${descriptor.artifact}.sha256`).path, "utf8").trim() !==
        `${descriptor.artifactSha256}  ${descriptor.artifact}`) {
      throw new Error(`App checksum file mismatch: ${target}`);
    }
  }
  const expected = ["server", "windows-amd64", "linux-amd64", "darwin-arm64"];
  if (targets.size !== expected.length || expected.some((target) => !targets.has(target))) {
    throw new Error("Publication requires one matching Server and every App target");
  }
  return { files: [...files.values()], targets: [...targets] };
}
