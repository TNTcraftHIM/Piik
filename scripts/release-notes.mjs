import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { hasProductChanges, isReleaseVersion, releaseCommits, stableTags } from "./release-version.mjs";

export function releaseNotesSection(message, source) {
  const sections = message.replace(/\r\n/g, "\n").split(/^## /m).slice(1)
    .filter((section) => section.split("\n", 1)[0].trim() === "Release notes");
  const body = sections.length === 1
    ? sections[0].split("\n").slice(1).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim()
    : "";
  if (!body || !body.split("\n").some((line) => line.trim() && !/^#{1,6}(\s|$)/.test(line))) {
    throw new Error(`${source} needs one nonempty ## Release notes section`);
  }
  if (/\uFFFD|\?{3,}/u.test(body)) {
    throw new Error(`${source} has damaged Release notes text; restore the UTF-8 source`);
  }
  return body;
}

export function pullRequestNotes(root, event) {
  const pr = event.pull_request;
  if (!pr) throw new Error("A pull_request event is required");
  return hasProductChanges(root, pr.base.sha, pr.head.sha)
    ? releaseNotesSection(pr.body ?? "", `PR #${pr.number}`) : "";
}

// The reviewed PR body survives the squash commit. Only its public section is
// release copy; implementation details and verification logs stay in the PR.
export function releaseNotes(root, version, revision, repository, { allowEmpty = false } = {}) {
  if (!isReleaseVersion(version) || !/^[a-f0-9]{40}$/.test(revision) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Release notes require a stable version, full SHA and owner/repository");
  }
  // Exclude this release's tag so retrying after publication keeps the same range.
  const previous = stableTags(root, "--merged", revision).find((tag) => semver.lt(tag, version));
  const bodies = [];
  for (const commit of releaseCommits(root, revision, previous)) {
    bodies.push(releaseNotesSection(commit.message, `Commit ${commit.revision}`));
  }
  if (!bodies.length) {
    if (allowEmpty) return "";
    throw new Error("No release changes found");
  }
  const url = `https://github.com/${repository}`;
  const source = previous
    ? `[完整变更 / Full changelog](${url}/compare/${previous}...${revision})`
    : `[源代码 / Source](${url}/tree/${revision})`;
  return `${bodies.join("\n\n")}\n\n---\n\n${source}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, revision, option] = process.argv.slice(2);
  if (version === "--pull-request") {
    if (!process.env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is missing");
    pullRequestNotes(process.cwd(), JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")));
    process.stdout.write("PR release notes validated.\n");
  } else {
    if (option && option !== "--github-summary") {
      throw new Error("Use release-notes.mjs <version> <full-SHA> [--github-summary]");
    }
    const body = releaseNotes(process.cwd(), version, revision,
      process.env.GITHUB_REPOSITORY || "TNTcraftHIM/Piik", { allowEmpty: Boolean(option) });
    if (option) {
      if (!process.env.GITHUB_STEP_SUMMARY) throw new Error("GITHUB_STEP_SUMMARY is missing");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Release notes preview: Piik ${version}\n\n${body || "No product changes; this candidate does not publish a release.\n"}`);
    }
    process.stdout.write(body);
  }
}
