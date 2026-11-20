import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PACKAGE_TARGETS, ANDROID_APP_PACKAGE_TARGET } from "../scripts/app-package-targets.mjs";
import { SERVER_PACKAGE_TARGETS } from "../scripts/server-package-targets.mjs";
import { readReleaseArtifacts } from "../scripts/release-artifacts.mjs";
import { signUpdateIndex } from "../scripts/release-update-index.mjs";

const signer = fileURLToPath(new URL("../scripts/release-update-index.mjs", import.meta.url));
const publisher = fileURLToPath(new URL("../scripts/publish-release.mjs", import.meta.url));
const version = "v3.0.0", revision = "a".repeat(40);
const keys = generateKeyPairSync("ed25519");
const pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicHex = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let root: string;

beforeEach(() => {
  vi.stubEnv("PIIK_UPDATE_SIGNING_KEY", pem);
  vi.stubEnv("PIIK_UPDATE_PUBLIC_KEY", publicHex);
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
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function run(output = "signed", identity = { version, revision }) {
  signUpdateIndex(root, identity.version, identity.revision, join(root, output));
}

function dryRun(privateKey: string) {
  return spawnSync(process.execPath, [publisher, root, version, revision, "--dry-run"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, PIIK_UPDATE_SIGNING_KEY: privateKey },
  });
}

describe("signed update index", () => {
  it("distributes only an index that verifies against the trust root and exact checked packages", () => {
    run();
    const options = { publicKey: publicHex };
    for (const name of ["update.json", "update.json.sig"]) copyFileSync(join(root, "signed", name), join(root, name));
    const release = readReleaseArtifacts(root, version, revision, options);
    expect(release.files).toHaveLength(11);
    expect(release.updateFiles.map((file: { name: string }) => file.name)).toEqual(["update.json", "update.json.sig"]);
    expect(release.packagesByTarget.size).toBe(9);
    expect(release.servers).toHaveLength(3);
    expect(() => readReleaseArtifacts(root, version, revision, { publicKey: "0".repeat(64) })).toThrow("signature mismatch");
    const altered = JSON.parse(readFileSync(join(root, "update.json"), "utf8"));
    altered.targets["windows-amd64"].artifact = "another.zip";
    const bytes = Buffer.from(JSON.stringify(altered));
    writeFileSync(join(root, "update.json"), bytes);
    writeFileSync(join(root, "update.json.sig"), sign(null, bytes, keys.privateKey));
    expect(() => readReleaseArtifacts(root, version, revision, options)).toThrow("differs from verified");
    rmSync(join(root, "update.json.sig"));
    expect(() => readReleaseArtifacts(root, version, revision, options)).toThrow("must both be present");
  });

  it("refuses unsigned updater publication", () => {
    const result = dryRun("");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PIIK_UPDATE_SIGNING_KEY");
    expect(existsSync(join(root, "signed-update"))).toBe(false);
  });

  it("prepares signed publisher metadata locally", () => {
    const first = dryRun(pem);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).files).toBe(11);
    expect(existsSync(join(root, "signed-update/update.json.sig"))).toBe(true);
  });

  it("reuses exact publisher metadata bytes without a private key", () => {
    run("signed-update");
    const bytes = readFileSync(join(root, "signed-update/update.json"));
    expect(dryRun("").status).toBe(0);
    expect(readFileSync(join(root, "signed-update/update.json"))).toEqual(bytes);
    expect(readReleaseArtifacts(root, version, revision).files).toHaveLength(9);
  });

  it("rejects altered publisher metadata", () => {
    run("signed-update");
    const bytes = readFileSync(join(root, "signed-update/update.json"));
    writeFileSync(join(root, "signed-update/update.json"), Buffer.concat([bytes, Buffer.from(" ")]));
    expect(dryRun(pem).stderr).toContain("signature mismatch");
  });

  it("signs the exact deterministic index bytes from verified target/package associations", () => {
    run();
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
    run("second");
    expect(readFileSync(join(root, "second/update.json"))).toEqual(bytes);
    expect(readFileSync(join(root, "second/update.json.sig"))).toEqual(signature);
    expect(() => run()).toThrow("EEXIST");
    expect(readFileSync(join(root, "signed/update.json"))).toEqual(bytes);
    expect(readFileSync(join(root, "signed/update.json.sig"))).toEqual(signature);
  });

  it("rejects a different release identity, missing target or changed package before creating output", () => {
    for (const identity of [{ version: "v3.0.1", revision }, { version, revision: "b".repeat(40) }]) {
      expect(() => run("signed", identity)).toThrow("Release identity mismatch");
    }
    const descriptor = join(root, "android-universal.release.json");
    const original = readFileSync(descriptor);
    rmSync(descriptor);
    expect(() => run()).toThrow("every registered Server and App target");
    writeFileSync(descriptor, original);
    writeFileSync(join(root, "windows-amd64.zip"), "changed bytes");
    expect(() => run()).toThrow("checksum mismatch");
    expect(existsSync(join(root, "signed"))).toBe(false);
  });

  it("requires the environment signing key to match the App trust root without exposing it", () => {
    vi.stubEnv("PIIK_UPDATE_SIGNING_KEY", "");
    expect(() => run()).toThrow("PIIK_UPDATE_SIGNING_KEY");
    vi.stubEnv("PIIK_UPDATE_SIGNING_KEY", pem);
    vi.stubEnv("PIIK_UPDATE_PUBLIC_KEY", "0".repeat(64));
    const mismatch = spawnSync(process.execPath, [signer, root, version, revision, join(root, "signed")], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("does not match");
    expect(mismatch.stdout + mismatch.stderr).not.toContain(pem);
    expect(existsSync(join(root, "signed"))).toBe(false);
  });
});
