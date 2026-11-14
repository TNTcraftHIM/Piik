// Prepare the attachment container before downloading original build artifacts.
// The local tag locates attachments; their original source
// identity comes from the GitHub marker and verified package digests.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mirrorReadiness, readMirror, validateMirrorSource, validateMirrorRelease } from "./release-mirror-ready.mjs";

async function requestMirror(path, method = "GET", body) {
  if (method === "GET") return readMirror(path);
  const token = process.env.ATOMGIT_TOKEN?.trim();
  if (!token) throw new Error("ATOMGIT_TOKEN is required to prepare the mirror before downloading artifacts");
  const response = await fetch(`https://api.atomgit.com/api/v5/repos/TNTcraftHIM/Piik${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const reason = detail?.message ?? detail?.error_message ?? detail?.error;
    const message = typeof reason === "string" ? reason.replaceAll(token, "[redacted]").slice(0, 500) : "";
    throw new Error(`AtomGit preparation ${method} ${path}: HTTP ${response.status}${message ? `: ${message}` : ""}. Mirror publication remains incomplete.`);
  }
  return response.json();
}

export function mirrorReleaseBody(source) {
  const revision = source.target_commitish;
  return `${source.body ?? ""}\n\n此镜像分发 GitHub 的原始安装包；源码以 GitHub 为准。 / This mirror distributes the original GitHub packages; GitHub owns their source.\n\nSource: https://github.com/TNTcraftHIM/Piik/commit/${revision}\n\n<!-- piik-source: ${revision} -->\n`;
}

export async function prepareMirrorRelease(source, request = requestMirror, existing) {
  validateMirrorSource(source);
  const version = source.tag_name;
  let release = existing === undefined ? await request(`/releases/tags/${encodeURIComponent(version)}`) : existing;
  if (!release) {
    const repo = await request("");
    if (!repo || repo.private || !repo.default_branch) throw new Error("A public initialized AtomGit mirror is required");
    release = await request("/releases", "POST", {
      tag_name: version, name: source.name || `Piik ${version}`,
      body: mirrorReleaseBody(source),
      target_commitish: repo.default_branch, release_status: "pre",
    });
    if (release?.prerelease !== true) throw new Error("AtomGit did not confirm the prepared prerelease; mirror publication remains incomplete");
  }
  validateMirrorRelease(source, release);
  return release;
}

export async function prepareMirror(source, request = requestMirror) {
  const result = await mirrorReadiness(source, path => request(path));
  if (result.status !== "complete") await prepareMirrorRelease(source, request);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = JSON.parse(execFileSync("gh", ["api", "repos/TNTcraftHIM/Piik/releases/latest"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  }));
  const result = await prepareMirror(source);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    result.status === "complete" ? `Mirror ${result.version} is already stable with the complete published attachment inventory.\n`
      : `Mirror ${result.version} is prepared to resume from original CI artifacts; it remains incomplete until all packages pass verification.\n`);
  console.log(JSON.stringify(result));
}
