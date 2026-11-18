const repository = "TNTcraftHIM/Piik";
export async function readMirror(path) {
  const response = await fetch(`https://api.atomgit.com/api/v5/repos/${repository}${path}`, {
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AtomGit readiness ${path}: HTTP ${response.status}`);
  return response.json();
}

export function validateMirrorSource(source) {
  if (source.draft !== false || source.prerelease !== false || typeof source.tag_name !== "string"
    || !/^[a-f0-9]{40}$/.test(source.target_commitish)) throw new Error("A published GitHub release with a full source SHA is required");
}

export function validateMirrorRelease(source, release) {
  if (!release || release.tag_name !== source.tag_name || ![true, false].includes(release.prerelease)
    || !release.body?.split(/\r?\n/).includes(`<!-- piik-source: ${source.target_commitish} -->`)) {
    throw new Error("Existing mirror release belongs to a different or unknown source revision");
  }
}

export async function mirrorReadiness(source, read = readMirror) {
  const version = source.tag_name, revision = source.target_commitish;
  validateMirrorSource(source);
  const updates = source.assets?.filter(asset => ["update.json", "update.json.sig"].includes(asset.name)) ?? [];
  if (updates.length && (updates.length !== 2 || new Set(updates.map(asset => asset.name)).size !== 2)) {
    throw new Error("Published update metadata is incomplete");
  }
  const mirror = await read(`/releases/tags/${encodeURIComponent(version)}`);
  if (mirror) {
    validateMirrorRelease(source, mirror);
    const packages = source.assets?.filter(asset => asset.name?.startsWith("piik-") || ["update.json", "update.json.sig"].includes(asset.name));
    const complete = packages?.length > 0 && Array.isArray(mirror.assets) && packages.every(asset => {
      const matches = mirror.assets.filter(candidate => candidate.type === "attach" && candidate.name === asset.name);
      const digest = matches[0]?.digest;
      return asset.state === "uploaded" && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
        && matches.length === 1 && matches[0].size === asset.size
        && (digest == null || (typeof digest === "string"
          && digest.toLowerCase().replace(/^sha256:/, "") === asset.digest.slice("sha256:".length)))
        && matches[0].browser_download_url === `https://atomgit.com/${repository}/releases/download/${version}/${asset.name}`;
    });
    if (!mirror.prerelease) {
      if (!complete) throw new Error("Published mirror is incomplete; it cannot be silently replaced");
      return { status: "complete", version, revision };
    }
  }
  return { status: "ready", version, revision };
}
