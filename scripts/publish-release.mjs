import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import semver from "semver";
import { readReleaseArtifacts } from "./release-artifacts.mjs";
import { releaseNotes } from "./release-notes.mjs";

const [directory, version, revision, option] = process.argv.slice(2);
if (option && option !== "--dry-run") {
  throw new Error("Use publish-release.mjs <artifacts> <version> <full-SHA> [--dry-run]");
}
const artifacts = readReleaseArtifacts(directory, version, revision);
const files = artifacts.files.map((file) => file.path);
if (option === "--dry-run") {
  process.stdout.write(`${JSON.stringify({ version, revision, targets: artifacts.targets, files: files.length })}\n`);
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
    const body = releaseNotes(process.cwd(), version, revision, repository);
    const notes = join(tmpdir(), `piik-release-notes-${randomUUID()}.md`);
    writeFileSync(notes, body, { flag: "wx" });
    try {
      gh("release", "create", version, "--repo", repository, "--target", revision,
        "--draft", "--title", `Piik ${version}`, "--notes-file", notes);
    } finally {
      rmSync(notes);
    }
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
