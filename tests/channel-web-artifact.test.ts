import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { recordChannelWeb, verifyChannelWeb } from "../scripts/channel-web-artifact.mjs";
import { fileRecords } from "../scripts/package-files.mjs";
import { buildChannelWeb } from "../scripts/build-channel-web.mjs";

const build = vi.hoisted(() => ({ calls: [] as string[][], source: "clean" }));
vi.mock("../scripts/package-licenses.mjs", () => ({ writeChannelWebLicenseNotices: () => undefined }));
vi.mock("node:child_process", () => ({
  execFileSync: (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return "a".repeat(40);
    if (args[0] === "status") return build.source === "dirty" || build.source === "changed" && build.calls.length ? " M source.ts\n" : "";
    throw new Error("Unexpected Git command");
  },
  spawnSync: (_command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    expect(options.env).toMatchObject({
      PIIK_BUILD_VERSION: identity.version, PIIK_BUILD_REVISION: identity.revision,
      VITE_PIIK_REVISION: identity.revision,
    });
    build.calls.push(args);
    if (args.includes("build")) webFixture(join(options.cwd, "build/channel-web"), options.env.VITE_PIIK_REVISION!);
    return { status: 0 };
  },
}));

const identity = { version: "v3.0.0-beta.31", revision: "a".repeat(40) };
function webFixture(directory: string, revision = identity.revision) {
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "index.html"), '<script src="/assets/index-current.js"></script><link rel="modulepreload" href="/assets/shared.js"><link rel="stylesheet" href="/assets/theme.css"><link rel="icon" href="/favicon.svg">');
  writeFileSync(join(directory, "assets/index-current.js"), "export{};");
  writeFileSync(join(directory, "assets/shared.js"), 'const revision="' + revision + '"');
  writeFileSync(join(directory, "assets/theme.css"), "body{color:black}");
  writeFileSync(join(directory, "assets/runtime.wasm"), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(directory, "favicon.svg"), "<svg></svg>");
  writeFileSync(join(directory, "third-party-licenses.txt"), "Fixture notices");
  for (let index = 0; index < 40; index++) writeFileSync(join(directory, `assets/file-${index}.js.gz`), `compressed fixture ${index}`);
}

it.each(["exact", "version", "revision", "missing-file", "changed-bytes", "extra-file", "missing-linked", "no-receipt"] as const)(
  "requires the complete shared Web artifact (%s)", scenario => {
    const root = mkdtempSync(join(tmpdir(), "piik-shared-web-")), directory = join(root, "web");
    try {
      webFixture(directory); recordChannelWeb(directory, identity);
      const receipt = JSON.parse(readFileSync(`${directory}.build.json`, "utf8"));
      expect(receipt.files).toHaveLength(47);
      expect(receipt).not.toHaveProperty("schema");
      expect(readdirSync(directory)).not.toContain("build.json");
      if (scenario === "missing-file") rmSync(join(directory, "assets/file-39.js.gz"));
      if (scenario === "changed-bytes") writeFileSync(join(directory, "assets/file-39.js.gz"), "changed fixture");
      if (scenario === "extra-file") writeFileSync(join(directory, "extra.txt"), "extra");
      if (scenario === "no-receipt") rmSync(`${directory}.build.json`);
      if (scenario === "missing-linked") {
        rmSync(join(directory, "assets/theme.css"));
        writeFileSync(`${directory}.build.json`, JSON.stringify({ ...receipt, files: fileRecords(directory) }));
      }
      const expected = { ...identity, ...(scenario === "version" ? { version: "v3.0.0-beta.32" } : {}),
        ...(scenario === "revision" ? { revision: "b".repeat(40) } : {}) };
      const input = () => verifyChannelWeb(directory, expected);
      if (scenario === "exact") expect(input()).toBe(directory);
      else expect(input).toThrow(scenario === "version" || scenario === "revision" ? "identity mismatch"
        : scenario === "missing-linked" ? "linked asset is missing" : scenario === "no-receipt" ? "ENOENT" : "differs");
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);

it("records final compressed output after the ordinary builder completes", () => {
  const root = mkdtempSync(join(tmpdir(), "piik-built-web-"));
  build.calls = []; build.source = "clean";
  try {
    const output = buildChannelWeb(root, identity);
    expect(build.calls).toHaveLength(2);
    expect(build.calls[0][0]).toContain("channel-browser");
    expect(build.calls[1]).toContain("build");
    expect(verifyChannelWeb(output, identity)).toBe(output);
    const paths = JSON.parse(readFileSync(`${output}.build.json`, "utf8")).files.map((file: { path: string }) => file.path);
    expect(paths).toContain("assets/runtime.wasm.br");
    expect(paths).toContain("assets/shared.js.gz");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["dirty", "changed"])("keeps developer output but no reusable receipt when source is %s", scenario => {
  const root = mkdtempSync(join(tmpdir(), "piik-dirty-web-"));
  build.calls = []; build.source = scenario;
  try {
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build/channel-web.build.json"), "obsolete receipt");
    const output = buildChannelWeb(root, identity);
    expect(readFileSync(join(output, "index.html"), "utf8")).toContain("index-current.js");
    expect(() => verifyChannelWeb(output, identity)).toThrow("ENOENT");
  } finally { build.source = "clean"; rmSync(root, { recursive: true, force: true }); }
});

it("does not record a broken Web entry or borrow identity from an orphan script", () => {
  const root = mkdtempSync(join(tmpdir(), "piik-web-entry-"));
  try {
    webFixture(root, "b".repeat(40));
    writeFileSync(join(root, "assets/orphan.js"), identity.revision);
    expect(() => recordChannelWeb(root, identity)).toThrow("same source identity");
    writeFileSync(join(root, "assets/shared.js"), identity.revision);
    rmSync(join(root, "assets/shared.js"));
    expect(() => recordChannelWeb(root, identity)).toThrow("linked asset is missing");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.build.json`, { force: true }); }
});
