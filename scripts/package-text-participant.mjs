import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { writeChannelWebLicenseNotices } from "./package-licenses.mjs";
import { buildVersion } from "./release-version.mjs";

const root = resolve(import.meta.dirname, "..");
const browser = "prototype/channel-browser";
const entry = `${browser}/node/index`;
const output = resolve(process.argv[2] ?? join(root, "build", "text-participant"));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run npm run package:text-participant");

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const revision = git("rev-parse", "HEAD");
const productVersion = buildVersion(root, revision);
const dirty = Boolean(git("status", "--porcelain"));
const version = productVersion === "development" ? `0.0.0-development.${revision}` : productVersion.slice(1);
const { devDependencies, engines, license } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dependencies = { ws: devDependencies.ws, zod: devDependencies.zod };
execFileSync(process.execPath, [join(root, browser, "build.mjs")], {
  cwd: root, stdio: "inherit", windowsHide: true,
  env: { ...process.env, PIIK_BUILD_VERSION: productVersion, PIIK_BUILD_REVISION: revision },
});
const staging = mkdtempSync(join(tmpdir(), "piik-text-participant-"));

try {
  await build({
    absWorkingDir: root,
    entryPoints: [`${entry}.ts`],
    outfile: join(staging, `${entry}.js`),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: Object.keys(dependencies),
  });
  const wasm = `${browser}/pkg/piik_channel_browser_bg.wasm`;
  mkdirSync(join(staging, browser, "pkg"), { recursive: true });
  copyFileSync(join(root, wasm), join(staging, wasm));

  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig", "--declaration", "--emitDeclarationOnly", "--target", "ES2023",
    "--module", "ESNext", "--moduleResolution", "bundler", "--strict", "--skipLibCheck",
    "--types", "node", "--rootDir", root, "--outDir", staging, `${entry}.ts`,
  ], { cwd: root, stdio: "inherit", windowsHide: true });
  // The repository uses bundler resolution. Native Node ESM consumers also
  // need file extensions on the generated declaration imports.
  for (const file of readdirSync(staging, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".d.ts")) continue;
    const path = join(file.parentPath, file.name);
    const declaration = readFileSync(path, "utf8").replace(
      /(?:\bfrom |\bimport\()(["'])(\.\.?\/[^"']+)\1/g,
      (specifier, quote, relative) => relative.endsWith(".js") ? specifier
        : specifier.replace(`${quote}${relative}${quote}`, `${quote}${relative}.js${quote}`),
    );
    writeFileSync(path, declaration);
  }

  copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  copyFileSync(join(root, browser, "node", "README.md"), join(staging, "README.md"));
  writeChannelWebLicenseNotices(root, join(staging, "THIRD-PARTY-NOTICES.txt"), Object.keys(dependencies));
  writeFileSync(join(staging, "package.json"), JSON.stringify({
    name: "piik-text-participant",
    version,
    description: "Internal Piik 3.0 beta text participant for Node.js",
    private: true,
    type: "module",
    license,
    engines,
    exports: { ".": { types: `./${entry}.d.ts`, import: `./${entry}.js` } },
    dependencies,
    piikBuild: { version: productVersion, revision, dirty },
  }, null, 2) + "\n");

  mkdirSync(output, { recursive: true });
  execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", output], {
    cwd: staging, stdio: "inherit", windowsHide: true,
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
