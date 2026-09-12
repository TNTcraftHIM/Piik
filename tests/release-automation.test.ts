import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseNotes } from "../scripts/release-notes.mjs";

const planner = fileURLToPath(new URL("../scripts/release-version.mjs", import.meta.url));
const publisher = fileURLToPath(new URL("../scripts/publish-release.mjs", import.meta.url));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("release automation", () => {
  it("publishes reviewed notes, excludes private history and retains every unreleased phase on retries", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-release-notes-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const commit = (message: string) => {
      git("commit", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    };
    try {
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.name", "Piik fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgSign", "false");
      commit("chore: private history without release copy");
      const launch = commit("feat: launch\n\n## Problem\nInternal discussion\n\n## Release notes\n" +
        "<!-- Editor guidance -->\n### 开始分享\n\n- 一起玩，一起看。\n\n## Verification\nInternal log");
      const first = releaseNotes(root, "v1.0.0", launch, "fixture/Piik");
      expect(first).toContain("### 开始分享\n\n- 一起玩，一起看。");
      expect(first).toContain(`/tree/${launch}`);
      expect(first).not.toMatch(/private history|Internal|Editor guidance/);
      git("tag", "-a", "v1.0.0", "-m", "Launch");
      expect(releaseNotes(root, "v1.0.0", launch, "fixture/Piik")).toBe(first);
      commit("fix: repair playback\n\n## Release notes\n- Playback resumes after reconnecting.");
      const next = commit("feat: add a sharing option\n\n## Release notes\n- Choose a window to share.");
      const notes = releaseNotes(root, "v1.1.0", next, "fixture/Piik");
      expect(notes).toContain("- Playback resumes after reconnecting.\n\n- Choose a window to share.");
      expect(notes).toContain(`/compare/v1.0.0...${next}`);
      expect(notes).not.toContain("开始分享");
      git("tag", "v1.1.0");
      expect(releaseNotes(root, "v1.1.0", next, "fixture/Piik")).toBe(notes);
      // A checkout may have advanced; generation still uses the requested SHA.
      expect(releaseNotes(root, "v1.0.0", launch, "fixture/Piik")).toBe(first);
      for (const section of ["", "## Release notes", "## Release notes\n<!-- Fill in -->\n### Changes",
        "## Release notes\n- One\n## Release notes\n- Two"]) {
        git("checkout", "--quiet", "--detach", next);
        const invalid = commit(`chore: maintenance\n\n${section}`);
        expect(() => releaseNotes(root, "v1.1.1", invalid, "fixture/Piik")).toThrow("one nonempty");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("plans from immutable tags and all unreleased main changes without editing version files", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-release-plan-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const plan = () => JSON.parse(execFileSync(process.execPath, [planner, "plan"], { cwd: root, encoding: "utf8" }));
    try {
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.name", "Piik fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgSign", "false");
      git("commit", "--allow-empty", "-m", "chore: initial");
      expect(plan().version).toBe("v1.0.0");
      const candidate = JSON.parse(execFileSync(process.execPath, [planner, "build"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PIIK_BUILD_VERSION: "v1.0.0" },
      }));
      expect(candidate).toMatchObject({ version: "v1.0.0", publish: false });
      expect(git("tag")).toBe("");
      git("tag", "v1.0.0");
      // The tag might belong to an unfinished draft: publication can resume.
      expect(plan()).toMatchObject({ version: "v1.0.0", publish: true });
      git("commit", "--allow-empty", "-m", "fix: repair playback\n\nExample text:\nfeat: is not this commit's type");
      expect(plan().version).toBe("v1.0.1");
      git("commit", "--allow-empty", "-m", "feat(app): add a sharing option");
      expect(plan().version).toBe("v1.1.0");
      git("commit", "--allow-empty", "-m", "refactor!: replace the public contract");
      expect(plan().version).toBe("v2.0.0");
      expect(git("tag")).toBe("v1.0.0");
      const reused = spawnSync(process.execPath, [planner, "build"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PIIK_BUILD_VERSION: "v1.0.0" },
      });
      expect(reused.status).not.toBe(0);
      expect(reused.stderr).toContain("two source revisions");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts only a complete same-build package set before contacting GitHub", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-release-assets-"));
    const version = "v1.0.0";
    const revision = "a".repeat(40);
    const run = () => spawnSync(process.execPath, [publisher, root, version, revision, "--dry-run"], { encoding: "utf8" });
    try {
      for (const target of ["server", "windows-amd64", "linux-amd64", "darwin-arm64"]) {
        const artifact = `${target}.tar.gz`;
        writeFileSync(join(root, artifact), target);
        const descriptor = { schema: 2, version, revision, artifact, artifactSha256: sha(target),
          ...(target === "server" ? { manifest: "server.manifest.tsv", manifestSha256: sha("manifest") } : { target }) };
        writeFileSync(join(root, `${target}.release.json`), JSON.stringify(descriptor));
        if (target === "server") writeFileSync(join(root, "server.manifest.tsv"), "manifest");
        else writeFileSync(join(root, `${artifact}.sha256`), `${sha(target)}  ${artifact}\n`);
      }
      const complete = run();
      expect(complete.status, complete.stderr).toBe(0);
      expect(JSON.parse(complete.stdout).targets).toHaveLength(4);
      const path = join(root, "windows-amd64.release.json");
      const original = readFileSync(path, "utf8");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(original), revision: "b".repeat(40) }));
      expect(run().stderr).toContain("Release identity mismatch");
      writeFileSync(path, original);
      writeFileSync(join(root, "windows-amd64.tar.gz"), "changed bytes");
      expect(run().stderr).toContain("checksum mismatch");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
