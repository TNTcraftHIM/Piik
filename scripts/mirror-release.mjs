import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readReleaseArtifacts } from "./release-artifacts.mjs";

const [directory, version, revision, option] = process.argv.slice(2);
if (option && option !== "--dry-run") {
  throw new Error("Use mirror-release.mjs <artifacts> <version> <full-SHA> [--dry-run]");
}
const { files } = readReleaseArtifacts(directory, version, revision);
const repository = "TNTcraftHIM/Piik";
const api = `https://api.atomgit.com/api/v5/repos/${repository}`;
const marker = `<!-- piik-source: ${revision} -->`;
const token = process.env.ATOMGIT_TOKEN?.trim();

function requireLatestSource() {
  const latest = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases/latest`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }));
  if (latest.tag_name !== version || latest.target_commitish !== revision ||
      latest.draft !== false || latest.prerelease !== false) {
    throw new Error("Only the latest GitHub release may create or complete an AtomGit mirror");
  }
}

async function fetchResponse(url, options, timeout, consume) {
  const attempts = (options.method ?? "GET") === "GET" ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await fetch(url, { ...options, signal });
      // Receiving headers is not a completed read. Keep JSON decoding and the
      // entire anonymous package/hash verification inside the same retry bound.
      if (attempt === attempts || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
        return await consume(response);
      }
    } catch (error) {
      if (attempt === attempts || !(signal.aborted || error instanceof TypeError || error?.name === "TimeoutError")) {
        throw new Error(`AtomGit ${options.method ?? "GET"} ${new URL(url).pathname}: ${error.message}`);
      }
    } finally {
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
    console.log(`Retry AtomGit read ${new URL(url).pathname}: ${attempt + 1}/${attempts}`);
    await delay(attempt * 1_000);
  }
}

async function request(path, method = "GET", body) {
  console.log(`AtomGit ${method} ${path}`);
  // A timed-out upload may already exist. Retry only reads; a script rerun
  // reconciles attachment identities before any subsequent write.
  return fetchResponse(api + path, {
    method, redirect: "error",
    headers: { Accept: "application/json", "PRIVATE-TOKEN": token,
      ...(!body ? {} : { "Content-Type": "application/json" }) },
    body: body ? JSON.stringify(body) : undefined,
  }, 20_000, async response => {
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

// Verify anonymously: credentials are never forwarded to attachment redirects.
async function verifyDownload(uploaded, file) {
  const expectedURL = `https://atomgit.com/${repository}/releases/download/${version}/${file.name}`;
  if (uploaded?.name !== file.name || uploaded.browser_download_url !== expectedURL) {
    throw new Error(`Mirror attachment metadata mismatch: ${file.name}`);
  }
  console.log(`Verify AtomGit package: ${file.name} (${file.size} bytes)`);
  await fetchResponse(expectedURL, {}, 180_000, async response => {
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
  });
}

if (option === "--dry-run") {
  console.log(JSON.stringify({ version, revision, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }));
} else {
  if (!token) throw new Error("ATOMGIT_TOKEN must be supplied by the publisher's environment");
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
  if (!release || release.prerelease) requireLatestSource();
  if (!release) {
    const repo = await request("");
    if (!repo || repo.private || !repo.default_branch) throw new Error("A public initialized AtomGit mirror is required");
    release = await request("/releases", "POST", {
      tag_name: version, name: source.name || `Piik ${version}`, body, release_status: "pre",
      target_commitish: revision,
    });
  }
  const attachments = release.assets;
  if (!Array.isArray(attachments)) throw new Error("Unexpected mirror attachment list");
  for (const file of files) {
    const matches = attachments.filter((asset) => asset.name === file.name);
    if (matches.length > 1) throw new Error("Duplicate mirror attachment: " + file.name);
    let uploaded = matches[0];
    if (!uploaded) {
      if (!release.prerelease) throw new Error("Published mirror is incomplete; publish a corrected new version");
      console.log("Upload AtomGit package: " + file.name + " (" + file.size + " bytes)");
      const upload = await request("/releases/" + version + "/upload_url?file_name=" + encodeURIComponent(file.name));
      if (!upload || typeof upload.url !== "string" || new URL(upload.url).protocol !== "https:" ||
          !upload.headers || typeof upload.headers !== "object") throw new Error("Invalid attachment upload response");
      // Signed locations and callback headers are credentials; never log them.
      let response;
      try {
        response = await fetch(upload.url, { method: "PUT", redirect: "error", headers: upload.headers,
          body: await openAsBlob(file.path), signal: AbortSignal.timeout(180_000) });
        if (!response.ok) throw new Error("HTTP " + response.status);
        await response.arrayBuffer();
      } catch (error) {
        const reason = response && !response.ok ? "HTTP " + response.status :
          error?.name === "TimeoutError" ? "timeout" : "network or response failure";
        throw new Error("AtomGit attachment upload failed: " + file.name + " (" + reason + "); rerun to inventory before retry");
      }
      release = await request("/releases/tags/" + version);
      uploaded = release?.assets?.find((asset) => asset.name === file.name);
    }
    await verifyDownload(uploaded, file);
  }
  // Keep incomplete attachment sets out of stable update checks.
  if (release.prerelease) {
    // Uploads may take minutes; a newer GitHub release must not be displaced.
    requireLatestSource();
    const completed = await request(`/releases/${version}`, "PATCH", {
      tag_name: version, name: source.name || `Piik ${version}`, body, release_status: "latest",
    });
    if (completed.prerelease !== false || completed.tag_name !== version) {
      throw new Error("AtomGit did not confirm the completed stable mirror");
    }
  }
  console.log(`Verified AtomGit mirror ${version} from ${revision} (${files.length} attachments).`);
}
