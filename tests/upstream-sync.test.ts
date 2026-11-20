import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("replays a real patch stack, drops upstream equivalents and preserves conflicts and existing work", () => {
  const root = mkdtempSync(join(tmpdir(), "piik-upstream-"));
  const upstream = join(root, "upstream"), fork = join(root, "fork");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Piik fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Piik fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "maintenance.auto", GIT_CONFIG_VALUE_1: "false",
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const commit = (cwd: string, file: string, contents: string, title: string) => {
    writeFileSync(join(cwd, file), contents);
    git(cwd, "add", file);
    git(cwd, "commit", "-m", title);
  };
  try {
    mkdirSync(upstream);
    git(upstream, "init", "-b", "main");
    commit(upstream, "api.txt", "original\n", "original API");
    const base = git(upstream, "rev-parse", "HEAD");
    git(root, "clone", "--no-hardlinks", upstream, fork);
    commit(fork, "profile.txt", "equivalent profiles\n", "fix profile matching");
    const accepted = git(fork, "rev-parse", "HEAD");
    commit(fork, "api.txt", "patched\n", "add required input");
    const head = git(fork, "rev-parse", "HEAD");
    commit(upstream, "notes.txt", "upstream change\n", "advance upstream");
    commit(upstream, "profile.txt", "equivalent profiles\n", "independent upstream profile fix");
    const updated = git(upstream, "rev-parse", "HEAD");
    expect(updated).not.toBe(accepted);
    writeFileSync(join(fork, "api.txt"), "uncommitted user work\n");
    const run = (out: string, onto = "main") => spawnSync(process.execPath, [
      resolve("scripts/sync-upstream.mjs"), "--source", fork, "--upstream", upstream,
      "--base", base, "--head", head, "--onto", onto, "--out", out,
    ], {
      encoding: "utf8", windowsHide: true,
      env,
    });
    const candidate = join(root, "candidate");
    const ready = run(candidate);
    expect(ready.status, ready.stdout + ready.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(candidate, ".git/piik-upstream-sync.json"), "utf8"));
    expect(report.status).toBe("ready");
    expect(report.remaining).toBe(1);
    expect(report.upstreamHead).toBe(updated);
    expect(report.alreadyApplied).toContain(accepted);
    expect(git(candidate, "show", "HEAD:api.txt")).toBe("patched");
    expect(git(candidate, "show", "HEAD:notes.txt")).toBe("upstream change");
    expect(git(candidate, "status", "--porcelain")).toBe("");
    expect(git(fork, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(fork, "api.txt"), "utf8")).toBe("uncommitted user work\n");
    expect(git(upstream, "rev-parse", "HEAD")).toBe(updated);

    git(upstream, "checkout", "-b", "conflicting");
    commit(upstream, "api.txt", "upstream API\n", "change the same API");
    const conflicted = join(root, "conflicted");
    expect(run(conflicted, "conflicting").status).toBe(1);
    const conflict = JSON.parse(readFileSync(join(conflicted, ".git/piik-upstream-sync.json"), "utf8"));
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflicts).toBe("api.txt");
    expect(git(conflicted, "diff", "--name-only", "--diff-filter=U")).toBe("api.txt");
    expect(run(candidate).status).toBe(1);
    expect(git(candidate, "rev-parse", "HEAD")).toBe(report.candidate);
    expect(readFileSync(join(fork, "api.txt"), "utf8")).toBe("uncommitted user work\n");

    git(upstream, "checkout", "main");
    writeFileSync(join(upstream, "api.txt"), "patched\n");
    git(upstream, "commit", "-am", "upstream input fix");
    const absorbed = join(root, "absorbed");
    const complete = run(absorbed);
    expect(complete.status, complete.stdout + complete.stderr).toBe(0);
    const final = JSON.parse(readFileSync(join(absorbed, ".git/piik-upstream-sync.json"), "utf8"));
    expect(final.remaining).toBe(0);
    expect(final.candidate).toBe(final.upstreamHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
