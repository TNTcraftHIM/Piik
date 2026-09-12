import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readReleaseArtifacts } from "./release-artifacts.mjs";

const [directory, version, revision, option] = process.argv.slice(2);
if (option && option !== "--dry-run") {
  throw new Error("Use mirror-release.mjs <artifacts> <version> <full-SHA> [--dry-run]");
}
const { files } = readReleaseArtifacts(directory, version, revision);
if (files.some((file) => file.size > 100_000_000)) throw new Error("Gitee's 100 MB attachment limit is exceeded");
const repository = "TNTcraftHIM/Piik";
const api = `https://gitee.com/api/v5/repos/${repository}`;
const marker = `<!-- piik-source: ${revision} -->`;
const token = process.env.GITEE_TOKEN?.trim();

async function request(path, method = "GET", body) {
  const multipart = body instanceof FormData;
  const response = await fetch(api + path, {
    method, redirect: "error", signal: AbortSignal.timeout(multipart ? 180_000 : 20_000),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`,
      ...(!body || multipart ? {} : { "Content-Type": "application/json" }) },
    body: body ? multipart ? body : JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`Gitee ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

// Verify anonymously: credentials are never forwarded to attachment redirects.
async function verifyDownload(uploaded, file) {
  const expectedURL = `https://gitee.com/${repository}/releases/download/${version}/${file.name}`;
  if (uploaded?.size !== file.size || uploaded.browser_download_url !== expectedURL) {
    throw new Error(`Mirror attachment metadata mismatch: ${file.name}`);
  }
  const response = await fetch(expectedURL, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Mirror attachment is not anonymously downloadable: ${file.name}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > file.size) throw new Error(`Mirror attachment size mismatch: ${file.name}`);
    hash.update(chunk);
  }
  if (size !== file.size || hash.digest("hex") !== file.sha256) {
    throw new Error(`Mirror attachment checksum mismatch: ${file.name}`);
  }
}

if (option === "--dry-run") {
  console.log(JSON.stringify({ version, revision, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }));
} else {
  if (!token) throw new Error("GITEE_TOKEN must be supplied by the publisher's environment");
  const source = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases/tags/${version}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  if (source.draft !== false || source.prerelease !== false || source.tag_name !== version || source.target_commitish !== revision ||
      source.html_url !== `https://github.com/${repository}/releases/tag/${version}`) {
    throw new Error("Only an already-published matching GitHub stable release can be mirrored");
  }
  // Compare every byte identity with GitHub before creating or changing the mirror.
  for (const file of files) {
    const asset = source.assets.find((asset) => asset.name === file.name);
    if (asset?.state !== "uploaded" || asset.size !== file.size || asset.digest !== `sha256:${file.sha256}`) {
      throw new Error(`GitHub attachment checksum mismatch or unavailable: ${file.name}`);
    }
  }
  let release = await request(`/releases/tags/${version}`);
  if (release && (release.tag_name !== version ||
      (release.prerelease !== false && release.prerelease !== true) ||
      !release.body?.split(/\r?\n/).includes(marker))) {
    throw new Error("Existing mirror release belongs to a different or unknown source revision");
  }
  const body = `${source.body ?? ""}\n\nSource: https://github.com/${repository}/commit/${revision}\n\n${marker}\n`;
  if (!release) {
    const repo = await request("");
    if (!repo || repo.private || !repo.default_branch) throw new Error("A public initialized Gitee mirror is required");
    release = await request("/releases", "POST", {
      tag_name: version, name: source.name || `Piik ${version}`, body, prerelease: true,
      target_commitish: repo.default_branch,
    });
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error("Invalid Gitee release identity");
  const attachments = await request(`/releases/${release.id}/attach_files?per_page=100`);
  if (!Array.isArray(attachments) || attachments.length >= 100) throw new Error("Unexpected mirror attachment list");
  for (const file of files) {
    let uploaded = attachments.find((asset) => asset.name === file.name);
    if (!uploaded) {
      if (!release.prerelease) throw new Error("Published mirror is incomplete; publish a corrected new version");
      const form = new FormData();
      form.append("file", await openAsBlob(file.path), file.name);
      uploaded = await request(`/releases/${release.id}/attach_files`, "POST", form);
    }
    await verifyDownload(uploaded, file);
  }
  // Gitee has no draft API. Its preview flag fences incomplete uploads from checks.
  if (release.prerelease) {
    const completed = await request(`/releases/${release.id}`, "PATCH", {
      tag_name: version, name: source.name || `Piik ${version}`, body, prerelease: false,
    });
    if (completed.prerelease !== false || completed.tag_name !== version) {
      throw new Error("Gitee did not confirm the completed stable mirror");
    }
  }
  console.log(`Verified Gitee mirror ${version} from ${revision} (${files.length} attachments).`);
}
