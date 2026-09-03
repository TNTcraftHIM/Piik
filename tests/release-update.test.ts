import { describe, expect, it, vi } from "vitest";

import {
  checkReleaseUpdate,
  DEFAULT_RELEASE_API_URL,
  parseReleaseMetadata,
} from "../src/client/lib/release-update";

// The Node checker and the Browser checker deliberately share the same release
// contract while keeping their runtime boundaries independent.
// @ts-expect-error The executable helper has no generated TypeScript declaration.
import * as nodeRelease from "../scripts/release-update.mjs";

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

describe("operator release checker", () => {
  it("uses the same full-SHA release contract and status values", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => release,
    });
    await expect(
      nodeRelease.checkRelease({ currentRevision, fetchImpl }),
    ).resolves.toEqual({
      status: "update-available",
      currentRevision,
      latestRevision,
      releaseUrl: release.html_url,
    });
    await expect(
      nodeRelease.checkRelease({ currentRevision: latestRevision, fetchImpl }),
    ).resolves.toMatchObject({ status: "up-to-date" });
    expect(nodeRelease.UPDATE_EXIT_CODES).toEqual({
      upToDate: 0,
      available: 10,
      unavailable: 20,
    });
  });

  it("never forwards an operator token to a non-GitHub fixture endpoint", async () => {
    let receivedHeaders: Record<string, string> | undefined;
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      receivedHeaders = Object.fromEntries(new Headers(init?.headers));
      return { ok: true, json: async () => release };
    };
    await nodeRelease.checkRelease({
      currentRevision,
      apiURL: "http://127.0.0.1:8787/releases/latest",
      token: "fixture-secret",
      fetchImpl,
    });
    expect(receivedHeaders?.authorization).toBeUndefined();
  });
});
