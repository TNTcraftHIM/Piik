import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    upstream: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    onto: { type: "string", default: "HEAD" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(`Prepare an isolated dependency patch stack on current upstream.

node scripts/sync-upstream.mjs --source <fork URL or local clone> \
  --upstream <official URL or local clone> --base <official base> \
  --head <patch commit> --out <new directory> [--onto <upstream ref>]

Only the new directory is written. Existing clones, Piik pins and remotes stay
unchanged. Git replays the patch range; conflicts remain in the candidate for
review. No push, package installation, build or dependency update is performed.
The report and range-diff are saved inside the candidate's .git directory.`);
} else {
  try {
    prepare(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function prepare(options) {
  for (const key of ["source", "upstream", "base", "head", "out"]) {
    if (!options[key]) throw new Error(`Missing --${key}; use --help.`);
  }
  const source = repository(options.source);
  const upstream = repository(options.upstream);
  const output = resolve(options.out);
  // Creating a fresh repository leaves all existing worktrees and local edits alone.
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const git = (...args) => command(output, args);
  git("init", "--quiet");
  git("remote", "add", "patch-source", source);
  git("remote", "add", "upstream", upstream);
  console.log("Fetching the recorded patch range and upstream reference…");
  git("fetch", "--no-tags", "--no-recurse-submodules", "--", "patch-source",
    `${options.base}:refs/piik/base`, `${options.head}:refs/piik/patch`);
  git("fetch", "--no-tags", "--no-recurse-submodules", "--", "upstream",
    `${options.onto}:refs/piik/upstream`);
  git("merge-base", "--is-ancestor", "refs/piik/base", "refs/piik/patch");
  if (git("rev-list", "--merges", "refs/piik/base..refs/piik/patch")) {
    throw new Error("The patch range contains merge commits; select a focused linear patch stack.");
  }
  const report = {
    source,
    upstream,
    upstreamRef: options.onto,
    base: git("rev-parse", "refs/piik/base^{commit}"),
    patch: git("rev-parse", "refs/piik/patch^{commit}"),
    upstreamHead: git("rev-parse", "refs/piik/upstream^{commit}"),
    patchEquivalents: git("cherry", "refs/piik/upstream", "refs/piik/patch", "refs/piik/base"),
  };
  const patches = git("rev-list", "--reverse", "refs/piik/base..refs/piik/patch").split("\n").filter(Boolean);
  const unapplied = new Set(report.patchEquivalents.split("\n")
    .filter(line => line.startsWith("+ ")).map(line => line.slice(2)));
  report.alreadyApplied = patches.filter(commit => !unapplied.has(commit));
  git("checkout", "--quiet", "-b", "candidate", "refs/piik/patch");
  const replay = spawnSync("git", ["rebase", "--onto", "refs/piik/upstream", "refs/piik/base"], {
    cwd: output, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  if (replay.error) throw replay.error;
  report.conflicts = git("diff", "--name-only", "--diff-filter=U");
  report.status = replay.status === 0 ? "ready" : report.conflicts ? "conflict" : "failed";
  report.replayLog = `${replay.stdout}${replay.stderr}`.trim();
  if (replay.status === 0) {
    report.candidate = git("rev-parse", "HEAD");
    report.remaining = Number(git("rev-list", "--count", "refs/piik/upstream..HEAD"));
    writeFileSync(join(output, ".git", "piik-upstream-range-diff.txt"),
      report.remaining
        ? git("range-diff", "--no-color", "refs/piik/base..refs/piik/patch", "refs/piik/upstream..HEAD") + "\n"
        : "No local patches remain.\n");
  }
  const path = join(output, ".git", "piik-upstream-sync.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${output}\nReport: ${path}`);
  if (replay.status !== 0) {
    console.error(report.replayLog);
    process.exitCode = 1;
  }
}

function repository(value) {
  if (existsSync(value)) return resolve(value);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a local clone or an HTTPS repository URL without embedded credentials.");
  }
  return url.href;
}

function command(cwd, args) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}
