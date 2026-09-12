import { describe, expect, it, vi } from "vitest";
import {
  checkReleaseUpdate, DEFAULT_RELEASE_API_URL, MIRROR_RELEASE_API_URL,
  parseMirrorReleaseMetadata, parseReleaseMetadata, releaseUpdateNotice,
} from "../src/client/lib/release-update";
import mirrorReleases from "./fixtures/mirror-releases.json";

const currentRevision = "a".repeat(40);
const latestRevision = "b".repeat(40);
const release = {
  tag_name: "v1.2.0",
  target_commitish: latestRevision,
  html_url: "https://github.com/TNTcraftHIM/Piik/releases/tag/v1.2.0",
};

describe("App release update notice", () => {
  it("checks a release without sending installed identity or credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(DEFAULT_RELEASE_API_URL);
      expect(init?.credentials).toBe("omit");
      expect(JSON.stringify(init)).not.toContain(currentRevision);
      expect(JSON.stringify(init)).not.toContain("Authorization");
      return new Response(JSON.stringify(release), { status: 200 });
    });
    await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision }, { fetchImpl }))
      .resolves.toEqual({ version: "v1.2.0", revision: latestRevision,
        url: release.html_url, kind: "update-available" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["v1.1.0", currentRevision, latestRevision, "update-available"],
    ["v1.1.0", latestRevision, latestRevision, "update-available"],
    ["v1.2.0-rc.1", currentRevision, latestRevision, "update-available"],
    ["v1.2.0", currentRevision, latestRevision, "different-build"],
    ["v1.2.0", latestRevision, latestRevision, null],
    ["v1.2.0", currentRevision, null, null],
    ["v1.10.0", currentRevision, latestRevision, null],
    ["development", currentRevision, latestRevision, "official-release"],
    ["development", latestRevision, latestRevision, null],
    ["development", currentRevision, null, null],
  ])("compares %s by release precedence, using SHA only to identify builds", (version, revision, remoteRevision, expected) => {
    expect(releaseUpdateNotice({ version, revision }, {
      version: "v1.2.0", revision: remoteRevision, url: release.html_url,
    })?.kind ?? null).toBe(expected);
  });

  it("does not turn branch names, prereleases or malformed metadata into release identity", async () => {
    expect(parseReleaseMetadata({ ...release, target_commitish: "main" })?.revision).toBeNull();
    for (const changed of [
      { tag_name: "short" },
      { tag_name: "v1.2.0-rc.1" },
      { tag_name: "v1.2.0+other" },
      { html_url: "https://evil.example" },
      { html_url: "https://user@github.com/TNTcraftHIM/Piik/releases/tag/v1.2.0" },
      { draft: true },
      { prerelease: true },
    ]) expect(parseReleaseMetadata({ ...release, ...changed })).toBeNull();
    await expect(checkReleaseUpdate({ version: "development", revision: "development" })).resolves.toBeNull();
    await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision }, {
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("offline", { status: 503 })),
    })).resolves.toBeNull();
  });

  it("uses source provenance and stable precedence when GitHub is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === DEFAULT_RELEASE_API_URL) return new Response("offline", { status: 503 });
      expect(String(input)).toBe(`${MIRROR_RELEASE_API_URL}?per_page=100&page=1&direction=desc`);
      expect(init?.headers).toEqual({ Accept: "application/json" });
      expect(init?.credentials).toBe("omit");
      return Response.json(mirrorReleases);
    });
    const current = { version: "v1.9.0", revision: currentRevision };
    await expect(checkReleaseUpdate(current, { fetchImpl })).resolves.toEqual({
      kind: "update-available", version: "v1.10.0", revision: latestRevision,
      url: "https://gitee.com/TNTcraftHIM/Piik/releases/tag/v1.10.0",
    });
    await expect(checkReleaseUpdate({ ...current, version: "v2.0.0" }, { fetchImpl })).resolves.toBeNull();
  });

  it("gives the mirror its own deadline after a primary timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === DEFAULT_RELEASE_API_URL) {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
      }
      expect(init?.signal?.aborted).toBe(false);
      return Response.json(mirrorReleases);
    });
    await expect(checkReleaseUpdate({ version: "v1.0.0", revision: currentRevision }, { fetchImpl, timeoutMs: 10 }))
      .resolves.toMatchObject({ version: "v1.10.0" });
  });

  it("finishes mirror pagination and rejects an incomplete list", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === DEFAULT_RELEASE_API_URL) throw new Error("offline");
      return Response.json(new URL(String(input)).searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, () => mirrorReleases[0]) : [mirrorReleases[1]]);
    });
    const current = { version: "v1.9.0", revision: currentRevision };
    await expect(checkReleaseUpdate(current, { fetchImpl })).resolves.toMatchObject({ version: "v1.10.0" });
    fetchImpl.mockImplementation(async (input) => String(input) === DEFAULT_RELEASE_API_URL
      ? new Response(null, { status: 503 }) : Response.json(Array.from({ length: 100 }, () => mirrorReleases[1])));
    await expect(checkReleaseUpdate(current, { fetchImpl })).resolves.toBeNull();
  });

  it("does not query a mirror after a usable primary result, or accept ambiguous provenance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(release));
    await expect(checkReleaseUpdate({ version: "v1.2.0", revision: latestRevision }, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parseMirrorReleaseMetadata({ ...mirrorReleases[0], body: mirrorReleases[0].body.repeat(2) })).toBeNull();
    expect(parseMirrorReleaseMetadata({ ...mirrorReleases[0], prerelease: undefined })).toBeNull();
    expect(parseMirrorReleaseMetadata({ ...mirrorReleases[0], tag_name: "v1.0.0-beta.1" })).toBeNull();
  });
});
