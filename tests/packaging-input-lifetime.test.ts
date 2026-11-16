import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";
import { assertBuildInputRetained } from "../scripts/build-workspace.mjs";

const source = vi.hoisted(() => ({ root: "", reset: vi.fn() }));
vi.mock("node:url", async original => {
  const url = await original<typeof import("node:url")>();
  return { ...url, fileURLToPath: (value: string | URL) => /\/(?:assemble-app|package-app-candidate|package-server-release)\.mjs$/.test(String(value))
    ? join(source.root, "scripts", basename(String(value))) : url.fileURLToPath(value) };
});
vi.mock("node:child_process", () => ({
  execFileSync: () => { throw new Error("No external command is needed to reject overlapping input"); },
  spawnSync: () => { throw new Error("Overlapping input must fail before builds or runtime checks"); },
}));
vi.mock("../scripts/build-workspace.mjs", async original => ({
  ...await original<typeof import("../scripts/build-workspace.mjs")>(),
  assertCleanRevision: () => "a".repeat(40),
  resetBuildWorkspace: () => { source.reset(); throw new Error("Input must be checked before resetting its owner"); },
}));
vi.mock("../scripts/release-version.mjs", () => ({ buildVersion: () => "development" }));
vi.mock("../scripts/package-licenses.mjs", () => ({
  writeAppLicenseNotices: () => undefined, writeServerLicenseNotices: () => undefined, writeChannelWebLicenseNotices: () => undefined,
}));

it.each(["assemble-app", "package-app-candidate", "package-server-release"])("%s rejects its own Web input before workspace reset", async entry => {
  const temporary = mkdtempSync(join(tmpdir(), "piik-retained-input-"));
  source.root = join(temporary, "source"); source.reset.mockClear();
  const web = join(source.root, "build", ...(entry === "package-server-release"
    ? ["server-package", "assembly", "runtime", "web"]
    : ["app-package", "linux-amd64", entry === "assemble-app" ? "assembly" : "candidate", "package", "web"]));
  mkdirSync(web, { recursive: true });
  writeFileSync(join(source.root, "LICENSE"), "Fixture license");
  writeFileSync(join(web, "index.html"), "retained input");
  const previousArguments = process.argv, originalProcess = process;
  vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
  const fetch = vi.fn(() => { throw new Error("No package dependency may be downloaded"); }); vi.stubGlobal("fetch", fetch);
  try {
    process.argv = [process.execPath, `${entry}.mjs`, ...(entry === "package-app-candidate" ? ["linux-amd64"] : []),
      join(temporary, "output"), ...(entry === "assemble-app" ? ["--target", "linux-amd64"] : []), "--web", web];
    vi.resetModules();
    await expect(import(`../scripts/${entry}.mjs`)).rejects.toThrow("Shared Web input overlaps a replaced build directory");
    expect(source.reset).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(web, "index.html"), "utf8")).toBe("retained input");
    expect(existsSync(join(temporary, "output"))).toBe(false);
  } finally { vi.unstubAllGlobals(); originalProcess.argv = previousArguments; rmSync(temporary, { recursive: true, force: true }); }
});

it("resolves aliases and missing output descendants without rejecting neighboring inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "piik-input-path-")), output = join(root, "assembly"), sibling = join(root, "assembly-web");
  mkdirSync(join(output, "runtime/web"), { recursive: true }); mkdirSync(sibling);
  symlinkSync(output, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  try {
    expect(() => assertBuildInputRetained(join(root, "alias/runtime/web"), output)).toThrow("overlaps");
    expect(() => assertBuildInputRetained(output, join(output, "missing/deeper"))).toThrow("overlaps");
    expect(() => assertBuildInputRetained(sibling, output)).not.toThrow();
    expect(() => assertBuildInputRetained(sibling, join(root, "new/output"))).not.toThrow();
    expect(existsSync(join(root, "new"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
