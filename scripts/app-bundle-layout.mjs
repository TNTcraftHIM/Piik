import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The packager owns the exact tree; the executable is its only pending output.
export function collectAppBundleLayout(root, entrypoint, { pendingEntrypoint = false } = {}) {
  if (!entrypoint || entrypoint.includes("\\") ||
      entrypoint.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("App bundle entrypoint must be a relative package path");
  }
  const entries = [];
  function visit(path) {
    const absolute = path ? join(root, path) : root;
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`App bundle must not contain links: ${path || "."}`);
    if (metadata.isDirectory()) {
      if (path) entries.push({ path, kind: "directory" });
      for (const name of readdirSync(absolute)) {
        if (name.includes("\\")) throw new Error("App bundle paths must use forward slashes");
        visit(path ? `${path}/${name}` : name);
      }
    } else if (path && metadata.isFile()) {
      entries.push({ path, kind: "file" });
    } else {
      throw new Error(`App bundle contains an unsupported entry: ${path || "."}`);
    }
  }
  visit("");
  const executable = entries.find(entry => entry.path === entrypoint);
  if (pendingEntrypoint && !executable) {
    const parent = entrypoint.slice(0, entrypoint.lastIndexOf("/"));
    if (entrypoint.includes("/") && !entries.some(entry => entry.path === parent && entry.kind === "directory")) {
      throw new Error("App bundle entrypoint parent is missing");
    }
    entries.push({ path: entrypoint, kind: "file" });
  } else if (executable?.kind !== "file") {
    throw new Error("App bundle entrypoint must be a file");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { schema: 1, entrypoint, entries };
}

export function assertAppBundleLayout(root, layout) {
  const actual = collectAppBundleLayout(root, layout.entrypoint);
  if (JSON.stringify(actual) !== JSON.stringify(layout)) {
    throw new Error("App bundle entries changed after its layout was embedded");
  }
}
