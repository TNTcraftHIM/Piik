import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMpdLicenseNotices } from "./package-licenses.mjs";

const args = process.argv.slice(2);
if (args.some((value) => value !== "--check") || args.length > 1)
  throw new Error("Usage: node scripts/build-mpd-resolver.mjs [--check]");
const check = args.includes("--check");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "prototype/channel-mpd/src/resolver.js");
const notice = join(root, "prototype/channel-mpd/THIRD-PARTY-NOTICES.txt");
const generated = await build({
  entryPoints: [join(root, "prototype/channel-mpd/resolver-entry.js")],
  bundle: true,
  platform: "neutral",
  mainFields: ["module", "main"],
  format: "iife",
  minify: true,
  outfile: output,
  write: false,
});
const temporary = await mkdtemp(join(tmpdir(), "piik-mpd-notices-"));
try {
  const temporaryNotice = join(temporary, "notices.txt");
  writeMpdLicenseNotices(root, temporaryNotice);
  for (const [path, bytes] of [
    [output, generated.outputFiles[0].contents],
    [notice, await readFile(temporaryNotice)],
  ]) {
    if (check) {
      if (!(await readFile(path)).equals(Buffer.from(bytes)))
        throw new Error(`Generated MPD artifact is stale: ${path}`);
    } else await writeFile(path, bytes);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
