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
    const messages = git(root, "log", "--first-parent", "--format=%B%x00", `${previous}..HEAD`).split("\0");
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
