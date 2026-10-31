import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageAndroidRelease } from "../scripts/package-android-release.mjs";
import { extractZip } from "../scripts/archive-tool.mjs";
import { readReleaseArtifacts } from "../scripts/release-artifacts.mjs";
import { APP_PACKAGE_TARGETS, ANDROID_APP_PACKAGE_TARGET } from "../scripts/app-package-targets.mjs";
import { SERVER_PACKAGE_TARGETS } from "../scripts/server-package-targets.mjs";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("Android signed package distributions", () => {
  it("wraps only the unchanged APK, validates both distributions and retains old descriptors", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-android-distribution-"));
    const output = join(root, "output"), extracted = join(root, "extracted");
    const version = "v2.5.1", revision = "a".repeat(40);
    try {
      const apk = join(root, "signed.apk");
      writeFileSync(apk, "signed APK fixture bytes");
      const descriptor = packageAndroidRelease(apk, output, version, revision);
      mkdirSync(extracted);
      extractZip(join(output, descriptor.mirrorArtifact), extracted);
      expect(readdirSync(extracted)).toEqual([descriptor.artifact]);
      expect(hash(readFileSync(join(extracted, descriptor.artifact)))).toBe(hash(readFileSync(apk)));
      expect(descriptor.artifactSha256).toBe(hash(readFileSync(apk)));
      for (const target of [...SERVER_PACKAGE_TARGETS, ...APP_PACKAGE_TARGETS]) {
        const server = SERVER_PACKAGE_TARGETS.some(value => value.id === target.id);
        const artifact = `${target.id}.zip`;
        writeFileSync(join(output, artifact), target.id);
        writeFileSync(join(output, `${artifact}.sha256`), `${hash(target.id)}  ${artifact}\n`);
        writeFileSync(join(output, `${target.id}.manifest.tsv`), "manifest");
        writeFileSync(join(output, `${target.id}.release.json`), JSON.stringify({ schema: 2, version, revision,
          target: target.id, artifact, artifactSha256: hash(target.id),
          ...(server ? { manifest: `${target.id}.manifest.tsv`, manifestSha256: hash("manifest") } : {}) }));
      }
      const current = readReleaseArtifacts(output, version, revision);
      expect(current.targets).toHaveLength(9);
      expect(current.files).toHaveLength(10);
      expect(current.mirrorFiles).toHaveLength(9);
      expect(current.mirrorFiles.some(file => file.name.endsWith(".apk"))).toBe(false);
      const sidecar = join(output, `${descriptor.mirrorArtifact}.sha256`);
      writeFileSync(sidecar, "wrong");
      expect(() => readReleaseArtifacts(output, version, revision)).toThrow(/mirror artifact checksum/);
      writeFileSync(sidecar, `${descriptor.mirrorArtifactSha256}  ${descriptor.mirrorArtifact}\n`);
      writeFileSync(join(output, descriptor.mirrorArtifact), "corrupt ZIP");
      expect(() => readReleaseArtifacts(output, version, revision)).toThrow(/mirror artifact checksum/);
      const { mirrorArtifact, mirrorArtifactSha256, ...legacy } = descriptor;
      writeFileSync(join(output, ANDROID_APP_PACKAGE_TARGET.artifact.replace(/\.apk$/, ".release.json")), JSON.stringify(legacy));
      const old = readReleaseArtifacts(output, version, revision);
      expect(old.files).toHaveLength(9);
      expect(old.mirrorFiles).toEqual(old.files);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
