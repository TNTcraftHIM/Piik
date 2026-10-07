import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMirrorSource } from "../scripts/release-mirror-source.mjs";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: command }));

const repository = "TNTcraftHIM/Piik";
const revision = "a".repeat(40);
const run = {
  id: 12345, repository: { full_name: repository }, head_repository: { full_name: repository },
  event: "push", head_branch: "main", head_sha: revision,
  path: ".github/workflows/repository-hygiene.yml", status: "completed", conclusion: "success",
};
const release = { tag_name: "v1.9.2", target_commitish: revision, draft: false, prerelease: false };

function api(source = run, latest = release) {
  command.mockImplementation((program: string, args: string[]) => {
    expect(program).toBe("gh");
    if (args[1] === `repos/${repository}/actions/runs/12345`) return JSON.stringify(source);
    if (args[1] === `repos/${repository}/releases/latest`) return JSON.stringify(latest);
    throw new Error(`Unexpected request: ${args.join(" ")}`);
  });
}

beforeEach(() => { command.mockReset(); api(); });

describe("mirror source authority", () => {
  it("binds automatic and manual retries to the published source run", () => {
    const expected = { run_id: "12345", version: release.tag_name, revision };
    expect(resolveMirrorSource("12345", true)).toEqual(expected);
    expect(resolveMirrorSource("12345")).toEqual(expected);
    api({ ...run, conclusion: "failure" });
    expect(resolveMirrorSource("12345")).toEqual(expected);
    expect(() => resolveMirrorSource("12345", true)).toThrow(/completed main push/);
  });

  it.each(["", "012345", "1e3", "-1", "12345\nmirror=true", "9007199254740992", undefined])
    ("rejects invalid run IDs before accessing GitHub: %s", (id) => {
      expect(() => resolveMirrorSource(id)).toThrow(/numeric ID/);
      expect(command).not.toHaveBeenCalled();
    });

  it.each([
    { id: 99 }, { repository: { full_name: "fork/Piik" } },
    { head_repository: { full_name: "fork/Piik" } }, { event: "pull_request" },
    { event: "workflow_dispatch" }, { head_branch: "preview" },
    { path: ".github/workflows/other.yml" }, { status: "in_progress" }, { head_sha: "short" },
  ])("rejects artifacts from a different authority or unfinished run: %j", (patch) => {
    api({ ...run, ...patch });
    expect(() => resolveMirrorSource("12345")).toThrow(/completed main push/);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("skips automatic runs without a current release and refuses an explicit stale retry", () => {
    api(run, { ...release, target_commitish: "b".repeat(40) });
    expect(resolveMirrorSource("12345", true)).toBeNull();
    expect(() => resolveMirrorSource("12345")).toThrow(/does not match the latest/);
  });

  it.each([{ draft: true }, { prerelease: true }, { tag_name: "preview" }, { target_commitish: "main" }])
    ("rejects an unverified release: %j", (patch) => {
      api(run, { ...release, ...patch });
      expect(() => resolveMirrorSource("12345")).toThrow(/published stable GitHub release/);
    });

  it("does not turn an API failure into an empty successful mirror", () => {
    command.mockImplementationOnce(() => { throw new Error("GitHub unavailable"); });
    expect(() => resolveMirrorSource("12345", true)).toThrow("GitHub unavailable");
  });
});
