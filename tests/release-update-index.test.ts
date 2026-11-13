import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_PACKAGE_TARGETS, ANDROID_APP_PACKAGE_TARGET } from "../scripts/app-package-targets.mjs";
import { SERVER_PACKAGE_TARGETS } from "../scripts/server-package-targets.mjs";
import { readReleaseArtifacts } from "../scripts/release-artifacts.mjs";

const signer = fileURLToPath(new URL("../scripts/release-update-index.mjs", import.meta.url));
const version = "v3.0.0", revision = "a".repeat(40);
const keys = generateKeyPairSync("ed25519");
const pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicHex = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "piik-update-index-"));
  for (const target of [...SERVER_PACKAGE_TARGETS, ...APP_PACKAGE_TARGETS, ANDROID_APP_PACKAGE_TARGET]) {
    const server = SERVER_PACKAGE_TARGETS.some(candidate => candidate.id === target.id);
    const artifact = `${target.id}.${target.id === "android-universal" ? "apk" : "zip"}`;
    writeFileSync(join(root, artifact), target.id);
    writeFileSync(join(root, `${target.id}.release.json`), JSON.stringify({
      schema: 2, version, revision, target: target.id, artifact, artifactSha256: sha(target.id),
      ...(server ? { manifest: `${target.id}.manifest.tsv`, manifestSha256: sha("manifest") } : {}),
    }));
    if (server) writeFileSync(join(root, `${target.id}.manifest.tsv`), "manifest");
    else writeFileSync(join(root, `${artifact}.sha256`), `${sha(target.id)}  ${artifact}\n`);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(output = "signed", identity = { version, revision }, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [signer, root, identity.version, identity.revision, join(root, output)], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, PIIK_UPDATE_SIGNING_KEY: pem, PIIK_UPDATE_PUBLIC_KEY: publicHex, ...environment },
  });
}

describe("signed update index", () => {
  it("signs the exact deterministic index bytes from verified target/package associations", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, "signed")).sort()).toEqual(["update.json", "update.json.sig"]);
    const bytes = readFileSync(join(root, "signed/update.json"));
    const signature = readFileSync(join(root, "signed/update.json.sig"));
    expect(signature.length).toBe(64);
    expect(verify(null, bytes, keys.publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.concat([bytes, Buffer.from(" ")]), keys.publicKey, signature)).toBe(false);
    const index = JSON.parse(bytes.toString("utf8"));
    const release = readReleaseArtifacts(root, version, revision);
    expect(index).toEqual({ schema: 1, version, revision, targets: Object.fromEntries(
      [...release.packagesByTarget].map(([target, asset]) => [target,
        { artifact: asset.name, size: asset.size, sha256: asset.sha256 }]),
    ) });
    expect(Object.keys(index.targets)).toEqual([...release.targets].sort());
    expect(release.files).toHaveLength(9);
    expect(release.servers).toHaveLength(3);
    expect(run("second").status).toBe(0);
    expect(readFileSync(join(root, "second/update.json"))).toEqual(bytes);
    expect(readFileSync(join(root, "second/update.json.sig"))).toEqual(signature);
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(root, "signed/update.json"))).toEqual(bytes);
    expect(readFileSync(join(root, "signed/update.json.sig"))).toEqual(signature);
  });

  it("rejects a different release identity, missing target or changed package before creating output", () => {
    for (const identity of [{ version: "v3.0.1", revision }, { version, revision: "b".repeat(40) }]) {
      expect(run("signed", identity).stderr).toContain("Release identity mismatch");
    }
    const descriptor = join(root, "android-universal.release.json");
    const original = readFileSync(descriptor);
    rmSync(descriptor);
    expect(run().stderr).toContain("every registered Server and App target");
    writeFileSync(descriptor, original);
    writeFileSync(join(root, "windows-amd64.zip"), "changed bytes");
    expect(run().stderr).toContain("checksum mismatch");
    expect(existsSync(join(root, "signed"))).toBe(false);
  });

  it("requires the environment signing key to match the App trust root without exposing it", () => {
    const missing = run("signed", undefined, { PIIK_UPDATE_SIGNING_KEY: "" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("PIIK_UPDATE_SIGNING_KEY");
    const mismatch = run("signed", undefined, { PIIK_UPDATE_PUBLIC_KEY: "0".repeat(64) });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match");
    expect(mismatch.stdout + mismatch.stderr).not.toContain(pem);
    expect(existsSync(join(root, "signed"))).toBe(false);
  });
});
