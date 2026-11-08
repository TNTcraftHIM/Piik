import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repository = "TNTcraftHIM/Piik";
export async function readMirror(path) {
  const response = await fetch(`https://api.atomgit.com/api/v5/repos/${repository}${path}`, {
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AtomGit readiness ${path}: HTTP ${response.status}`);
  return response.json();
}

// Git synchronization belongs to AtomGit. Release creation must never create a tag.
export async function mirrorSourceReady(version, revision, read = readMirror) {
  const commit = await read(`/commits/${revision}`);
  if (!commit) return false;
  if (commit.sha !== revision) throw new Error("AtomGit source commit differs from the published source");
  for (let page = 1; page <= 10; page++) {
    const tags = await read(`/tags?per_page=100&page=${page}`);
    if (!Array.isArray(tags)) throw new Error("Unexpected AtomGit tag list");
    const tag = tags.find(tag => tag.name === version);
    if (tag) {
      if (tag.commit?.sha !== revision) throw new Error("AtomGit release tag belongs to another source revision");
      return true;
    }
    if (tags.length < 100) return false;
  }
  throw new Error("AtomGit tag inventory exceeds 10 pages; source readiness cannot be determined");
}

export async function mirrorReadiness(source, read = readMirror) {
  if (source.draft !== false || source.prerelease !== false || typeof source.tag_name !== "string"
    || !/^[a-f0-9]{40}$/.test(source.target_commitish)) throw new Error("A published GitHub release with a full source SHA is required");
  const version = source.tag_name, revision = source.target_commitish;
  const mirror = await read(`/releases/tags/${encodeURIComponent(version)}`);
  if (mirror) {
    if (mirror.tag_name !== version || ![true, false].includes(mirror.prerelease)
      || !mirror.body?.split(/\r?\n/).includes(`<!-- piik-source: ${revision} -->`))
      throw new Error("Existing mirror release belongs to a different or unknown source revision");
    const packages = source.assets?.filter(asset => asset.name?.startsWith("piik-"));
    const complete = packages?.length > 0 && Array.isArray(mirror.assets) && packages.every(asset => {
      const matches = mirror.assets.filter(candidate => candidate.type === "attach" && candidate.name === asset.name);
      return asset.state === "uploaded" && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
        && matches.length === 1 && matches[0].size === asset.size
        && matches[0].browser_download_url === `https://atomgit.com/${repository}/releases/download/${version}/${asset.name}`;
    });
    if (!mirror.prerelease) {
      if (!complete) throw new Error("Published mirror is incomplete; it cannot be silently replaced");
      return { status: "complete", version, revision };
    }
  }
  return { status: await mirrorSourceReady(version, revision, read) ? "ready" : "deferred", version, revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases/latest`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  }));
  const result = await mirrorReadiness(source);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    result.status === "deferred" ? `Mirror ${result.version} deferred until AtomGit's scheduled Git synchronization supplies the matching commit and tag. The next mirror check will resume automatically.\n`
      : result.status === "complete" ? `Mirror ${result.version} is already stable with the complete published attachment inventory.\n`
        : `Mirror ${result.version} is ready to resume from original CI artifacts.\n`);
  console.log(JSON.stringify(result));
}
