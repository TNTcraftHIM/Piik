import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { isReleaseVersion, stableTags } from "./release-version.mjs";

// The reviewed PR body survives the squash commit. Only its public section is
// release copy; implementation details and verification logs stay in the PR.
export function releaseNotes(root, version, revision, repository) {
  if (!isReleaseVersion(version) || !/^[a-f0-9]{40}$/.test(revision) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Release notes require a stable version, full SHA and owner/repository");
  }
  // Exclude this release's tag so retrying after publication keeps the same range.
  const previous = stableTags(root, "--merged", revision).find((tag) => semver.lt(tag, version));
  const log = execFileSync("git", ["log", "--first-parent", "--reverse", "--format=%H%x00%B%x00",
    ...(previous ? [`${previous}..${revision}`] : ["-1", revision])], { cwd: root, encoding: "utf8" });
  const records = log.split("\0");
  const bodies = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const sections = records[index + 1].replace(/\r\n/g, "\n").split(/^## /m).slice(1)
      .filter((section) => section.split("\n", 1)[0].trim() === "Release notes");
    const body = sections.length === 1
      ? sections[0].split("\n").slice(1).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim()
      : "";
    if (!body || !body.split("\n").some((line) => line.trim() && !/^#{1,6}(\s|$)/.test(line))) {
      throw new Error(`Commit ${records[index].trim()} needs one nonempty ## Release notes section`);
    }
    bodies.push(body);
  }
  if (!bodies.length) throw new Error("No release changes found");
  const url = `https://github.com/${repository}`;
  const source = previous
    ? `[完整变更 / Full changelog](${url}/compare/${previous}...${revision})`
    : `[源代码 / Source](${url}/tree/${revision})`;
  return `${bodies.join("\n\n")}\n\n---\n\n${source}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, revision, option] = process.argv.slice(2);
  if (option && option !== "--github-summary") {
    throw new Error("Use release-notes.mjs <version> <full-SHA> [--github-summary]");
  }
  const body = releaseNotes(process.cwd(), version, revision,
    process.env.GITHUB_REPOSITORY || "TNTcraftHIM/Piik");
  if (option) {
    if (!process.env.GITHUB_STEP_SUMMARY) throw new Error("GITHUB_STEP_SUMMARY is missing");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release notes preview: Piik ${version}\n\n${body}`);
  }
  process.stdout.write(body);
}
