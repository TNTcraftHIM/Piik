import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    const commit = (message: string, path = "index.html") => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), message);
      git("add", "--", path);
      git("commit", "-m", message);
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
      const website = commit("feat(site)!: redesign the homepage", "site/index.html");
      expect(() => releaseNotes(root, "v1.0.1", website, "fixture/Piik")).toThrow("No release changes");
      expect(releaseNotes(root, "v1.0.1", website, "fixture/Piik", { allowEmpty: true })).toBe("");
      const candidate = JSON.parse(execFileSync(process.execPath, [planner, "build"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PIIK_BUILD_VERSION: "v1.0.1" },
      }));
      expect(candidate).toMatchObject({ version: "v1.0.1", publish: false });
      commit("fix: repair playback\n\n## Release notes\n- Playback resumes after reconnecting.");
      const next = commit("feat: add a sharing option\n\n## Release notes\n- Choose a window to share.");
      const notes = releaseNotes(root, "v1.1.0", next, "fixture/Piik");
      expect(notes).toContain("- Playback resumes after reconnecting.\n\n- Choose a window to share.");
      expect(notes).toContain(`/compare/v1.0.0...${next}`);
      expect(notes).not.toContain("开始分享");
      expect(notes).not.toContain("redesign");
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
  }, 15_000); // Real Git subprocesses share the runner with the rest of the suite.

  it("plans from immutable tags and all unreleased main changes without editing version files", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-release-plan-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const plan = () => JSON.parse(execFileSync(process.execPath, [planner, "plan"], { cwd: root, encoding: "utf8" }));
    const commit = (message: string, path = "index.html") => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), message);
      git("add", "--", path);
      git("commit", "-m", message);
    };
    try {
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.name", "Piik fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgSign", "false");
      commit("chore: initial");
      expect(plan().version).toBe("v1.0.0");
      const candidate = JSON.parse(execFileSync(process.execPath, [planner, "build"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PIIK_BUILD_VERSION: "v1.0.0" },
      }));
      expect(candidate).toMatchObject({ version: "v1.0.0", publish: false });
      expect(git("tag")).toBe("");
      git("tag", "v1.0.0");
      // The tag might belong to an unfinished draft: publication can resume.
      expect(plan()).toMatchObject({ version: "v1.0.0", publish: true });
      for (const path of ["site/film/art.js", "site/docs/package.json", "site/docs/package-lock.json",
        "site/docs/.vitepress/config.mjs", "docs/guide/troubleshooting.md", "docs/deployment.md", "README.zh-CN.md",
        "scripts/build-website.mjs", "scripts/check-docs.mjs", "scripts/check-container.mjs", "scripts/markdown-slug.mjs", "scripts/release-notes.mjs",
        "scripts/publish-container.mjs",
        "scripts/app-gate-endpoint.ts", "scripts/client-gate-endpoint.ts",
        "tests/room.test.ts", ".agents/skills/ponytail/SKILL.md", ".github/workflows/website.yml"]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "Peripheral content");
      }
      git("add", ".");
      git("commit", "-m", "feat(site)!: redesign the website\n\nBREAKING CHANGE: website layout only");
      expect(plan()).toMatchObject({ version: "development", publish: false });
      commit("fix: repair playback\n\nExample text:\nfeat: is not this commit's type");
      expect(plan().version).toBe("v1.0.1");
      commit("feat(site)!: refresh the film", "site/film/art.js");
      expect(plan()).toMatchObject({ version: "v1.0.1", revision: git("rev-parse", "HEAD"), publish: true });
      commit("feat(app): add a sharing option");
      expect(plan().version).toBe("v1.1.0");
      commit("refactor!: replace the public contract");
      expect(plan().version).toBe("v2.0.0");
      expect(git("tag")).toBe("v1.0.0");
      const reused = spawnSync(process.execPath, [planner, "build"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PIIK_BUILD_VERSION: "v1.0.0" },
      });
      expect(reused.status).not.toBe(0);
      expect(reused.stderr).toContain("two source revisions");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps shipped assets, build inputs and moves across the website boundary release-worthy", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-release-paths-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const plan = () => JSON.parse(execFileSync(process.execPath, [planner, "plan"], { cwd: root, encoding: "utf8" }));
    try {
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.name", "Piik fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgSign", "false");
      mkdirSync(join(root, "public"));
      writeFileSync(join(root, "public", "asset.svg"), "Shared artwork");
      git("add", ".");
      git("commit", "-m", "feat: launch");
      git("tag", "v1.0.0");
      for (const path of ["src/client/styles.css", "src/shared/protocol.ts", "internal/server/app/app.go",
        "cmd/piik-app/piik.ico", "native/capture/windows/build.ps1", "public/guide.md",
        "licenses/NOTICE.md", "LICENSE", "package-lock.json", "go.mod",
        "scripts/check-go.mjs", "scripts/app-package-targets.mjs", ".github/workflows/repository-hygiene.yml",
        "new-product-input.json"]) {
        git("checkout", "--quiet", "--detach", "v1.0.0");
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "Changed product input");
        git("add", "--", path);
        git("commit", "-m", "fix: update product input");
        expect(plan(), path).toMatchObject({ version: "v1.0.1", publish: true });
      }
      git("checkout", "--quiet", "--detach", "v1.0.0");
      mkdirSync(join(root, "site"), { recursive: true });
      git("mv", "public/asset.svg", "site/asset.svg");
      git("commit", "-m", "fix: retire the product asset");
      expect(plan()).toMatchObject({ version: "v1.0.1", publish: true });
      git("tag", "v1.0.1");
      mkdirSync(join(root, "public"), { recursive: true });
      git("mv", "site/asset.svg", "public/asset.svg");
      git("commit", "-m", "feat: add the product asset");
      expect(plan()).toMatchObject({ version: "v1.1.0", publish: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("accepts only a complete same-build package set before contacting GitHub", () => {
    const root = mkdtempSync(join(tmpdir(), "piik-release-assets-"));
    const version = "v1.0.0";
    const revision = "a".repeat(40);
    const run = () => spawnSync(process.execPath, [publisher, root, version, revision, "--dry-run"], { encoding: "utf8" });
    try {
      for (const target of ["server", "windows-amd64", "linux-amd64", "darwin-arm64"]) {
        const artifact = `${target}.${target === "server" ? "tar.gz" : "zip"}`;
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
      expect(JSON.parse(complete.stdout).files).toBe(4);
      const checksum = join(root, "windows-amd64.zip.sha256");
      const originalChecksum = readFileSync(checksum, "utf8");
      writeFileSync(checksum, "wrong checksum");
      expect(run().stderr).toContain("App checksum file mismatch");
      writeFileSync(checksum, originalChecksum);
      const path = join(root, "windows-amd64.release.json");
      const original = readFileSync(path, "utf8");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(original), revision: "b".repeat(40) }));
      expect(run().stderr).toContain("Release identity mismatch");
      writeFileSync(path, original);
      writeFileSync(join(root, "windows-amd64.zip"), "changed bytes");
      expect(run().stderr).toContain("checksum mismatch");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
