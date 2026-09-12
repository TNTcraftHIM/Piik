import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import semver from "semver";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
export const isReleaseVersion = (value) => typeof value === "string" &&
  /^v\d+\.\d+\.\d+$/.test(value) && semver.valid(value) !== null;

export function stableTags(root, ...filter) {
  return git(root, "tag", ...filter).split("\n").filter(isReleaseVersion).sort(semver.rcompare);
}

// Known standalone surfaces do not change the shipped App/Server. Everything
// else stays eligible, including shared UI, public assets, licenses and build
// inputs. In particular, check-client.mjs builds the bundled capture runtime.
const nonProductPaths = [
  "site/**", "docs/**", "tests/**", ".agents/**", ".codex/**", ".githooks/**",
  "*.md", ".gitignore", ".env.example", "vitest.config.ts",
  "cmd/**/*.md", "internal/**/*.md", "native/**/*.md", "src/**/*.md",
  ".github/ISSUE_TEMPLATE/**", ".github/pull_request_template.md", ".github/workflows/website.yml",
  "scripts/build-website.mjs", "scripts/update-website-hero.mjs", "scripts/check-website-film.js",
  "scripts/check-docs.mjs", "scripts/check-project-state.*", "scripts/install-hooks.*",
  "scripts/required-project-paths.txt", "scripts/tsconfig.json",
  "scripts/release-*.mjs", "scripts/publish-release.mjs", "scripts/mirror-release.mjs",
  "scripts/*-gate.*", "scripts/*-probe.*", "scripts/browser-*", "scripts/encoded-*",
  "scripts/client-gate-endpoint.ts", "scripts/embedded-sfu-page.ts", "scripts/peer-assisted-benchmark.ts",
  "cmd/piik-peer-gate/**",
].map((path) => `:(top,glob,exclude)${path}`);

// Both version selection and public notes use this same set of product commits.
// Git handles deletions and moves across the boundary; no workflow path filter
// can hide an earlier product change whose publication needs to be retried.
export function releaseCommits(root, revision, previous) {
  const records = git(root, "log", "--first-parent", "--reverse", "--no-renames", "--format=%H%x00%B%x00",
    ...(previous ? [`${previous}..${revision}`, "--", ".", ...nonProductPaths] : ["-1", revision])).split("\0");
  const commits = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    commits.push({ revision: records[index].trim(), message: records[index + 1].trim() });
  }
  return commits;
}

// One input for packagers: a planned CI version, an exact public tag, or a dev build.
export function buildVersion(root, revision, requested = process.env.PIIK_BUILD_VERSION) {
  const version = requested || stableTags(root, "--points-at", revision)[0] || "development";
  if (version === "development") return version;
  if (!isReleaseVersion(version)) throw new Error("Build version must be vMAJOR.MINOR.PATCH or development");
  if (git(root, "tag", "--list", version) &&
      git(root, "rev-parse", `${version}^{commit}`) !== revision) {
    throw new Error("A release version cannot identify two source revisions");
  }
  return version;
}

export function planRelease(root) {
  const revision = git(root, "rev-parse", "HEAD");
  const previous = stableTags(root, "--merged", "HEAD")[0];
  if (previous && git(root, "rev-parse", `${previous}^{commit}`) === revision) {
    // A tag may predate its Release. Draft creation itself does not create a tag.
    return { version: previous, revision, publish: true };
  }
  let version = "v1.0.0";
  if (previous) {
    // Main contains one squash commit per accepted PR. A rerun includes any
    // unreleased commits, so a later fix cannot hide an earlier breaking change.
    const messages = releaseCommits(root, revision, previous).map((commit) => commit.message);
    if (!messages.length) return { version: "development", revision, publish: false };
    const subjects = messages.map((message) => message.trim().split(/\r?\n/, 1)[0]);
    const breaking = subjects.some((subject) => /^[a-z]+(?:\([^\r\n)]+\))?!: /i.test(subject)) ||
      messages.some((message) => /^BREAKING[ -]CHANGE: /m.test(message));
    const feature = subjects.some((subject) => /^feat(?:\([^\r\n)]+\))?: /i.test(subject));
    version = `v${semver.inc(previous, breaking ? "major" : feature ? "minor" : "patch")}`;
  }
  return { version: buildVersion(root, revision, version), revision, publish: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? "build";
  if (mode !== "plan" && mode !== "build") throw new Error("Use release-version.mjs plan|build [--github-output]");
  const root = process.cwd();
  const revision = git(root, "rev-parse", "HEAD");
  const identity = mode === "plan" ? planRelease(root)
    : { version: buildVersion(root, revision), revision, publish: false };
  if (process.argv.includes("--github-output")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is missing");
    appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(identity).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}
