import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import semver from "semver";

const [directory, version, revision, option] = process.argv.slice(2);
if (!directory || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") ||
    !/^[0-9a-f]{40}$/.test(revision ?? "") || (option && option !== "--dry-run")) {
  throw new Error("Use publish-release.mjs <artifacts> <version> <full-SHA> [--dry-run]");
}
const root = resolve(directory);
const files = new Set();
const targets = new Set();
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function asset(name) {
  if (typeof name !== "string" || basename(name) !== name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error("Release asset name is invalid");
  }
  const path = join(root, name);
  files.add(path);
  return path;
}

for (const name of readdirSync(root).filter((name) => name.endsWith(".release.json"))) {
  const descriptor = JSON.parse(readFileSync(asset(name), "utf8"));
  if (descriptor.schema !== 2 || descriptor.version !== version || descriptor.revision !== revision) {
    throw new Error(`Release identity mismatch: ${name}`);
  }
  const target = descriptor.target ?? "server";
  if (targets.has(target)) throw new Error(`Duplicate release target: ${target}`);
  targets.add(target);
  if (digest(asset(descriptor.artifact)) !== descriptor.artifactSha256) {
    throw new Error(`Release artifact checksum mismatch: ${name}`);
  }
  if (target === "server") {
    if (digest(asset(descriptor.manifest)) !== descriptor.manifestSha256) {
      throw new Error("Server manifest checksum mismatch");
    }
  } else if (readFileSync(asset(`${descriptor.artifact}.sha256`), "utf8").trim() !==
      `${descriptor.artifactSha256}  ${descriptor.artifact}`) {
    throw new Error(`App checksum file mismatch: ${target}`);
  }
}
const expected = ["server", "windows-amd64", "linux-amd64", "darwin-arm64"];
if (targets.size !== expected.length || expected.some((target) => !targets.has(target))) {
  throw new Error("Publication requires one matching Server and every App target");
}
if (option === "--dry-run") {
  process.stdout.write(`${JSON.stringify({ version, revision, targets: [...targets], files: files.size })}\n`);
} else {
  const repository = process.env.GITHUB_REPOSITORY || "TNTcraftHIM/Piik";
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  function verifyTag(required = false) {
    // A successful empty match is absence; API/authentication errors must fail.
    const references = JSON.parse(gh("api", `repos/${repository}/git/matching-refs/tags/${version}`));
    const tag = references.find((reference) => reference.ref === `refs/tags/${version}`);
    if (!tag) {
      if (required) throw new Error("Published release tag is missing");
      return;
    }
    let object = tag.object;
    while (object.type === "tag") {
      object = JSON.parse(gh("api", `repos/${repository}/git/tags/${object.sha}`)).object;
    }
    if (object.type !== "commit" || object.sha !== revision) {
      throw new Error("Release tag belongs to a different source revision");
    }
  }
  verifyTag();
  const releases = gh("api", `repos/${repository}/releases?per_page=100`, "--paginate", "--jq",
    ".[] | {tag_name,target_commitish,draft,prerelease,assets:[.assets[] | {name,state}]} | @json")
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const existing = releases.find((release) => release.tag_name === version);
  if (existing) {
    if (existing.target_commitish !== revision) throw new Error("Existing release belongs to a different source revision");
    if (!existing.draft) {
      verifyTag(true);
      if ([...files].some((path) => !existing.assets.some((uploaded) =>
        uploaded.name === basename(path) && uploaded.state === "uploaded"))) {
        throw new Error("Published release is incomplete; publish a new version instead of modifying it");
      }
      process.stdout.write(`Release ${version} is already published; left unchanged.\n`);
      process.exit(0);
    }
  } else {
    gh("release", "create", version, "--repo", repository, "--target", revision,
      "--draft", "--title", `Piik ${version}`, "--generate-notes");
  }
  // Clobber is limited to our same-revision draft; published versions are never changed.
  gh("release", "upload", version, "--repo", repository, "--clobber", ...files);
  const latest = !releases.some((release) => !release.draft && !release.prerelease &&
    /^v\d+\.\d+\.\d+$/.test(release.tag_name) && semver.valid(release.tag_name) &&
    semver.gt(release.tag_name, version));
  verifyTag();
  gh("release", "edit", version, "--repo", repository, "--draft=false", `--latest=${latest}`);
  verifyTag(true);
  process.stdout.write(`Published ${version} from ${revision}.\n`);
}
