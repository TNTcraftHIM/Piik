import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isReleaseVersion } from "./release-version.mjs";

const repository = "TNTcraftHIM/Piik";
const gh = (path) => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${path}`], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
}));

export function resolveMirrorSource(runId, automatic = false) {
  if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId))) {
    throw new Error("Provide the original CI run's numeric ID");
  }
  const run = gh(`actions/runs/${runId}`);
  if (run.id !== Number(runId) || run.repository?.full_name !== repository ||
      run.head_repository?.full_name !== repository || run.event !== "push" ||
      run.head_branch !== "main" || run.path !== ".github/workflows/repository-hygiene.yml" ||
      run.status !== "completed" || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      (automatic && run.conclusion !== "success")) {
    throw new Error("Mirror artifacts must come from a completed main push in this repository's CI workflow");
  }
  // A legacy CI run may be red because its mirror failed after GitHub published.
  // The published release, not that aggregate result, owns manual retry identity.
  const release = gh("releases/latest");
  if (release.draft !== false || release.prerelease !== false || !isReleaseVersion(release.tag_name) ||
      !/^[a-f0-9]{40}$/.test(release.target_commitish)) {
    throw new Error("A published stable GitHub release with a full source SHA is required");
  }
  if (release.target_commitish !== run.head_sha) {
    if (automatic) return null;
    throw new Error("This CI run does not match the latest GitHub release; use its original publishing run");
  }
  return { run_id: String(run.id), version: release.tag_name, revision: run.head_sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = resolveMirrorSource(process.argv[2], process.env.GITHUB_EVENT_NAME === "workflow_run");
  const output = { mirror: source !== null, ...source };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, source
      ? `Mirror ${source.version} from original [CI run ${source.run_id}](https://github.com/${repository}/actions/runs/${source.run_id}).\n`
      : "This CI run did not publish the current GitHub release; no mirror work is needed.\n");
  }
  console.log(JSON.stringify(output));
}
