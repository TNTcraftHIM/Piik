import { describe, expect, it, vi } from "vitest";
import {
  checkReleaseUpdate, DEFAULT_RELEASE_API_URL, parseReleaseMetadata, releaseUpdateNotice,
} from "../src/client/lib/release-update";

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
});
