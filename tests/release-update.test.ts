import { describe, expect, it, vi } from "vitest";

import {
  checkReleaseUpdate,
  DEFAULT_RELEASE_API_URL,
  parseReleaseMetadata,
} from "../src/client/lib/release-update";

// The operator checker (cmd/screener-server --check-release, covered by
// cmd/screener-server/release_test.go) shares this release contract while
// keeping its runtime boundary independent.

const currentRevision = "a".repeat(40);
const latestRevision = "b".repeat(40);
const release = {
  tag_name: latestRevision,
  html_url: `https://github.com/TNTcraftHIM/Screener/releases/tag/${latestRevision}`,
};

describe("Client release update notice", () => {
  it("compares a strict release identity without sending the current revision", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(DEFAULT_RELEASE_API_URL);
      expect(init?.credentials).toBe("omit");
      expect(JSON.stringify(init)).not.toContain(currentRevision);
      expect(JSON.stringify(init)).not.toContain("Authorization");
      return new Response(JSON.stringify(release), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      checkReleaseUpdate(currentRevision, { fetchImpl }),
    ).resolves.toEqual({
      revision: latestRevision,
      url: release.html_url,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unavailable, malformed, and current releases", async () => {
    expect(parseReleaseMetadata({ ...release, tag_name: "short" })).toBeNull();
    expect(parseReleaseMetadata({ ...release, html_url: "https://evil.example" })).toBeNull();
    expect(
      parseReleaseMetadata({
        ...release,
        html_url: `https://user@github.com/TNTcraftHIM/Screener/releases/tag/${latestRevision}`,
      }),
    ).toBeNull();
    expect(parseReleaseMetadata({ ...release, draft: true })).toBeNull();
    await expect(checkReleaseUpdate("development")).resolves.toBeNull();
    await expect(
      checkReleaseUpdate(latestRevision, {
        fetchImpl: vi.fn<typeof fetch>(async () =>
          new Response(JSON.stringify(release), { status: 200 }),
        ),
      }),
    ).resolves.toBeNull();
    await expect(
      checkReleaseUpdate(currentRevision, {
        fetchImpl: vi.fn<typeof fetch>(async () =>
          new Response("offline", { status: 503 }),
        ),
      }),
    ).resolves.toBeNull();
  });
});
