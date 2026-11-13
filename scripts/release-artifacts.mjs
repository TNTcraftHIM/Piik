import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { APP_PACKAGE_TARGETS, ANDROID_APP_PACKAGE_TARGET } from "./app-package-targets.mjs";
import { SERVER_PACKAGE_TARGETS } from "./server-package-targets.mjs";

export function updateIndex(release) {
  return { schema: 1, version: release.version, revision: release.revision,
    targets: Object.fromEntries([...release.packagesByTarget].sort(([a], [b]) => a.localeCompare(b)).map(([target, asset]) =>
      [target, { artifact: asset.name, size: asset.size, sha256: asset.sha256 }])) };
}

export function readUpdateArtifacts(release, directory, publicKey = process.env.PIIK_UPDATE_PUBLIC_KEY) {
  const paths = ["update.json", "update.json.sig"].map(name => join(resolve(directory), name));
  const present = paths.map(path => existsSync(path));
  if (!present.some(Boolean)) return release;
  if (!present.every(Boolean)) throw new Error("Update index and signature must both be present");
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey ?? "")) throw new Error("PIIK_UPDATE_PUBLIC_KEY must contain the trusted 32-byte public key as hex");
  const [bytes, signature] = paths.map(path => readFileSync(path));
  const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "hex").toString("base64url") } });
  if (signature.length !== 64 || !verify(null, bytes, key, signature)) throw new Error("Update index signature mismatch");
  if (!isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), updateIndex(release))) throw new Error("Update index differs from verified release artifacts");
  const updateFiles = paths.map((path, index) => ({ name: basename(path), path,
    size: [bytes, signature][index].length, sha256: createHash("sha256").update([bytes, signature][index]).digest("hex") }));
  return { ...release, files: [...release.packagesByTarget.values(), ...updateFiles], updateFiles };
}

// Both publishers recover the original public bytes; only the caller chooses their directory.
export async function recoverUpdateArtifacts(release, sourceAssets, repository, directory) {
  const updates = sourceAssets.filter(asset => ["update.json", "update.json.sig"].includes(asset.name));
  if (!updates.length) return release;
  if (updates.length !== 2 || new Set(updates.map(asset => asset.name)).size !== 2) throw new Error("Published update metadata is incomplete");
  release = readUpdateArtifacts(release, directory);
  if (!release.updateFiles.length) {
    const downloads = [];
    for (const asset of updates) {
      const url = `https://github.com/${repository}/releases/download/${release.version}/${asset.name}`;
      const limit = asset.name === "update.json.sig" ? 64 : 1024 * 1024;
      if (asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit ||
          !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") || asset.browser_download_url !== url) {
        throw new Error("GitHub update attachment metadata mismatch");
      }
      // Public attachments may redirect to a CDN; no credentials are sent.
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error("GitHub update attachment is unavailable");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > asset.size) throw new Error("GitHub update attachment size mismatch");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (size !== asset.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) {
        throw new Error("GitHub update attachment checksum mismatch");
      }
      downloads.push({ path: join(directory, asset.name), bytes });
    }
    mkdirSync(directory, { recursive: true });
    const created = [];
    try {
      for (const download of downloads) {
        const fd = openSync(download.path, "wx");
        created.push(download.path);
        try { writeFileSync(fd, download.bytes); }
        finally { closeSync(fd); }
      }
      release = readUpdateArtifacts(release, directory);
    } catch (error) {
      for (const path of created) rmSync(path);
      throw error;
    }
  }
  if (release.updateFiles.some(file => !updates.some(asset => asset.name === file.name &&
      asset.state === "uploaded" && asset.size === file.size && asset.digest === `sha256:${file.sha256}`))) {
    throw new Error("Published update metadata differs from verified local metadata");
  }
  return release;
}

export function readReleaseArtifacts(directory, version, revision, { publicKey = process.env.PIIK_UPDATE_PUBLIC_KEY, updateDirectory = directory } = {}) {
  if (!directory || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") ||
      !/^[0-9a-f]{40}$/.test(revision ?? "")) {
    throw new Error("An artifact directory, stable version and full source SHA are required");
  }
  const root = resolve(directory);
  const files = new Map();
  const packages = [];
  const servers = [];
  const targets = new Set();
  const packagesByTarget = new Map();
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
    const archive = asset(descriptor.artifact);
    if (archive.sha256 !== descriptor.artifactSha256) {
      throw new Error(`Release artifact checksum mismatch: ${name}`);
    }
    packages.push(archive);
    packagesByTarget.set(target, archive);
    const serverTarget = SERVER_PACKAGE_TARGETS.find(candidate => candidate.id === target);
    if (serverTarget) {
      if (asset(descriptor.manifest).sha256 !== descriptor.manifestSha256) {
        throw new Error("Server manifest checksum mismatch");
      }
      servers.push({ ...archive, arch: serverTarget.goarch, goos: serverTarget.goos });
    } else if (readFileSync(asset(`${descriptor.artifact}.sha256`).path, "utf8").trim() !==
        `${descriptor.artifactSha256}  ${descriptor.artifact}`) {
      throw new Error(`App checksum file mismatch: ${target}`);
    }
  }
  const expected = [...SERVER_PACKAGE_TARGETS, ...APP_PACKAGE_TARGETS, ANDROID_APP_PACKAGE_TARGET].map(target => target.id);
  if (targets.size !== expected.length || expected.some((target) => !targets.has(target))) {
    throw new Error("Publication requires every registered Server and App target");
  }
  // Build sidecars stay local; verified update metadata is distributed unchanged.
  return readUpdateArtifacts({ version, revision, files: packages, servers, targets: [...targets], packagesByTarget, updateFiles: [] }, updateDirectory, publicKey);
}
