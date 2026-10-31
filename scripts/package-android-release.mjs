import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip } from "./archive-tool.mjs";
import { ANDROID_APP_PACKAGE_TARGET } from "./app-package-targets.mjs";

// Wrap the already signed APK; neither distribution changes its installed bytes.
export function packageAndroidRelease(apk, output, version, revision) {
  const { id: target, artifact, mirrorArtifact } = ANDROID_APP_PACKAGE_TARGET;
  mkdirSync(output, { recursive: true });
  copyFileSync(apk, join(output, artifact));
  const staging = mkdtempSync(join(tmpdir(), "piik-android-package-"));
  try {
    // zip updates existing archives, so each packaging starts with a fresh file.
    const archive = join(staging, "distribution.zip");
    const contents = join(staging, "contents");
    mkdirSync(contents);
    copyFileSync(apk, join(contents, artifact));
    createZip(contents, archive);
    copyFileSync(archive, join(output, mirrorArtifact));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const hashes = [artifact, mirrorArtifact].map(name => {
    const hash = createHash("sha256").update(readFileSync(join(output, name))).digest("hex");
    writeFileSync(join(output, `${name}.sha256`), `${hash}  ${name}\n`, "ascii");
    return hash;
  });
  const descriptor = { schema: 2, version, revision, target, artifact, artifactSha256: hashes[0],
    mirrorArtifact, mirrorArtifactSha256: hashes[1] };
  writeFileSync(join(output, artifact.replace(/\.apk$/, ".release.json")), `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptor;
}
